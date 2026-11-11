import { call } from "@orpc/server";
import { asc, eq, isNull } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { eventFires, events, runs } from "../db/schema.ts";
import { callPlatformTool } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { TriggerConfig } from "../triggers/model.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { Scheduler } from "./scheduler.ts";

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

/** Clients (primitive: Name, City), an agent with `data` on it, a scheduler on a clock the test moves. */
async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = (name: string) => call(router.agents.create, { name, harnessId: harness.id, systemPrompt: "", bundles: ["data"] }, { context });
  const clerk = await agent("Clerk");
  const clients = await call(router.tables.create, { name: "Clients" }, { context });
  const name = (await call(router.tables.get, { id: clients.id }, { context })).fields[0]!;
  const city = await call(router.fields.create, { tableId: clients.id, name: "City", type: "text" }, { context });
  await call(router.tables.setPrimitive, { id: clients.id, primitive: true }, { context });
  let now = new Date("2026-11-12T09:00:00Z");
  const time = { now: () => now, add: (ms: number) => (now = new Date(now.getTime() + ms)) };
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(context.db, engine, { now: time.now });
  const watch = (agentId: string, config: Partial<Extract<TriggerConfig, { kind: "primitive" }>> = {}, extra: { rateCap?: number } = {}) =>
    call(
      router.triggers.create,
      { agentId, name: "On change", instructions: "Look at the change.", ...extra, config: { kind: "primitive", tableId: clients.id, operations: ["updated"], ...config } },
      { context },
    );
  const create = (values: Record<string, string>) => call(router.rows.create, { tableId: clients.id, values }, { context });
  const update = (id: string, values: Record<string, string>) => call(router.rows.update, { id, values }, { context });
  const jobsOf = (triggerId: string) => context.db.select().from(runs).where(eq(runs.triggerId, triggerId)).orderBy(asc(runs.createdAt));
  const firesOf = (triggerId: string) => context.db.select().from(eventFires).where(eq(eventFires.triggerId, triggerId)).orderBy(asc(eventFires.createdAt));
  const unprocessed = () => context.db.select().from(events).where(isNull(events.processedAt));
  return { context, agent, clerk, clients, name, city, time, adapter, engine, scheduler, watch, create, update, jobsOf, firesOf, unprocessed };
}

test("editing a row fires a Job whose prompt holds the change, and the Job reads the row through its tools", async () => {
  const s = await setup();
  const trigger = await s.watch(s.clerk.id);
  const ada = await s.create({ [s.name.id]: "Ada" });
  // Only updates are watched: the creation is processed with no Job.
  expect(await s.scheduler.tick()).toEqual([]);
  await s.update(ada.id, { [s.city.id]: "Paris" });
  const [runId] = await s.scheduler.tick();
  expect(runId).toBeDefined();
  expect(await s.unprocessed()).toEqual([]);
  const prompt = s.adapter.starts[0]!.start.prompt;
  expect(prompt).toContain("Look at the change.");
  expect(prompt).toContain("- Operation: updated");
  expect(prompt).toContain(`- Row: ${ada.id}`);
  expect(prompt).toContain(`- Changed fields: ["${s.city.id}"]`);
  expect(prompt).toContain(`- Values before: {"${s.city.id}":null}`);
  expect(prompt).toContain(`- Values after: {"${s.city.id}":"Paris"}`);
  const [job] = await s.jobsOf(trigger.id);
  expect(job!.cause).toMatchObject({ kind: "event", depth: 0 });
  const read = await callPlatformTool(s.context, { runId: runId!, ownerId: s.context.ownerId, agentId: s.clerk.id }, "rows_get", { id: ada.id });
  expect(read).toMatchObject({ ok: true, output: { values: { [s.name.id]: "Ada", [s.city.id]: "Paris" } } });
  expect((await s.firesOf(trigger.id)).map((f) => [f.status, f.runId])).toEqual([["started", runId]]);
});

test("a trigger fires for its operations and, on an update, its fields only", async () => {
  const s = await setup();
  const trigger = await s.watch(s.clerk.id, { operations: ["updated", "deleted"], fields: [s.city.id] });
  const ada = await s.create({ [s.name.id]: "Ada" });
  await s.update(ada.id, { [s.name.id]: "Ada L." });
  expect(await s.scheduler.tick()).toEqual([]);
  await s.update(ada.id, { [s.city.id]: "London" });
  await call(router.rows.delete, { ids: [ada.id] }, { context: s.context });
  expect(await s.scheduler.tick()).toHaveLength(2);
  expect(await s.firesOf(trigger.id)).toHaveLength(2);
  expect(await s.unprocessed()).toEqual([]);
});

test("two schedulers claiming at once make each event's Job once", async () => {
  const s = await setup();
  const trigger = await s.watch(s.clerk.id);
  const ada = await s.create({ [s.name.id]: "Ada" });
  await s.update(ada.id, { [s.city.id]: "Paris" });
  const other = new Scheduler(s.context.db, s.engine, { now: s.time.now });
  const [a, b] = await Promise.all([s.scheduler.tick(), other.tick()]);
  expect([...a, ...b]).toHaveLength(1);
  expect(await s.jobsOf(trigger.id)).toHaveLength(1);
});

test("a Job's write never fires its own agent's trigger; another agent's is the next link of the chain", async () => {
  const s = await setup();
  const own = await s.watch(s.clerk.id);
  const auditor = await s.agent("Auditor");
  const theirs = await s.watch(auditor.id);
  const ada = await s.create({ [s.name.id]: "Ada" });
  await s.update(ada.id, { [s.city.id]: "Paris" });
  await s.scheduler.tick();
  const [first] = await s.jobsOf(own.id);
  const [seen] = await s.jobsOf(theirs.id);
  // The Clerk's Job writes the row: the Auditor's trigger fires, the Clerk's doesn't.
  await callPlatformTool(s.context, { runId: first!.id, ownerId: s.context.ownerId, agentId: s.clerk.id }, "rows_update", { id: ada.id, values: { [s.city.id]: "Rome" } });
  await s.scheduler.tick();
  expect((await s.firesOf(own.id)).map((f) => f.status)).toEqual(["started", "skipped-same-agent"]);
  const audits = await s.jobsOf(theirs.id);
  expect(audits).toHaveLength(2);
  expect(audits[1]!.cause).toMatchObject({ kind: "event", jobId: first!.id, rootJobId: first!.id, depth: 1 });
  expect(seen!.cause).toMatchObject({ depth: 0 });
});

test("a chain stops at depth 10 and at 100 Jobs: the event is processed, the fire says so, no Job", async () => {
  const s = await setup();
  const auditor = await s.agent("Auditor");
  const trigger = await s.watch(s.clerk.id);
  const auditorTrigger = await s.watch(auditor.id, { operations: ["created"] });
  const ada = await s.create({ [s.name.id]: "Ada" });
  await s.scheduler.tick();
  // A Job of the Auditor ten deep writes the row: the Clerk's Job would be the eleventh.
  const deep = await s.context.db.transaction((tx) =>
    s.engine.createJob(tx, { ownerId: s.context.ownerId, agentId: auditor.id, triggerId: auditorTrigger.id, cause: { kind: "event", eventId: "evt_x", depth: 10 }, firing: { type: "manual" } }),
  );
  await callPlatformTool(s.context, { runId: deep, ownerId: s.context.ownerId, agentId: auditor.id }, "rows_update", { id: ada.id, values: { [s.city.id]: "Paris" } });
  expect(await s.scheduler.tick()).toEqual([]);
  expect((await s.firesOf(trigger.id)).map((f) => [f.status, f.message])).toEqual([["chain-limit", "Chain limit reached"]]);
  // A chain already 100 Jobs long, from its root: one more is refused too.
  const root = await s.context.db.transaction((tx) =>
    s.engine.createJob(tx, { ownerId: s.context.ownerId, agentId: auditor.id, triggerId: auditorTrigger.id, cause: { kind: "event", eventId: "evt_y", depth: 0 }, firing: { type: "manual" } }),
  );
  let last = root;
  for (let i = 1; i < 100; i++) {
    last = await s.context.db.transaction((tx) =>
      s.engine.createJob(tx, { ownerId: s.context.ownerId, agentId: auditor.id, triggerId: auditorTrigger.id, cause: { kind: "event", eventId: "evt_y", rootJobId: root, depth: 1 }, firing: { type: "manual" } }),
    );
  }
  await callPlatformTool(s.context, { runId: last, ownerId: s.context.ownerId, agentId: auditor.id }, "rows_update", { id: ada.id, values: { [s.city.id]: "Rome" } });
  expect(await s.scheduler.tick()).toEqual([]);
  expect((await s.firesOf(trigger.id)).map((f) => f.status)).toEqual(["chain-limit", "chain-limit"]);
  expect(await s.jobsOf(trigger.id)).toEqual([]);
  expect(await s.unprocessed()).toEqual([]);
});

test("a trigger whose agent lost data on the table is skipped at dispatch, reported, and the event processed", async () => {
  const s = await setup();
  const trigger = await s.watch(s.clerk.id);
  await call(router.agents.update, { id: s.clerk.id, name: "Clerk", harnessId: s.clerk.harnessId, systemPrompt: "", bundles: [] }, { context: s.context });
  const ada = await s.create({ [s.name.id]: "Ada" });
  await s.update(ada.id, { [s.city.id]: "Paris" });
  expect(await s.scheduler.tick()).toEqual([]);
  expect((await s.firesOf(trigger.id)).map((f) => [f.status, f.message])).toEqual([["out-of-scope", "The agent may no longer read this table"]]);
  expect(await s.unprocessed()).toEqual([]);
  const view = await call(router.triggers.get, { id: trigger.id }, { context: s.context });
  expect(view.lastEvents).toMatchObject([{ status: "out-of-scope" }]);
});

test("a burst of 200 writes with the default cap: 60 Jobs in the hour, the rest deferred and run later, none lost", async () => {
  const s = await setup();
  const trigger = await s.watch(s.clerk.id, { operations: ["created"] });
  expect(trigger.rateCap).toBe(60);
  for (let i = 0; i < 200; i++) await s.create({ [s.name.id]: `Client ${i}` });
  await s.scheduler.tick();
  await s.scheduler.tick();
  expect(await s.unprocessed()).toEqual([]);
  expect(await s.jobsOf(trigger.id)).toHaveLength(60);
  expect((await s.firesOf(trigger.id)).filter((f) => f.status === "deferred")).toHaveLength(140);
  for (const expected of [120, 180, 200]) {
    s.time.add(3_600_001);
    await s.scheduler.tick();
    await s.scheduler.tick();
    expect(await s.jobsOf(trigger.id)).toHaveLength(expected);
  }
  expect((await s.firesOf(trigger.id)).every((f) => f.status === "started")).toBe(true);
}, 60_000);

test("a trigger's own cap", async () => {
  const s = await setup();
  const trigger = await s.watch(s.clerk.id, { operations: ["created"] }, { rateCap: 2 });
  for (let i = 0; i < 5; i++) await s.create({ [s.name.id]: `Client ${i}` });
  await s.scheduler.tick();
  expect(await s.jobsOf(trigger.id)).toHaveLength(2);
  const raised = await call(router.triggers.update, { id: trigger.id, rateCap: 10 }, { context: s.context });
  expect(raised.rateCap).toBe(10);
  await s.scheduler.tick();
  expect(await s.jobsOf(trigger.id)).toHaveLength(5);
});

test("a primitive trigger watches a primitive table of the owner's, its fields, and only what its agent may read", async () => {
  const s = await setup();
  const notes = await call(router.tables.create, { name: "Notes" }, { context: s.context });
  const make = (agentId: string, config: Record<string, unknown>) =>
    call(router.triggers.create, { agentId, name: "On change", instructions: "Look.", config: { kind: "primitive", tableId: s.clients.id, operations: ["updated"], ...config } as TriggerConfig }, { context: s.context });
  await expect(make(s.clerk.id, { tableId: notes.id })).rejects.toThrow("make the table primitive first");
  await expect(make(s.clerk.id, { tableId: "tbl_missing" })).rejects.toThrow("Table not found");
  await expect(make(s.clerk.id, { fields: ["fld_missing"] })).rejects.toThrow("A watched field isn't one of the table's");
  const blind = await call(router.agents.create, { name: "Blind", harnessId: s.clerk.harnessId, systemPrompt: "", bundles: ["data"], dataTables: [notes.id] }, { context: s.context });
  await expect(make(blind.id, {})).rejects.toThrow("The agent can't read this table");
  const trigger = await make(s.clerk.id, {});
  await expect(call(router.triggers.update, { id: trigger.id, config: { kind: "primitive", tableId: notes.id, operations: ["created"] } }, { context: s.context })).rejects.toThrow(
    "make the table primitive first",
  );
});

test("a deferred fire is decided by the trigger as it is when tried: one retargeted elsewhere doesn't get the old table's change", async () => {
  const s = await setup();
  const trigger = await s.watch(s.clerk.id, {}, { rateCap: 1 });
  const ada = await s.create({ [s.name.id]: "Ada" });
  await s.update(ada.id, { [s.city.id]: "Paris" });
  await s.update(ada.id, { [s.city.id]: "Rome" });
  await s.scheduler.tick();
  expect((await s.firesOf(trigger.id)).map((f) => f.status)).toEqual(["started", "deferred"]);
  const notes = await call(router.tables.create, { name: "Notes" }, { context: s.context });
  await call(router.tables.setPrimitive, { id: notes.id, primitive: true }, { context: s.context });
  await call(router.triggers.update, { id: trigger.id, config: { kind: "primitive", tableId: notes.id, operations: ["updated"] } }, { context: s.context });
  s.time.add(3_600_001);
  expect(await s.scheduler.tick()).toEqual([]);
  expect((await s.firesOf(trigger.id)).map((f) => [f.status, f.message])).toEqual([
    ["started", null],
    ["refused", "The trigger no longer watches this change"],
  ]);
});

test("deferred fires are retried trigger by trigger: one trigger's backlog doesn't hold up another's", async () => {
  const s = await setup();
  const auditor = await s.agent("Auditor");
  const a = await s.watch(s.clerk.id, { operations: ["created"] }, { rateCap: 1 });
  const b = await s.watch(auditor.id, { operations: ["created"] }, { rateCap: 1 });
  for (let i = 0; i < 3; i++) await s.create({ [s.name.id]: `Client ${i}` });
  await s.scheduler.tick();
  s.time.add(3_600_001);
  await s.scheduler.tick();
  expect(await s.jobsOf(a.id)).toHaveLength(2);
  expect(await s.jobsOf(b.id)).toHaveLength(2);
});

test("a trigger can be turned off once what it watches changed under it", async () => {
  const s = await setup();
  const trigger = await s.watch(s.clerk.id);
  await call(router.tables.setPrimitive, { id: s.clients.id, primitive: false }, { context: s.context });
  await expect(call(router.triggers.update, { id: trigger.id, name: "Renamed" }, { context: s.context })).rejects.toThrow("make the table primitive first");
  expect(await call(router.triggers.update, { id: trigger.id, enabled: false }, { context: s.context })).toMatchObject({ enabled: false });
});
