import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { rows as rowsTable, tables as tablesTable, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

/** Clients, and Matters with a reference to a client; one client and one matter that points at it. */
async function setup() {
  const context = await ownerContext();
  const clients = await call(router.tables.create, { name: "Clients" }, { context });
  const clientName = (await call(router.tables.get, { id: clients.id }, { context })).fields[0]!;
  const matters = await call(router.tables.create, { name: "Matters" }, { context });
  const client = await call(router.fields.create, { tableId: matters.id, name: "Client", type: "reference", referencesTableId: clients.id }, { context });
  const ada = await call(router.rows.create, { tableId: clients.id, values: { [clientName.id]: "Ada" } }, { context });
  const matter = await call(router.rows.create, { tableId: matters.id, values: { [client.id]: ada.id } }, { context });
  return { context, clients, clientName, matters, client, ada, matter };
}

test("a reference field names its table; its cell holds the id of one of that table's rows", async () => {
  const s = await setup();
  expect(s.client).toMatchObject({ type: "reference", referencesTableId: s.clients.id });
  expect(s.matter.values[s.client.id]).toBe(s.ada.id);
  // A row of another table, a row of nobody, and something that isn't an id: refused.
  const other = await call(router.rows.create, { tableId: s.matters.id }, { context: s.context });
  for (const value of [other.id, "row_missing", 42]) {
    await expect(call(router.rows.update, { id: s.matter.id, values: { [s.client.id]: value as never } }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  // Empty is allowed.
  expect((await call(router.rows.update, { id: s.matter.id, values: { [s.client.id]: null } }, { context: s.context })).values[s.client.id]).toBeNull();
});

test("a reference field can't point at a table that isn't the owner's, or at nothing", async () => {
  const s = await setup();
  await s.context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await s.context.db.insert(tablesTable).values({ id: "table_eve", ownerId: "user_other", name: "Eve's" } as never);
  for (const referencesTableId of ["table_eve", "table_missing", undefined]) {
    await expect(call(router.fields.create, { tableId: s.matters.id, name: `R ${referencesTableId}`, type: "reference", ...(referencesTableId ? { referencesTableId } : {}) }, { context: s.context })).rejects.toMatchObject({
      code: referencesTableId ? "NOT_FOUND" : "BAD_REQUEST",
    });
  }
  // Only a reference field names a table.
  await expect(call(router.fields.create, { tableId: s.matters.id, name: "Note", type: "text", referencesTableId: s.clients.id }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("deleting a row clears the references to it, in the same transaction", async () => {
  const s = await setup();
  await call(router.rows.delete, { ids: [s.ada.id] }, { context: s.context });
  expect((await call(router.rows.get, { id: s.matter.id }, { context: s.context })).values[s.client.id]).toBeNull();
});

test("a table another table's reference field points at can't be deleted", async () => {
  const s = await setup();
  await expect(call(router.tables.delete, { id: s.clients.id }, { context: s.context })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("Matters") });
  // Once the field goes, the table can.
  await call(router.fields.delete, { id: s.client.id }, { context: s.context });
  await call(router.tables.delete, { id: s.clients.id }, { context: s.context });
  expect(await s.context.db.select().from(rowsTable).where(undefined as never)).toHaveLength(1);
});

test("a listed row's references come with a label: the first field of the row they name", async () => {
  const s = await setup();
  const listed = await call(router.rows.list, { tableId: s.matters.id }, { context: s.context });
  expect(listed.references).toEqual({ [s.ada.id]: { label: "Ada", tableId: s.clients.id } });
  expect((await call(router.rows.get, { id: s.matter.id }, { context: s.context })).references).toEqual({ [s.ada.id]: { label: "Ada", tableId: s.clients.id } });
});

test("text becomes a reference when it is a row's id; a retype to a reference clears the cells", async () => {
  const { parseCellText, convertCells } = await import("./fields.ts");
  const field = { id: "f", name: "Client", type: "reference" as const, choices: [], referencesTableId: "table_c" };
  expect(parseCellText(field, " row_01ABC ")).toEqual({ ok: true, value: "row_01ABC" });
  expect(parseCellText(field, "Ada")).toMatchObject({ ok: false });
  expect(convertCells(["Ada"], { id: "f", name: "x", type: "text", choices: [] }, field, () => "c").cells).toEqual([null]);
});

test("a field retyped from a reference to text names no table any more", async () => {
  const s = await setup();
  await call(router.fields.retype, { id: s.client.id, type: "text", dryRun: false }, { context: s.context });
  // Its cells are text now: deleting the row they used to name changes nothing, and the table can go.
  await call(router.rows.delete, { ids: [s.ada.id] }, { context: s.context });
  expect((await call(router.rows.get, { id: s.matter.id }, { context: s.context })).values[s.client.id]).toBe(s.ada.id);
  await call(router.tables.delete, { id: s.clients.id }, { context: s.context });
  await expect(call(router.fields.retype, { id: s.client.id, type: "reference", dryRun: true }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
