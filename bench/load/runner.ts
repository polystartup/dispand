// A simulated runner: the real runner's connection (`apps/runner/src/connection.ts`: its send
// window, its per-session text holding and folding), with a fake CLI behind it that streams text at
// a measured model's pace. No CLI, no model.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "@dispand/runner/src/connection.ts";
import type { HarnessEvent, ServerToRunner } from "@dispand/runner-protocol";

/** How the fake CLI writes: `rate` text deltas a second of `chars` characters, `turnChars` in all per answer. */
export type Pace = { rate: number; chars: number; turnChars: number };

/** What a chat's watcher and the runner share: the deltas of the turn under way, each with its end offset and when the CLI made it. */
export type Turn = { emitted: [end: number, at: number][]; done: boolean };

export type RunnerHooks = {
  /** A chat's turn starts (`session.send`): where its deltas go, or undefined for a session no chat watches. */
  turn(sessionId: string): Turn | undefined;
  /** Each poll's call: the items it returns. */
  pollItems(): { id: string }[];
  /** Counted: deltas made, turns and Jobs ended. */
  count(name: string, n?: number): void;
};

/** The runner tool polls call, and its one read-only action. */
export const POLL_TOOL = "bench";
export const POLL_ACTION = "list_items";

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";

export class SimRunner {
  private readonly connection: Connection;
  private readonly live = new Set<string>();
  private turns = 0;

  private readonly pace: Pace;
  private readonly hooks: RunnerHooks;

  constructor(server: string, token: string, pace: Pace, hooks: RunnerHooks) {
    this.pace = pace;
    this.hooks = hooks;
    this.connection = new Connection({
      server,
      token,
      seqPath: join(mkdtempSync(join(tmpdir(), "dispand-bench-")), "seq.json"),
      hello: () => ({ type: "hello", runnerVersion: "0.0.0-bench", clis: { claude: "2.1.0" }, tools: [POLL_TOOL], liveSessions: [...this.live] }),
      onMessage: (msg) => this.receive(msg),
    });
    this.connection.start();
  }

  /** Events made and not acked yet: what the server is behind on this runner. */
  get unacked(): number {
    return this.connection.unackedCount;
  }

  close(): void {
    this.connection.close();
  }

  private receive(msg: Exclude<ServerToRunner, { type: "ack" }>) {
    switch (msg.type) {
      case "models.request":
        return this.connection.reply({ type: "models.replied", requestId: msg.requestId, models: [{ id: "sonnet", label: "Sonnet" }] });
      case "clis.request":
        return this.connection.reply({ type: "clis.replied", requestId: msg.requestId, clis: { claude: "2.1.0" } });
      case "tool.discover":
        return this.connection.reply({
          type: "tool.discovered",
          requestId: msg.requestId,
          actions: [{ name: POLL_ACTION, description: "Lists new items", inputSchema: { type: "object" }, readOnly: true }],
        });
      case "tool.call":
        return this.connection.reply({
          type: "tool.called",
          requestId: msg.requestId,
          content: [{ type: "text", text: JSON.stringify({ value: this.hooks.pollItems() }) }],
        });
      case "session.start": {
        const { start } = msg;
        this.live.add(start.sessionId);
        // As the real CLI: an interactive chat with no instructions waits for its first message.
        if (!start.prompt && start.interactive) return;
        return void this.answer(start.sessionId, !start.interactive);
      }
      case "session.send":
        return void this.answer(msg.sessionId, false);
      case "session.stop":
        this.live.delete(msg.sessionId);
        return;
      default:
        // Commands, plugins, permissions and subscriptions: nothing the load needs.
        return;
    }
  }

  /** One turn: text at the CLI's pace, then `turn-end` (a chat), or `result` (a Job, which ends it). */
  private async answer(sessionId: string, job: boolean) {
    const turn = job ? undefined : this.hooks.turn(sessionId);
    const turnId = `t${++this.turns}`;
    const emit = (event: HarnessEvent) => this.live.has(sessionId) && this.connection.emit(sessionId, event);
    if (!job) emit({ type: "turn-start", turnId, interruptible: true });
    const total = job ? this.pace.chars * 20 : this.pace.turnChars;
    const gap = 1000 / this.pace.rate;
    const begun = performance.now();
    for (let at = 0, i = 0; at < total && this.live.has(sessionId); i++) {
      // On a wall-clock schedule: a late timer sends the deltas that fell due meanwhile, one by one.
      const wait = begun + i * gap - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const delta = FILLER.repeat(Math.ceil(this.pace.chars / FILLER.length) + 1).slice(
        at % FILLER.length,
        (at % FILLER.length) + Math.min(this.pace.chars, total - at),
      );
      at += delta.length;
      turn?.emitted.push([at, performance.now()]);
      emit({ type: "text", delta });
      this.hooks.count("deltas");
    }
    if (job) {
      emit({ type: "result", text: "Done." });
      // A Job's session ends with its result: no stop comes.
      this.live.delete(sessionId);
      this.hooks.count("jobs");
    } else {
      emit({ type: "turn-end", turnId });
      this.hooks.count("turns");
      if (turn) turn.done = true;
    }
  }
}
