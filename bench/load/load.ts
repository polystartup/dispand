// The install and the people the load runs as: an owner and members of its one workspace, runners
// with a Claude Code harness each, chat agents, schedule and poll triggers; then each chat's loop
// and each person's open streams and page reads.
import { type Api, benchIp, client, type Person, signIn, type Timing } from "./api.ts";
import { type Pace, POLL_ACTION, POLL_TOOL, SimRunner, type Turn } from "./runner.ts";
import type { Recorder } from "./stats.ts";

export type Shape = {
  users: number;
  runners: number;
  schedules: number;
  polls: number;
  pace: Pace;
  /** Seconds a person waits after an answer before the next message. */
  think: number;
  /** Seconds between a person's page loads (each a few reads). */
  readEvery: number;
};

/** A turn, with how much of its answer the watcher has seen. */
export type Watched = Turn & { delivered: number; seen: number };

/** A chat and what its watcher saw of the turn under way. */
type Chat = { runId: string; turn?: Watched; messageId?: string; oldIds: Set<string> };

/**
 * The answer's text now holds `length` characters: every delta that ends within it is delivered.
 * Returns how many characters this update added, and each newly delivered delta's latency.
 */
export function deliver(turn: Watched, length: number, now: number): { grew: number; latencies: number[] } {
  const grew = Math.max(0, length - turn.seen);
  turn.seen = Math.max(turn.seen, length);
  const latencies: number[] = [];
  while (turn.delivered < turn.emitted.length && turn.emitted[turn.delivered]![0] <= length) {
    latencies.push(now - turn.emitted[turn.delivered]![1]);
    turn.delivered++;
  }
  return { grew, latencies };
}

type Member = { person: Person; api: Api };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export class Load {
  readonly counts = new Map<string, number>();
  readonly runners: SimRunner[] = [];
  private readonly members: Member[] = [];
  private readonly chatTriggers: string[] = [];
  private readonly chats = new Map<string, Chat>();
  private readonly stop = new AbortController();
  private polled = 0;

  private readonly base: string;
  private readonly shape: Shape;
  private readonly rec: Recorder;

  constructor(base: string, shape: Shape, rec: Recorder) {
    this.base = base;
    this.shape = shape;
    this.rec = rec;
  }

  count(name: string, n = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + n);
  }

  get chatCount(): number {
    return this.chats.size;
  }

  private readonly timing: Timing = (procedure, ms, ok) => {
    if (procedure.endsWith("/stream")) return;
    this.rec.add(`rpc ${procedure}`, ms);
    this.rec.add("rpc", ms);
    if (!ok) this.count("rpc errors");
  };

  /** A fresh install: the owner (setup), members by invitation, then runners, harnesses, agents and triggers. */
  async setUp(setupCode: string): Promise<void> {
    const password = `bench-${crypto.randomUUID()}`;
    const owner: Person = { email: "owner@example.com", password, ip: benchIp(0) };
    await client(this.base, owner.ip).auth.setup({ name: "Owner", email: owner.email, password, setupCode, organizationName: "Bench", workspaceName: "Load" });
    const api = client(this.base, owner.ip, await signIn(this.base, owner), this.timing);
    this.members.push({ person: owner, api });
    const [scope] = await api.workspace.managed();
    for (let n = 1; n < this.shape.users; n++) {
      const person: Person = { email: `member${n}@example.com`, password, ip: benchIp(n) };
      const { token } = await api.workspace.invite({
        organizationId: scope!.organizationId,
        workspaceId: scope!.workspaceId,
        email: person.email,
        role: "member",
      });
      await client(this.base, person.ip).workspace.registerInvitation({ token, email: person.email, name: `Member ${n}`, password });
      this.members.push({ person, api: client(this.base, person.ip, await signIn(this.base, person), this.timing) });
    }

    const hooks = {
      turn: (sessionId: string) => this.chats.get(sessionId)?.turn,
      pollItems: () => {
        this.count("polls");
        return [{ id: `item-${++this.polled}` }];
      },
      count: (name: string, n?: number) => this.count(name, n),
    };
    const created: string[] = [];
    for (let r = 0; r < this.shape.runners; r++) {
      const { runnerId, pairingCode } = await api.runners.create({ name: `Runner ${r}` });
      const res = await fetch(`${this.base}/runner/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pairingCode }),
      });
      if (!res.ok) throw new Error(`pairing failed: HTTP ${res.status}`);
      const { token } = (await res.json()) as { token: string };
      this.runners.push(new SimRunner(this.base, token, this.shape.pace, hooks));
      created.push(runnerId);
    }
    // A harness needs its runner's CLIs, which its `hello` reports.
    for (let i = 0; ; i++) {
      const online = (await api.runners.list()).filter((runner) => runner.status === "online").length;
      if (online >= created.length) break;
      if (i > 120) throw new Error(`only ${online} of ${created.length} runners came online`);
      await sleep(500);
    }

    const agentOn = async (r: number, name: string, toolIds?: string[]) => {
      const harness = await api.harnesses.create({ name: `${name} harness`, runnerId: created[r]!, kind: "claude-code", permissionMode: "default" });
      await api.harnesses.setLimit({ id: harness.id, maxWorking: 100 });
      return (await api.agents.create({ name, harnessId: harness.id, systemPrompt: "", ...(toolIds ? { toolIds } : {}) })).id;
    };
    for (let r = 0; r < created.length; r++) {
      const agentId = await agentOn(r, `Chat ${r}`);
      this.chatTriggers.push((await api.triggers.create({ agentId, name: "Chat", instructions: "", config: { kind: "manual", placement: "chat" } })).id);
    }
    for (let s = 0; s < this.shape.schedules; s++) {
      const agentId = await agentOn(s % created.length, `Scheduled ${s}`);
      await api.triggers.create({
        agentId,
        name: "Every minute",
        instructions: "Write a short note.",
        config: { kind: "schedule", cron: "* * * * *", timezone: "UTC" },
      });
    }
    const tools = new Map<number, string>();
    for (let p = 0; p < this.shape.polls; p++) {
      const r = p % created.length;
      if (!tools.has(r)) tools.set(r, (await api.tools.create({ kind: "runner", name: `Items ${r}`, runnerId: created[r]!, runnerTool: POLL_TOOL })).id);
      const agentId = await agentOn(r, `Poller ${p}`, [tools.get(r)!]);
      await api.triggers.create({
        agentId,
        name: "New items",
        instructions: "Handle the new item.",
        config: { kind: "poll", toolId: tools.get(r)!, action: POLL_ACTION, itemsPath: "value", idPath: "id", interval: 60 },
      });
    }
    for (const member of this.members) void this.browse(member);
  }

  /** Starts chats up to `total`, round robin over the people and the runners, each with its loop. */
  async chatsUpTo(total: number): Promise<void> {
    while (this.chats.size < total) {
      const n = this.chats.size;
      const member = this.members[n % this.members.length]!;
      const { runId, chatSessionId } = await member.api.jobs.start({ triggerId: this.chatTriggers[n % this.chatTriggers.length]! });
      if (!chatSessionId) throw new Error("a chat started with no session: is its harness full?");
      const chat: Chat = { runId, oldIds: new Set() };
      this.chats.set(chatSessionId, chat);
      void this.watch(member.api, chat);
      void this.converse(member.api, chat);
    }
  }

  /** The chat's loop: a message, the whole answer seen on the stream, a pause, again. */
  private async converse(api: Api, chat: Chat) {
    const { signal } = this.stop;
    while (!signal.aborted) {
      if (chat.messageId) chat.oldIds.add(chat.messageId);
      chat.messageId = undefined;
      const turn = (chat.turn = { emitted: [], done: false, delivered: 0, seen: 0 });
      try {
        await api.runs.sendChat({ runId: chat.runId, text: "Tell me more." });
      } catch {
        await sleep(1000, signal);
        continue;
      }
      const begun = performance.now();
      while (!signal.aborted && !(turn.done && turn.delivered === turn.emitted.length)) {
        if (performance.now() - begun > 120_000) {
          this.count("turns stalled");
          break;
        }
        await sleep(100, signal);
      }
      await sleep(this.shape.think * 1000, signal);
    }
  }

  /** The chat's owner keeps its run open, as the chat page does: delivery latency per delta. */
  private async watch(api: Api, chat: Chat) {
    const { signal } = this.stop;
    while (!signal.aborted) {
      try {
        for await (const event of await api.runs.stream({ runId: chat.runId }, { signal })) {
          this.count(`events ${event.type}`);
          if (event.type === "message" && event.message.role === "assistant") this.seen(chat, event.message);
          else if (event.type === "snapshot") {
            const last = event.messages.findLast((m) => m.role === "assistant" && !chat.oldIds.has(m.id));
            if (last) this.seen(chat, last);
          }
        }
      } catch {
        if (!signal.aborted) this.count("stream errors");
      }
      await sleep(1000, signal);
    }
  }

  /** An assistant message of the chat, as the stream delivered it. */
  private seen(chat: Chat, message: { id: string; text: string }) {
    if (!chat.turn || chat.oldIds.has(message.id)) return;
    chat.messageId = message.id;
    const { grew, latencies } = deliver(chat.turn, message.text.length, performance.now());
    if (grew) this.rec.add("chars per update", grew);
    for (const ms of latencies) this.rec.add("delivery", ms);
  }

  /** A signed-in person's tab: the Inbox stream (the bell), and a page load every `readEvery` seconds. */
  private async browse({ api }: Member) {
    const { signal } = this.stop;
    void (async () => {
      while (!signal.aborted) {
        try {
          const counts = await api.questions.stream(undefined, { signal });
          while (!(await counts.next()).done) {
            this.count("events questions");
            await api.questions.list({ status: "pending" });
          }
        } catch {
          if (!signal.aborted) this.count("stream errors");
        }
        await sleep(1000, signal);
      }
    })();
    const pages = [
      () => Promise.all([api.pages.list(), api.questions.count(), api.workspace.managed()]),
      () => api.runs.list({ kind: "chat" }),
      () => Promise.all([api.questions.list({ status: "all" }), api.agents.list()]),
      () => api.runs.list({}),
      () => Promise.all([api.harnesses.list(), api.runners.list()]),
    ];
    const every = this.shape.readEvery * 1000;
    // Spread over the period, then on a wall-clock schedule: a slow answer doesn't delay the next load.
    let next = performance.now() + Math.random() * every;
    for (let i = 0; !signal.aborted; i++) {
      await sleep(next - performance.now(), signal);
      next += every;
      void pages[i % pages.length]!().catch(() => undefined);
    }
  }

  /** Events the runners made that the server hasn't acked yet. */
  backlog(): number {
    return this.runners.reduce((sum, runner) => sum + runner.unacked, 0);
  }

  close(): void {
    this.stop.abort();
    for (const runner of this.runners) runner.close();
  }
}
