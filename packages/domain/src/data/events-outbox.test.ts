import { call } from "@orpc/server";
import { asc } from "drizzle-orm";
import { expect, test } from "vitest";
import { events } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { callPlatformTool } from "../platform/call.ts";
import { writeRow } from "./rows.ts";

async function setup() {
  const context = await ownerContext();
  const clients = await call(router.tables.create, { name: "Clients" }, { context });
  const name = (await call(router.tables.get, { id: clients.id }, { context })).fields[0]!;
  const city = await call(router.fields.create, { tableId: clients.id, name: "City", type: "text" }, { context });
  await call(router.tables.setPrimitive, { id: clients.id, primitive: true }, { context });
  const log = () => context.db.select().from(events).orderBy(asc(events.createdAt), asc(events.id));
  return { context, clients, name, city, log };
}

test("each write of a primitive table's row is one event: what changed, before and after, and who", async () => {
  const s = await setup();
  const ada = await call(router.rows.create, { tableId: s.clients.id, values: { [s.name.id]: "Ada" } }, { context: s.context });
  await call(router.rows.update, { id: ada.id, values: { [s.city.id]: "Paris" } }, { context: s.context });
  // Nothing changed: no event.
  await call(router.rows.update, { id: ada.id, values: { [s.city.id]: "Paris" } }, { context: s.context });
  await call(router.rows.delete, { ids: [ada.id] }, { context: s.context });
  const log = await s.log();
  expect(log.map((e) => [e.operation, e.changedFieldIds, e.before, e.after])).toEqual([
    ["created", [s.name.id], {}, { [s.name.id]: "Ada" }],
    ["updated", [s.city.id], { [s.city.id]: null }, { [s.city.id]: "Paris" }],
    ["deleted", [s.name.id, s.city.id], { [s.name.id]: "Ada", [s.city.id]: "Paris" }, {}],
  ]);
  for (const e of log) expect(e).toMatchObject({ ownerId: s.context.ownerId, tableId: s.clients.id, rowId: ada.id, actor: { type: "user", userId: s.context.ownerId }, processedAt: null });
});

test("a table that isn't primitive makes no event", async () => {
  const s = await setup();
  const other = await call(router.tables.create, { name: "Notes" }, { context: s.context });
  await call(router.rows.create, { tableId: other.id }, { context: s.context });
  expect(await s.log()).toEqual([]);
});

test("a write that rolls back leaves no event", async () => {
  const s = await setup();
  await s.context.db
    .transaction(async (tx) => {
      await writeRow(tx, { ownerId: s.context.ownerId, tableId: s.clients.id, values: { [s.name.id]: "Ghost" }, actor: { type: "user", userId: s.context.ownerId } });
      throw new Error("rolled back");
    })
    .catch(() => {});
  expect(await s.log()).toEqual([]);
});

test("a Job's write says which Job; clearing a reference to a deleted row is an event of its own, by the same actor", async () => {
  const s = await setup();
  const matters = await call(router.tables.create, { name: "Matters" }, { context: s.context });
  const client = await call(router.fields.create, { tableId: matters.id, name: "Client", type: "reference", referencesTableId: s.clients.id }, { context: s.context });
  await call(router.tables.setPrimitive, { id: matters.id, primitive: true }, { context: s.context });
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context: s.context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: s.context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", bundles: ["data"] }, { context: s.context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: s.context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: s.context });
  const job = { runId, ownerId: s.context.ownerId, agentId: agent.id };
  const made = await callPlatformTool(s.context, job, "rows_create", { tableId: s.clients.id, values: { [s.name.id]: "Bob" } });
  const bob = (made as { output: { id: string } }).output.id;
  const matter = await call(router.rows.create, { tableId: matters.id, values: { [client.id]: bob } }, { context: s.context });
  await callPlatformTool(s.context, job, "rows_delete", { ids: [bob] });
  const log = await s.log();
  expect(log.filter((e) => e.rowId === bob).map((e) => [e.operation, e.actor])).toEqual([
    ["created", { type: "job", runId }],
    ["deleted", { type: "job", runId }],
  ]);
  expect(log.filter((e) => e.rowId === matter.id).map((e) => [e.operation, e.changedFieldIds, e.actor])).toEqual([
    ["created", [client.id], { type: "user", userId: s.context.ownerId }],
    ["updated", [client.id], { type: "job", runId }],
  ]);
});
