import { call } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { pollItems, polls, runs, tools, triggers } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { InstalledTools } from "../tools/executor.ts";
import { pollCaller, type PollCaller } from "../tools/poll.ts";
import { startFakeMcp } from "../tools/test-server.ts";
import type { TriggerConfig } from "../triggers/model.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { MAX_WALK_PAGES, Scheduler, SCHEDULER_TICK_MS } from "./scheduler.ts";

class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    return true;
  }
  async send() {
    return true;
  }
  async answer() {
    return true;
  }
  async stop() {
    return true;
  }
}

type Mail = { id: string; subject: string; receivedDateTime?: string };
const MINUTE = 60_000;

/**
 * A fake MCP server whose read-only `list_mail` returns the mailbox (`{ value: [...] }`, as
 * Microsoft Graph does) and records each call's arguments, a `send` that isn't read-only, an
 * agent holding the tool, and schedulers on a clock the test moves.
 */
async function setup() {
  const mailbox: Mail[] = [];
  const calls: Record<string, unknown>[] = [];
  // `list_paged` pages as Graph does: `filter: receivedDateTime ge <time>`, oldest first, `top` a
  // page, the next named in `@odata.nextLink` by its `$skiptoken`. `forever`: a next link on every
  // page; `failAt`: that token's page reports an error; `during`: run before each page.
  const paging: { forever?: boolean; failAt?: string; hasMore?: boolean; during?: (token: string | undefined) => void } = {};
  const server = await startFakeMcp([
    {
      name: "list_mail",
      annotations: { readOnlyHint: true },
      call: (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: JSON.stringify({ value: mailbox }) }] };
      },
    },
    {
      name: "list_paged",
      annotations: { readOnlyHint: true },
      call: (args) => {
        calls.push(args);
        const token = args.skiptoken as string | undefined;
        paging.during?.(token);
        if (token !== undefined && token === paging.failAt) return { content: [{ type: "text", text: "throttled" }], isError: true };
        const since = /^receivedDateTime ge (.+)$/.exec(String(args.filter ?? ""))?.[1] ?? "";
        const matching = mailbox.filter((m) => (m.receivedDateTime ?? "") >= since).sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
        const top = Number(args.top ?? 10);
        const offset = token === undefined ? 0 : Number(token.slice("tok-".length));
        const next = offset + top < matching.length || paging.forever ? `https://graph.example.com/v1.0/me/messages?$skiptoken=tok-${offset + top}` : undefined;
        const body = { value: matching.slice(offset, offset + top), ...(next ? { "@odata.nextLink": next } : {}) };
        return { content: [{ type: "text", text: JSON.stringify(body) }], ...(paging.hasMore ? { _meta: { result_has_more: true } } : {}) };
      },
    },
    { name: "send", call: () => ({ content: [{ type: "text", text: "sent" }] }) },
  ]);
  onTestFinished(() => server.close());
  let now = new Date("2026-11-12T09:00:00Z");
  const time = { now: () => now, add: (ms: number) => (now = new Date(now.getTime() + ms)) };
  const context = { ...(await ownerContext()), now: time.now };
  const tool = await call(router.tools.create, { name: "Mail", url: server.url, transport: "streamable-http", headers: {} }, { context });
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const clerk = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", toolIds: [tool.id] }, { context });
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  const runnerCalls: unknown[] = [];
  // A runner whose `mail` server answers like the fake one, refusing a call while one to the same tool is under way, as runners do.
  const calling = new Set<string>();
  const during: { call?: () => Promise<unknown>; hasMore?: boolean } = {};
  const hub: Pick<RunnerHub, "call"> = {
    call: async (_runnerId, msg) => {
      runnerCalls.push(msg);
      await during.call?.();
      if (calling.has(msg.tool)) return { type: "tool.called", requestId: msg.requestId, error: "busy" };
      calling.add(msg.tool);
      await new Promise((resolve) => setTimeout(resolve, 20));
      calling.delete(msg.tool);
      return { type: "tool.called", requestId: msg.requestId, content: [{ type: "text", text: JSON.stringify({ value: mailbox }) }], ...(during.hasMore ? { hasMore: true } : {}) };
    },
  };
  const caller = pollCaller(new InstalledTools(context.db, context.secrets, context.tools), hub);
  const scheduler = (polls: PollCaller = caller) => new Scheduler(context.db, engine, { now: time.now, polls });
  const watch = (config: Partial<Extract<TriggerConfig, { kind: "poll" }>> = {}, extra: { rateCap?: number } = {}) =>
    call(
      router.triggers.create,
      {
        agentId: clerk.id,
        name: "New mail",
        instructions: "Triage this mail.",
        ...extra,
        config: { kind: "poll", toolId: tool.id, action: "list_mail", arguments: { filter: "receivedDateTime gt {{lastPoll}}" }, itemsPath: "value", idPath: "id", interval: 300, ...config },
      },
      { context },
    );
  const itemsOf = (triggerId: string) => context.db.select().from(pollItems).where(eq(pollItems.triggerId, triggerId)).orderBy(asc(pollItems.firstSeen), asc(pollItems.itemId));
  const pollsOf = (triggerId: string) => context.db.select().from(polls).where(eq(polls.triggerId, triggerId)).orderBy(asc(polls.at));
  const jobsOf = (triggerId: string) => context.db.select().from(runs).where(eq(runs.triggerId, triggerId)).orderBy(asc(runs.createdAt));
  return { context, mailbox, paging, calls, tool, clerk, harness, adapter, engine, runnerCalls, during, caller, scheduler, watch, itemsOf, pollsOf, jobsOf, time };
}

test("the first poll records what exists and starts nothing; a new item starts one Job whose prompt holds it; one seen before starts none", async () => {
  const s = await setup();
  const scheduler = s.scheduler();
  const trigger = await s.watch();
  s.mailbox.push({ id: "m1", subject: "Hello" }, { id: "m2", subject: "Invoice" });
  const first = s.time.now();
  expect(await scheduler.tick()).toEqual([]);
  expect((await s.itemsOf(trigger.id)).map((i) => [i.itemId, i.status])).toEqual([
    ["m1", "baseline"],
    ["m2", "baseline"],
  ]);
  expect(await s.pollsOf(trigger.id)).toMatchObject([{ status: "baseline", found: 2, fresh: 2 }]);
  // Not due again before its interval.
  s.time.add(MINUTE);
  expect(await scheduler.tick()).toEqual([]);
  expect(s.calls).toHaveLength(1);

  s.time.add(4 * MINUTE);
  const second = s.time.now();
  s.mailbox.push({ id: "m3", subject: "Contract" });
  const [runId, ...rest] = await scheduler.tick();
  expect(runId).toBeDefined();
  expect(rest).toEqual([]);
  // `{{lastPoll}}`: when the newest recorded item was found, the baseline's poll.
  expect(s.calls[1]).toEqual({ filter: `receivedDateTime gt ${first.toISOString()}` });
  const prompt = s.adapter.starts[0]!.start.prompt;
  expect(prompt).toContain("Triage this mail.");
  expect(prompt).toContain("The item that started this Job (id m3):");
  expect(prompt).toContain(JSON.stringify({ id: "m3", subject: "Contract" }));
  expect(prompt).not.toContain("Invoice");
  const [job] = await s.jobsOf(trigger.id);
  expect(job!.cause).toEqual({ kind: "poll", triggerId: trigger.id, itemId: "m3", depth: 0 });
  expect((await s.itemsOf(trigger.id)).find((i) => i.itemId === "m3")).toMatchObject({ status: "started", runId });

  s.time.add(5 * MINUTE);
  expect(await scheduler.tick()).toEqual([]);
  expect(await s.jobsOf(trigger.id)).toHaveLength(1);
  // Moved to the poll that recorded m3; the poll that found nothing new doesn't move it.
  expect(s.calls[2]).toEqual({ filter: `receivedDateTime gt ${second.toISOString()}` });
  s.time.add(5 * MINUTE);
  await scheduler.tick();
  expect(s.calls[3]).toEqual({ filter: `receivedDateTime gt ${second.toISOString()}` });
  expect((await call(router.triggers.get, { id: trigger.id }, { context: s.context })).lastPolls[0]).toMatchObject({ status: "polled", found: 3, fresh: 0 });
});

test("a trigger is made only on a pollable action of a tool its agent has", async () => {
  const s = await setup();
  await expect(s.watch({ action: "send" })).rejects.toThrow("A poll may not read this action");
  const other = await call(router.agents.create, { name: "Other", harnessId: s.harness.id, systemPrompt: "" }, { context: s.context });
  await expect(
    call(
      router.triggers.create,
      { agentId: other.id, name: "x", instructions: "x", config: { kind: "poll", toolId: s.tool.id, action: "list_mail", idPath: "id" } },
      { context: s.context },
    ),
  ).rejects.toThrow("The agent doesn't have this tool");
});

test("a poll whose action an owner unticked, or an agent must now ask before using, is skipped and reported, and calls nothing", async () => {
  const s = await setup();
  const scheduler = s.scheduler();
  const trigger = await s.watch();
  await scheduler.tick();
  expect(s.calls).toHaveLength(1);

  await call(router.tools.setPollable, { id: s.tool.id, actions: [] }, { context: s.context });
  s.time.add(5 * MINUTE);
  expect(await scheduler.tick()).toEqual([]);
  expect(s.calls).toHaveLength(1);
  expect((await s.pollsOf(trigger.id)).at(-1)).toMatchObject({ status: "skipped", message: expect.stringContaining("A poll may not read this action") });

  await call(router.tools.setPollable, { id: s.tool.id, actions: ["list_mail"] }, { context: s.context });
  await call(router.agents.setToolAsk, { agentId: s.clerk.id, toolId: s.tool.id, action: "list_mail", ask: true }, { context: s.context });
  s.time.add(5 * MINUTE);
  s.mailbox.push({ id: "m1", subject: "Hello" });
  expect(await scheduler.tick()).toEqual([]);
  expect(s.calls).toHaveLength(1);
  const view = await call(router.triggers.get, { id: trigger.id }, { context: s.context });
  expect(view.lastPolls[0]).toMatchObject({ status: "skipped", message: expect.stringContaining("an agent must ask before using it") });
});

test("two schedulers due on one poll call it once", async () => {
  const s = await setup();
  const trigger = await s.watch();
  await Promise.all([s.scheduler().tick(), s.scheduler().tick()]);
  expect(s.calls).toHaveLength(1);
  s.time.add(5 * MINUTE);
  s.mailbox.push({ id: "m1", subject: "Hello" });
  const [a, b] = await Promise.all([s.scheduler().tick(), s.scheduler().tick()]);
  expect([...a, ...b]).toHaveLength(1);
  expect(s.calls).toHaveLength(2);
  expect(await s.jobsOf(trigger.id)).toHaveLength(1);
});

test("a crash between the call and the record calls again and starts no Job twice", async () => {
  const s = await setup();
  const trigger = await s.watch();
  await s.scheduler().tick();
  s.mailbox.push({ id: "m1", subject: "Hello" });
  s.time.add(5 * MINUTE);
  // The call is made, then the process stops before its items are recorded.
  const crashing: PollCaller = {
    call: async (...args) => {
      await s.caller.call(...args);
      throw new Error("process stopped");
    },
  };
  expect(await s.scheduler(crashing).tick()).toEqual([]);
  expect(s.calls).toHaveLength(2);
  expect(await s.itemsOf(trigger.id)).toEqual([]);
  // The next poll calls again and starts the item's Job once.
  s.time.add(5 * MINUTE);
  expect(await s.scheduler().tick()).toHaveLength(1);
  // Its record committed, a poll made again for the same time (its claim lost) starts nothing.
  await s.context.db.update(triggers).set({ nextFireAt: s.time.now() }).where(eq(triggers.id, trigger.id));
  expect(await s.scheduler().tick()).toEqual([]);
  expect(s.calls).toHaveLength(4);
  expect(await s.jobsOf(trigger.id)).toHaveLength(1);
});

test("three items with a cap of one start one Job; the two deferred start an hour apart, though the action no longer returns them", async () => {
  const s = await setup();
  const scheduler = s.scheduler();
  const trigger = await s.watch({}, { rateCap: 1 });
  await scheduler.tick();
  s.mailbox.push({ id: "m1", subject: "a" }, { id: "m2", subject: "b" }, { id: "m3", subject: "c" });
  s.time.add(5 * MINUTE);
  expect(await scheduler.tick()).toHaveLength(1);
  expect((await s.itemsOf(trigger.id)).map((i) => i.status).sort()).toEqual(["deferred", "deferred", "started"]);
  s.mailbox.length = 0;
  s.time.add(30 * MINUTE);
  expect(await scheduler.tick()).toEqual([]);
  s.time.add(31 * MINUTE);
  expect(await scheduler.tick()).toHaveLength(1);
  s.time.add(61 * MINUTE);
  expect(await scheduler.tick()).toHaveLength(1);
  expect((await s.itemsOf(trigger.id)).map((i) => i.status)).toEqual(["started", "started", "started"]);
  const prompts = s.adapter.starts.map((st) => st.start.prompt);
  for (const id of ["m1", "m2", "m3"]) expect(prompts.some((p) => p.includes(`(id ${id})`))).toBe(true);
});

test("a runner tool's poll goes through its runner (`hub.call`)", async () => {
  const s = await setup();
  await s.context.db.insert(tools).values({
    id: "tool_runner_mail",
    ownerId: s.context.ownerId,
    name: "Local mail",
    kind: "runner",
    runnerId: s.harness.runnerId,
    runnerTool: "mail",
    actions: [{ name: "list-mail-messages", description: "Lists.", inputSchema: { type: "object" }, readOnly: true }],
  });
  await call(router.agents.update, { id: s.clerk.id, name: "Clerk", harnessId: s.harness.id, systemPrompt: "", toolIds: ["tool_runner_mail"] }, { context: s.context });
  const trigger = await s.watch({ toolId: "tool_runner_mail", action: "list-mail-messages", arguments: { top: 10 } });
  // A second trigger on the same runner tool: its polls wait for the first's, never overlap.
  const other = await s.watch({ toolId: "tool_runner_mail", action: "list-mail-messages", arguments: { top: 5 } });
  const scheduler = s.scheduler();
  await scheduler.tick();
  s.mailbox.push({ id: "m1", subject: "Hello" });
  s.time.add(5 * MINUTE);
  expect(await scheduler.tick()).toHaveLength(2);
  expect(s.runnerCalls).toHaveLength(4);
  expect(s.runnerCalls).toContainEqual(expect.objectContaining({ type: "tool.call", tool: "mail", action: "list-mail-messages", arguments: { top: 10 } }));
  expect(s.calls).toEqual([]);
  expect((await s.itemsOf(trigger.id)).map((i) => [i.itemId, i.status])).toEqual([["m1", "started"]]);
  expect((await s.pollsOf(other.id)).map((p) => p.status)).toEqual(["baseline", "polled"]);
});

test("a result without the list fails the poll with a reason, and records nothing", async () => {
  const s = await setup();
  const trigger = await s.watch({ itemsPath: "items" });
  await s.scheduler().tick();
  expect(await s.pollsOf(trigger.id)).toMatchObject([{ status: "failed", message: "The result has no list at “items”" }]);
  // Still the baseline to come: the next poll that works records only.
  await call(router.triggers.update, { id: trigger.id, config: { ...(trigger.config as Extract<TriggerConfig, { kind: "poll" }>), itemsPath: "value" } }, { context: s.context });
  s.mailbox.push({ id: "m1", subject: "Hello" });
  expect(await s.scheduler().tick()).toEqual([]);
  expect((await s.itemsOf(trigger.id)).map((i) => i.status)).toEqual(["baseline"]);
});

test("an agent that loses the tool between dispatch and session start never gets the item", async () => {
  const s = await setup();
  await s.watch();
  await s.scheduler().tick();
  s.mailbox.push({ id: "m1", subject: "Secret" });
  s.time.add(5 * MINUTE);
  // The Job is made, but its session not started yet (as when its runner is offline).
  const [runId] = await s.scheduler().poll();
  await call(router.agents.update, { id: s.clerk.id, name: "Clerk", harnessId: s.harness.id, systemPrompt: "", toolIds: [] }, { context: s.context });
  await s.engine.continueRun(runId!);
  await vi.waitFor(async () => {
    const [run] = await s.context.db.select().from(runs).where(eq(runs.id, runId!));
    expect(run).toMatchObject({ status: "failed", error: "The agent may no longer read the tool's action that found this item" });
  });
  expect(s.adapter.starts).toEqual([]);
});

test("items waiting under a trigger's old source are refused when it reads something else, never told under the new one", async () => {
  const s = await setup();
  const scheduler = s.scheduler();
  const trigger = await s.watch({}, { rateCap: 1 });
  await scheduler.tick();
  s.mailbox.push({ id: "m1", subject: "a" }, { id: "m2", subject: "b" });
  s.time.add(5 * MINUTE);
  expect(await scheduler.tick()).toHaveLength(1);
  const config = trigger.config as Extract<TriggerConfig, { kind: "poll" }>;
  await call(router.triggers.update, { id: trigger.id, config: { ...config, arguments: { top: 1 } } }, { context: s.context });
  expect((await s.itemsOf(trigger.id)).find((i) => i.itemId === "m2")).toMatchObject({ status: "refused", message: "The trigger was changed: it reads something else now" });
  s.time.add(61 * MINUTE);
  await scheduler.tick();
  expect(await s.jobsOf(trigger.id)).toHaveLength(1);
});

test("a Job reading a poll trigger gets its polls without the ids of the items the tool read", async () => {
  const s = await setup();
  const trigger = await s.watch();
  await s.scheduler().tick();
  s.mailbox.push({ id: "Confidential subject", subject: "x" });
  s.time.add(5 * MINUTE);
  await s.scheduler().tick();
  const [run] = await s.jobsOf(trigger.id);
  expect((await call(router.triggers.get, { id: trigger.id }, { context: s.context })).lastPolls[0]!.items).toHaveLength(1);
  const asJob = { ...s.context, job: { runId: run!.id, ownerId: s.context.ownerId, agentId: s.clerk.id } };
  const seen = await call(router.triggers.get, { id: trigger.id }, { context: asJob });
  expect(seen.lastPolls[0]).toMatchObject({ status: "polled", fresh: 1, items: [] });
  expect(JSON.stringify(await call(router.triggers.list, { agentId: s.clerk.id }, { context: asJob }))).not.toContain("Confidential");
});

async function onRunner(s: Awaited<ReturnType<typeof setup>>) {
  await s.context.db.insert(tools).values({
    id: "tool_runner_mail",
    ownerId: s.context.ownerId,
    name: "Local mail",
    kind: "runner",
    runnerId: s.harness.runnerId,
    runnerTool: "mail",
    actions: [{ name: "list-mail-messages", description: "Lists.", inputSchema: { type: "object" }, readOnly: true }],
  });
  await call(router.agents.update, { id: s.clerk.id, name: "Clerk", harnessId: s.harness.id, systemPrompt: "", toolIds: ["tool_runner_mail"] }, { context: s.context });
}

test("a poll waiting for another of its runner's tool is checked again before its call: unticked meanwhile, it calls nothing", async () => {
  const s = await setup();
  await onRunner(s);
  const a = await s.watch({ toolId: "tool_runner_mail", action: "list-mail-messages", arguments: { top: 10 } });
  const b = await s.watch({ toolId: "tool_runner_mail", action: "list-mail-messages", arguments: { top: 5 } });
  // The owner unticks the action while the first poll's call is under way.
  s.during.call = () => call(router.tools.setPollable, { id: "tool_runner_mail", actions: [] }, { context: s.context });
  await s.scheduler().tick();
  expect(s.runnerCalls).toHaveLength(1);
  const statuses = [...(await s.pollsOf(a.id)), ...(await s.pollsOf(b.id))].map((p) => p.status).sort();
  expect(statuses).toEqual(["baseline", "skipped"]);
});

test("saving a poll trigger as it is, its arguments' keys in another order, keeps its waiting items", async () => {
  const s = await setup();
  const scheduler = s.scheduler();
  const trigger = await s.watch({ arguments: { top: 10, filter: "x" } }, { rateCap: 1 });
  await scheduler.tick();
  s.mailbox.push({ id: "m1", subject: "a" }, { id: "m2", subject: "b" });
  s.time.add(5 * MINUTE);
  await scheduler.tick();
  const config = trigger.config as Extract<TriggerConfig, { kind: "poll" }>;
  await call(router.triggers.update, { id: trigger.id, name: "Renamed", config: { ...config, arguments: { filter: "x", top: 10 } } }, { context: s.context });
  expect((await s.itemsOf(trigger.id)).map((i) => i.status).sort()).toEqual(["deferred", "started"]);
});

/** A poll of `list_paged` walking Graph's continuation, `top` items a page, made at 08:00. */
async function watchPaged(s: Awaited<ReturnType<typeof setup>>, top = 10, extra: Partial<Extract<TriggerConfig, { kind: "poll" }>> = {}) {
  const trigger = await s.watch({
    action: "list_paged",
    arguments: { filter: "receivedDateTime ge {{lastPoll}}", top },
    continuation: { path: "@odata.nextLink", query: "$skiptoken", argument: "skiptoken" },
    ...extra,
  });
  await s.context.db.update(triggers).set({ createdAt: new Date("2026-11-12T08:00:00Z") }).where(eq(triggers.id, trigger.id));
  return trigger;
}

const mails = (prefix: string, n: number, receivedDateTime: string): Mail[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i + 1).padStart(2, "0")}`, subject: "x", receivedDateTime }));

test("more mail with one timestamp than a page holds, then newer mail: every one recorded once, none missing, and the walk ends with the watermark moved", async () => {
  const s = await setup();
  const scheduler = s.scheduler();
  const trigger = await watchPaged(s);
  s.mailbox.push(...mails("old", 1, "2026-11-12T08:59:00.000Z"));
  await scheduler.tick();
  s.time.add(5 * MINUTE);
  const walkStart = s.time.now().toISOString();
  s.mailbox.push(...mails("tie", 25, "2026-11-12T09:02:00.000Z"));
  // Mail arriving during the walk at the walk's own start: the next walk repeats it, unrecorded twice.
  s.paging.during = (token) => {
    if (token === "tok-10") s.mailbox.push(...mails("edge", 2, walkStart));
  };
  expect(await scheduler.tick()).toHaveLength(27);
  s.paging.during = undefined;
  // One fixed query, the server's token on each later page, all in one tick.
  expect(s.calls.slice(1)).toEqual([
    { filter: "receivedDateTime ge 2026-11-12T09:00:00.000Z", top: 10 },
    { filter: "receivedDateTime ge 2026-11-12T09:00:00.000Z", top: 10, skiptoken: "tok-10" },
    { filter: "receivedDateTime ge 2026-11-12T09:00:00.000Z", top: 10, skiptoken: "tok-20" },
  ]);
  expect((await s.pollsOf(trigger.id)).at(-1)).toMatchObject({ status: "polled", found: 27, fresh: 27, message: null });
  expect((await s.context.db.select().from(triggers).where(eq(triggers.id, trigger.id)))[0]!.pollCursor).toBeNull();

  s.time.add(5 * MINUTE);
  s.mailbox.push(...mails("new", 3, "2026-11-12T09:07:00.000Z"));
  expect(await scheduler.tick()).toHaveLength(3);
  // The walk ended: `{{lastPoll}}` moved to its start; the boundary mail it returns again starts nothing.
  expect(s.calls.at(-1)).toEqual({ filter: `receivedDateTime ge ${walkStart}`, top: 10 });
  expect((await s.pollsOf(trigger.id)).at(-1)).toMatchObject({ status: "polled", found: 5, fresh: 3 });
  const ids = (await s.itemsOf(trigger.id)).map((i) => i.itemId).sort();
  expect(ids).toEqual(s.mailbox.map((m) => m.id).sort());
  expect(await s.jobsOf(trigger.id)).toHaveLength(30);
});

test("a first walk is a baseline across its pages; a page that fails keeps the walk, which goes on from its token with its own query", async () => {
  const s = await setup();
  const scheduler = s.scheduler();
  const trigger = await watchPaged(s);
  s.mailbox.push(...mails("old", 15, "2026-11-12T08:30:00.000Z"));
  expect(await scheduler.tick()).toEqual([]);
  expect(s.calls.map((c) => c.skiptoken)).toEqual([undefined, "tok-10"]);
  expect(new Set((await s.itemsOf(trigger.id)).map((i) => i.status))).toEqual(new Set(["baseline"]));
  expect(await s.itemsOf(trigger.id)).toHaveLength(15);

  s.time.add(5 * MINUTE);
  s.mailbox.push(...mails("new", 12, "2026-11-12T09:02:00.000Z"));
  s.paging.failAt = "tok-10";
  expect(await scheduler.tick()).toHaveLength(10);
  expect((await s.pollsOf(trigger.id)).at(-1)).toMatchObject({ status: "failed", found: 10, fresh: 10 });
  const [stored] = await s.context.db.select().from(triggers).where(eq(triggers.id, trigger.id));
  expect(stored!.pollCursor).toEqual({ lastPoll: "2026-11-12T09:00:00.000Z", startedAt: "2026-11-12T09:05:00.000Z", token: "tok-10" });

  s.paging.failAt = undefined;
  s.time.add(5 * MINUTE);
  expect(await scheduler.tick()).toHaveLength(2);
  expect(s.calls.at(-1)).toEqual({ filter: "receivedDateTime ge 2026-11-12T09:00:00.000Z", top: 10, skiptoken: "tok-10" });
  // Its items were first seen when the walk began.
  expect(new Set((await s.itemsOf(trigger.id)).filter((i) => i.itemId.startsWith("new")).map((i) => i.firstSeen.toISOString()))).toEqual(new Set(["2026-11-12T09:05:00.000Z"]));
  s.time.add(5 * MINUTE);
  await scheduler.tick();
  expect(s.calls.at(-1)).toEqual({ filter: "receivedDateTime ge 2026-11-12T09:05:00.000Z", top: 10 });
  // The server's token is never shown.
  for (const p of await s.pollsOf(trigger.id)) expect(p.message ?? "").not.toContain("tok-");
});

test("a server returning next links forever is read 20 pages a poll; the walk goes on at the next interval, and the trigger's polls say so", async () => {
  const s = await setup();
  const scheduler = s.scheduler();
  const trigger = await watchPaged(s, 1);
  s.mailbox.push(...mails("m", 1, "2026-11-12T08:30:00.000Z"));
  s.paging.forever = true;
  await scheduler.tick();
  expect(s.calls).toHaveLength(MAX_WALK_PAGES);
  const view = await call(router.triggers.get, { id: trigger.id }, { context: s.context });
  expect(view.lastPolls[0]).toMatchObject({ status: "baseline", message: "20 pages read: the rest at the next poll" });
  // Not at once: at the next interval, from where it stopped.
  s.time.add(SCHEDULER_TICK_MS);
  await scheduler.tick();
  expect(s.calls).toHaveLength(MAX_WALK_PAGES);
  s.time.add(5 * MINUTE);
  await scheduler.tick();
  expect(s.calls).toHaveLength(2 * MAX_WALK_PAGES);
  expect(s.calls[MAX_WALK_PAGES]).toMatchObject({ skiptoken: "tok-20" });
  // Renamed, the walk goes on; reading something else, it starts over.
  const config = trigger.config as Extract<TriggerConfig, { kind: "poll" }>;
  const cursorOf = async () => (await s.context.db.select().from(triggers).where(eq(triggers.id, trigger.id)))[0]!.pollCursor;
  await call(router.triggers.update, { id: trigger.id, name: "Renamed" }, { context: s.context });
  expect(await cursorOf()).toMatchObject({ token: "tok-40" });
  await call(router.triggers.update, { id: trigger.id, config: { ...config, arguments: { ...config.arguments, top: 2 } } }, { context: s.context });
  expect(await cursorOf()).toBeNull();
});

test("a result the server cut short at its own cap (`hasMore`) is polled again on the next tick, through a runner or over HTTP", async () => {
  const s = await setup();
  await onRunner(s);
  const scheduler = s.scheduler();
  const trigger = await s.watch({ toolId: "tool_runner_mail", action: "list-mail-messages", arguments: { top: 10 } });
  s.during.hasMore = true;
  await scheduler.tick();
  expect(s.runnerCalls).toHaveLength(1);
  s.during.hasMore = false;
  s.time.add(SCHEDULER_TICK_MS);
  await scheduler.tick();
  expect(s.runnerCalls).toHaveLength(2);
  // Not cut short: its interval again.
  s.time.add(SCHEDULER_TICK_MS);
  await scheduler.tick();
  expect(s.runnerCalls).toHaveLength(2);
  expect((await s.pollsOf(trigger.id)).map((p) => p.status)).toEqual(["baseline", "polled"]);

  await call(router.agents.update, { id: s.clerk.id, name: "Clerk", harnessId: s.harness.id, systemPrompt: "", toolIds: ["tool_runner_mail", s.tool.id] }, { context: s.context });
  const http = await s.watch({ action: "list_paged", arguments: { top: 10 } });
  s.paging.hasMore = true;
  await scheduler.tick();
  s.paging.hasMore = false;
  s.time.add(SCHEDULER_TICK_MS);
  await scheduler.tick();
  expect(await s.pollsOf(http.id)).toHaveLength(2);
});

test("a poll without a continuation reads one call's result, its next link left alone", async () => {
  const s = await setup();
  const scheduler = s.scheduler();
  const trigger = await s.watch({ action: "list_paged", arguments: { filter: "receivedDateTime ge {{lastPoll}}", top: 2 } });
  s.mailbox.push(...mails("m", 5, "2026-11-12T08:30:00.000Z"));
  await s.context.db.update(triggers).set({ createdAt: new Date("2026-11-12T08:00:00Z") }).where(eq(triggers.id, trigger.id));
  await scheduler.tick();
  expect(s.calls).toHaveLength(1);
  expect((await s.pollsOf(trigger.id))[0]).toMatchObject({ status: "baseline", found: 2 });
  expect((await call(router.triggers.get, { id: trigger.id }, { context: s.context })).config).not.toHaveProperty("continuation");
  s.time.add(SCHEDULER_TICK_MS);
  await scheduler.tick();
  expect(s.calls).toHaveLength(1);
});
