import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

async function setup() {
  const context = await ownerContext();
  const clients = await call(router.tables.create, { name: "Clients" }, { context });
  const name = (await call(router.tables.get, { id: clients.id }, { context })).fields[0]!;
  const matters = await call(router.tables.create, { name: "Matters" }, { context });
  const ada = await call(router.rows.create, { tableId: clients.id, values: { [name.id]: "Ada" } }, { context });
  return { context, clients, name, matters, ada };
}

test("a table becomes primitive, and with a parent gets the reference field that names it", async () => {
  const s = await setup();
  expect(await call(router.tables.get, { id: s.matters.id }, { context: s.context })).toMatchObject({ primitive: false, parent: null });
  const set = await call(router.tables.setPrimitive, { id: s.matters.id, primitive: true, parent: { tableId: s.clients.id, required: true } }, { context: s.context });
  const field = set.fields.find((f) => f.type === "reference")!;
  expect(field).toMatchObject({ name: "Clients", referencesTableId: s.clients.id });
  expect(set).toMatchObject({ primitive: true, parent: { tableId: s.clients.id, fieldId: field.id, required: true } });
  // An existing reference field to that table is the one used: none is added.
  const again = await call(router.tables.setPrimitive, { id: s.matters.id, primitive: true, parent: { tableId: s.clients.id, required: false } }, { context: s.context });
  expect(again.fields.filter((f) => f.type === "reference")).toHaveLength(1);
  expect(again.parent).toMatchObject({ fieldId: field.id, required: false });
  // Only a primitive table has a parent.
  await expect(call(router.tables.setPrimitive, { id: s.matters.id, primitive: false, parent: { tableId: s.clients.id, required: false } }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await call(router.tables.setPrimitive, { id: s.matters.id, primitive: false }, { context: s.context })).toMatchObject({ primitive: false, parent: null });
});

test("a required parent: every row names one, a parent with children can't be deleted, and the field stays", async () => {
  const s = await setup();
  const set = await call(router.tables.setPrimitive, { id: s.matters.id, primitive: true, parent: { tableId: s.clients.id, required: true } }, { context: s.context });
  const parent = set.parent!.fieldId;
  await expect(call(router.rows.create, { tableId: s.matters.id }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Clients") });
  const matter = await call(router.rows.create, { tableId: s.matters.id, values: { [parent]: s.ada.id } }, { context: s.context });
  await expect(call(router.rows.update, { id: matter.id, values: { [parent]: null } }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.rows.delete, { ids: [s.ada.id] }, { context: s.context })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("1 row of “Matters”") });
  await expect(call(router.fields.delete, { id: parent }, { context: s.context })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(call(router.fields.retype, { id: parent, type: "text", dryRun: true }, { context: s.context })).rejects.toMatchObject({ code: "CONFLICT" });
  // Rows can't be left without a parent by making it required later either.
  const loose = await call(router.tables.setPrimitive, { id: s.matters.id, primitive: true, parent: { tableId: s.clients.id, required: false } }, { context: s.context });
  await call(router.rows.create, { tableId: s.matters.id }, { context: s.context });
  await expect(call(router.tables.setPrimitive, { id: s.matters.id, primitive: true, parent: { tableId: s.clients.id, required: true } }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("1 row") });
  expect(loose.parent!.required).toBe(false);
});

test("a parent table must be another of the owner's tables", async () => {
  const s = await setup();
  for (const tableId of [s.matters.id, "table_missing"]) {
    await expect(call(router.tables.setPrimitive, { id: s.matters.id, primitive: true, parent: { tableId, required: false } }, { context: s.context })).rejects.toMatchObject({
      code: tableId === "table_missing" ? "NOT_FOUND" : "BAD_REQUEST",
    });
  }
});
