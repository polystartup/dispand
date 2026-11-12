import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { audit, events, runs } from "../db/schema.ts";
import { Engine } from "../engine/engine.ts";
import type { HarnessAdapter } from "../engine/harness.ts";
import { Scheduler } from "../engine/scheduler.ts";
import { callPlatformTool } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { writeRow } from "../data/rows.ts";

// `event.recorded`: one Audit row per event of a primitive table, written when the event is
// appended, naming it and never its values. Rows are matched by event id, not by their order.

const SENTINEL = "zz-sentinel-row-value";

const adapter: HarnessAdapter = { start: async () => true, send: async () => true, answer: async () => true, stop: async () => true };

/** Clients (primitive: Name, City), a Clerk with `data` and a manual trigger. */
async function setup() {
  const context = await ownerContext();
  const clients = await call(router.tables.create, { name: "Clients" }, { context });
  const name = (await call(router.tables.get, { id: clients.id }, { context })).fields[0]!;
  const city = await call(router.fields.create, { tableId: clients.id, name: "City", type: "text" }, { context });
  await call(router.tables.setPrimitive, { id: clients.id, primitive: true }, { context });
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const clerk = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", bundles: ["data"] }, { context });
  const recorded = () => context.db.select().from(audit).where(eq(audit.action, "event.recorded"));
  const eventsOf = () => context.db.select().from(events).where(eq(events.tableId, clients.id));
  return { context, clients, name, city, harness, clerk, recorded, eventsOf };
}

test("a person's create, update and delete each leave one event.recorded naming the event, with no value", async () => {
  const s = await setup();
  const ada = await call(router.rows.create, { tableId: s.clients.id, values: { [s.name.id]: SENTINEL } }, { context: s.context });
  await call(router.rows.update, { id: ada.id, values: { [s.city.id]: SENTINEL } }, { context: s.context });
  await call(router.rows.delete, { ids: [ada.id] }, { context: s.context });
  const evts = await s.eventsOf();
  const rows = await s.recorded();
  expect(rows).toHaveLength(3);
  const byEvent = new Map(rows.map((r) => [r.details.eventId, r]));
  expect(evts.map((e) => [e.operation, byEvent.get(e.id)?.details.fields]).sort()).toEqual([
    ["created", 1],
    ["deleted", 2],
    ["updated", 1],
  ]);
  for (const e of evts) {
    expect(byEvent.get(e.id)).toMatchObject({
      ownerId: s.context.ownerId,
      actor: { type: "user", userId: s.context.ownerId },
      actorAgentId: null,
      jobId: null,
      resourceType: "row",
      resourceId: ada.id,
      result: "ok",
      details: { tableId: s.clients.id, tableName: "Clients", eventId: e.id, operation: e.operation },
    });
  }
  expect(JSON.stringify(rows)).not.toContain(SENTINEL);
});

test("a table that isn't primitive, and a write rolled back, leave no row", async () => {
  const s = await setup();
  const notes = await call(router.tables.create, { name: "Notes" }, { context: s.context });
  await call(router.rows.create, { tableId: notes.id }, { context: s.context });
  await s.context.db
    .transaction(async (tx) => {
      await writeRow(tx, { ownerId: s.context.ownerId, tableId: s.clients.id, values: { [s.name.id]: "Ghost" }, actor: { type: "user", userId: s.context.ownerId } });
      throw new Error("rolled back");
    })
    .catch(() => {});
  expect(await s.recorded()).toEqual([]);
});

test("a Job's write leaves its platform.call row and an event.recorded by the Job, and the Job it fires names the same event", async () => {
  const s = await setup();
  const engine = new Engine(s.context.db, adapter);
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(s.context.db, engine, { now: () => new Date() });
  const manual = await call(router.triggers.create, { agentId: s.clerk.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: s.context });
  const auditor = await call(router.agents.create, { name: "Auditor", harnessId: s.harness.id, systemPrompt: "", bundles: ["data"] }, { context: s.context });
  const watch = await call(
    router.triggers.create,
    { agentId: auditor.id, name: "On change", instructions: "Look.", config: { kind: "primitive", tableId: s.clients.id, operations: ["created"] } },
    { context: s.context },
  );
  const { runId } = await call(router.jobs.start, { triggerId: manual.id }, { context: s.context });
  const made = await callPlatformTool(s.context, { runId, ownerId: s.context.ownerId, agentId: s.clerk.id }, "rows_create", { tableId: s.clients.id, values: { [s.name.id]: SENTINEL } });
  const rowId = (made as { output: { id: string } }).output.id;

  const mine = await s.context.db.select().from(audit).where(eq(audit.jobId, runId));
  expect(mine.filter((r) => r.action === "platform.call")).toMatchObject([{ resourceId: rowId, details: { tool: "rows_create", tableId: s.clients.id } }]);
  const [evt] = await s.eventsOf();
  expect(mine.filter((r) => r.action === "event.recorded")).toMatchObject([
    {
      actor: { type: "job", runId },
      actorAgentId: s.clerk.id,
      resourceType: "row",
      resourceId: rowId,
      details: { tableId: s.clients.id, eventId: evt!.id, operation: "created", fields: 1 },
    },
  ]);
  expect(JSON.stringify(mine)).not.toContain(SENTINEL);

  const [fired] = await scheduler.tick();
  expect(fired).toBeDefined();
  expect((await s.context.db.select().from(runs).where(eq(runs.triggerId, watch.id))).map((r) => r.id)).toEqual([fired]);
  const created = (await s.context.db.select().from(audit).where(eq(audit.jobId, fired!))).filter((r) => r.action === "job.created");
  expect(created).toMatchObject([{ details: { causeKind: "event", eventId: evt!.id } }]);
});
