import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { fields, rows, tables, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import type { Cell } from "./fields.ts";

type Ctx = Awaited<ReturnType<typeof ownerContext>>;

async function addRows(context: Ctx, tableId: string, values: Record<string, Cell>[]) {
  const ids = values.map((_, i) => `row_${tableId}_${i}`);
  await context.db.insert(rows).values(values.map((v, i) => ({ id: ids[i]!, ownerId: context.ownerId, tableId, values: v })));
  return ids;
}

async function valuesOf(context: Ctx, tableId: string) {
  const list = await context.db.select().from(rows).where(eq(rows.tableId, tableId)).orderBy(rows.id);
  return list.map((r) => r.values);
}

test("tables CRUD: create adds a Name field, rename, list counts rows, delete cascades fields and rows", async () => {
  const context = await ownerContext();
  const table = await call(router.tables.create, { name: " Projects " }, { context });
  expect(table).toMatchObject({ id: expect.stringMatching(/^tbl_/), name: "Projects" });
  expect(table.fields).toEqual([{ id: expect.any(String), tableId: table.id, name: "Name", type: "text", choices: [], position: 0 }]);
  const other = await call(router.tables.create, { name: "Archive" }, { context });
  await addRows(context, table.id, [{}, {}]);

  const renamed = await call(router.tables.rename, { id: table.id, name: "Products" }, { context });
  expect(renamed.name).toBe("Products");
  expect(await call(router.tables.get, { id: table.id }, { context })).toEqual(renamed);
  const list = await call(router.tables.list, undefined, { context });
  expect(list.map(({ name, rowCount }) => ({ name, rowCount }))).toEqual([
    { name: "Archive", rowCount: 0 },
    { name: "Products", rowCount: 2 },
  ]);

  await call(router.tables.delete, { id: table.id }, { context });
  expect((await call(router.tables.list, undefined, { context })).map((t) => t.id)).toEqual([other.id]);
  expect(await context.db.select().from(fields).where(eq(fields.tableId, table.id))).toEqual([]);
  expect(await context.db.select().from(rows).where(eq(rows.tableId, table.id))).toEqual([]);
  await expect(call(router.tables.get, { id: table.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("table and field names are unique case-insensitively", async () => {
  const context = await ownerContext();
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  await expect(call(router.tables.create, { name: "PROJECTS" }, { context })).rejects.toMatchObject({
    code: "CONFLICT",
    message: "A table is already called “PROJECTS”",
  });
  const other = await call(router.tables.create, { name: "Ideas" }, { context });
  await expect(call(router.tables.rename, { id: other.id, name: "projects" }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  // Renaming to its own name in another case is fine.
  await call(router.tables.rename, { id: table.id, name: "PROJECTS" }, { context });

  await expect(call(router.fields.create, { tableId: table.id, name: "name", type: "number" }, { context })).rejects.toMatchObject({
    code: "CONFLICT",
    message: "A field is already called “name”",
  });
  const price = await call(router.fields.create, { tableId: table.id, name: "Price", type: "number" }, { context });
  await expect(call(router.fields.update, { id: price.id, name: "NAME" }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  // The same field name in another table is fine.
  await call(router.fields.create, { tableId: other.id, name: "Price", type: "number" }, { context });
});

test("fields: create, rename, reorder, delete removes the key from every row", async () => {
  const context = await ownerContext();
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const name = table.fields[0]!;
  const url = await call(router.fields.create, { tableId: table.id, name: "Website", type: "url" }, { context });
  const status = await call(
    router.fields.create,
    { tableId: table.id, name: "Status", type: "single-select", choices: [{ id: "c_idea", label: "Idea" }] },
    { context },
  );
  expect(url).toMatchObject({ tableId: table.id, name: "Website", type: "url", choices: [], position: 1 });
  expect(status).toMatchObject({ position: 2, choices: [{ id: "c_idea", label: "Idea" }] });
  // Choices belong to single-select fields only.
  await expect(
    call(router.fields.create, { tableId: table.id, name: "Notes", type: "text", choices: [{ id: "c_x", label: "X" }] }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.fields.update, { id: url.id, choices: [{ id: "c_x", label: "X" }] }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });

  expect(await call(router.fields.update, { id: url.id, name: "Site" }, { context })).toMatchObject({ id: url.id, name: "Site" });
  const reordered = await call(router.fields.reorder, { tableId: table.id, fieldIds: [status.id, name.id, url.id] }, { context });
  expect(reordered.fields.map((f) => [f.id, f.position])).toEqual([
    [status.id, 0],
    [name.id, 1],
    [url.id, 2],
  ]);

  await addRows(context, table.id, [{ [name.id]: "A", [url.id]: "https://a.example" }, { [url.id]: null }, {}]);
  await call(router.fields.delete, { id: url.id }, { context });
  expect(await valuesOf(context, table.id)).toEqual([{ [name.id]: "A" }, {}, {}]);
  expect((await call(router.tables.get, { id: table.id }, { context })).fields.map((f) => [f.id, f.position])).toEqual([
    [status.id, 0],
    [name.id, 1],
  ]);
});

test("a table keeps at most 200 fields", async () => {
  const context = await ownerContext();
  const table = await call(router.tables.create, { name: "Wide" }, { context });
  await context.db.insert(fields).values(
    Array.from({ length: 199 }, (_, i) => ({ id: `fld_${i}`, ownerId: context.ownerId, tableId: table.id, name: `F${i}`, type: "text" as const, position: i + 1 })),
  );
  await expect(call(router.fields.create, { tableId: table.id, name: "One more", type: "text" }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("the last field can't be deleted", async () => {
  const context = await ownerContext();
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  await expect(call(router.fields.delete, { id: table.fields[0]!.id }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "A table keeps at least one field",
  });
  expect((await call(router.tables.get, { id: table.id }, { context })).fields).toHaveLength(1);
});

test("reorder refuses a list that isn't the table's fields", async () => {
  const context = await ownerContext();
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const name = table.fields[0]!;
  const notes = await call(router.fields.create, { tableId: table.id, name: "Notes", type: "long-text" }, { context });
  const other = await call(router.tables.create, { name: "Other" }, { context });
  for (const fieldIds of [[name.id], [name.id, name.id], [name.id, notes.id, other.fields[0]!.id], [name.id, other.fields[0]!.id]]) {
    await expect(call(router.fields.reorder, { tableId: table.id, fieldIds }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
});

test("retype dry run changes nothing and counts what would clear", async () => {
  const context = await ownerContext();
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const name = table.fields[0]!;
  await addRows(context, table.id, [{ [name.id]: "12" }, { [name.id]: "about 20" }, {}]);
  const dry = await call(router.fields.retype, { id: name.id, type: "number", dryRun: true }, { context });
  expect(dry).toEqual({ converted: 1, cleared: 1, field: name });
  expect(await valuesOf(context, table.id)).toEqual([{ [name.id]: "12" }, { [name.id]: "about 20" }, {}]);
  expect((await call(router.tables.get, { id: table.id }, { context })).fields[0]!.type).toBe("text");
});

test("retype converts every cell and publishes the changed rows", async () => {
  const context = await ownerContext();
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const name = table.fields[0]!;
  const ids = await addRows(context, table.id, [{ [name.id]: "12" }, { [name.id]: "about 20" }, {}]);
  const events = context.dataEvents.subscribe([table.id]);
  const res = await call(router.fields.retype, { id: name.id, type: "number", dryRun: false }, { context });
  expect(res).toEqual({ converted: 1, cleared: 1, field: { ...name, type: "number" } });
  expect(await valuesOf(context, table.id)).toEqual([{ [name.id]: 12 }, { [name.id]: null }, {}]);
  expect((await events.next()).value).toEqual({ type: "rows", tableId: table.id, rowIds: [ids[0], ids[1]] });
  expect((await events.next()).value).toEqual({ type: "schema", tableId: table.id });
  await events.return?.();

  // To a single select: one choice per distinct value.
  const status = await call(router.fields.create, { tableId: table.id, name: "Status", type: "text" }, { context });
  await context.db.update(rows).set({ values: { [status.id]: "Idea" } }).where(eq(rows.id, ids[0]!));
  await context.db.update(rows).set({ values: { [status.id]: "idea" } }).where(eq(rows.id, ids[1]!));
  const select = await call(router.fields.retype, { id: status.id, type: "single-select", dryRun: false }, { context });
  expect(select.field.choices.map((c) => c.label)).toEqual(["Idea"]);
  expect((await valuesOf(context, table.id)).map((v) => v[status.id])).toEqual([select.field.choices[0]!.id, select.field.choices[0]!.id, undefined]);
});

test("removing a choice clears its cells", async () => {
  const context = await ownerContext();
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const choices = [
    { id: "c_idea", label: "Idea" },
    { id: "c_live", label: "Live" },
  ];
  const status = await call(router.fields.create, { tableId: table.id, name: "Status", type: "single-select", choices }, { context });
  const ids = await addRows(context, table.id, [{ [status.id]: "c_idea" }, { [status.id]: "c_live" }, {}]);
  // Duplicate labels or ids are refused.
  await expect(
    call(router.fields.update, { id: status.id, choices: [...choices, { id: "c_other", label: "IDEA" }] }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });

  const events = context.dataEvents.subscribe([table.id]);
  const updated = await call(router.fields.update, { id: status.id, choices: [{ id: "c_live", label: "Shipped" }] }, { context });
  expect(updated.choices).toEqual([{ id: "c_live", label: "Shipped" }]);
  expect((await valuesOf(context, table.id)).map((v) => v[status.id])).toEqual([null, "c_live", undefined]);
  expect((await events.next()).value).toEqual({ type: "rows", tableId: table.id, rowIds: [ids[0]] });
  expect((await events.next()).value).toEqual({ type: "schema", tableId: table.id });
  await events.return?.();
});

test("another owner's table and field are NOT_FOUND", async () => {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tables).values({ id: "tbl_other", ownerId: "user_other", name: "Secrets" });
  await context.db
    .insert(fields)
    .values({ id: "fld_other", ownerId: "user_other", tableId: "tbl_other", name: "Name", type: "text", position: 0 });
  await context.db.insert(rows).values({ id: "row_other", ownerId: "user_other", tableId: "tbl_other", values: { fld_other: "kept" } });

  const attempts = [
    () => call(router.tables.get, { id: "tbl_other" }, { context }),
    () => call(router.tables.rename, { id: "tbl_other", name: "Mine" }, { context }),
    () => call(router.tables.delete, { id: "tbl_other" }, { context }),
    () => call(router.fields.create, { tableId: "tbl_other", name: "More", type: "text" }, { context }),
    () => call(router.fields.update, { id: "fld_other", name: "Mine" }, { context }),
    () => call(router.fields.reorder, { tableId: "tbl_other", fieldIds: ["fld_other"] }, { context }),
    () => call(router.fields.retype, { id: "fld_other", type: "number", dryRun: true }, { context }),
    () => call(router.fields.delete, { id: "fld_other" }, { context }),
  ];
  for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
  // A table of mine can't take another owner's field either.
  const mine = await call(router.tables.create, { name: "Mine" }, { context });
  await expect(call(router.fields.reorder, { tableId: mine.id, fieldIds: [mine.fields[0]!.id, "fld_other"] }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });

  expect(await call(router.tables.list, undefined, { context })).toHaveLength(1);
  expect(await context.db.select().from(tables).where(eq(tables.id, "tbl_other"))).toMatchObject([{ name: "Secrets" }]);
  expect(await context.db.select().from(fields).where(eq(fields.id, "fld_other"))).toMatchObject([{ name: "Name", type: "text" }]);
  expect(await context.db.select().from(rows).where(eq(rows.id, "row_other"))).toMatchObject([{ values: { fld_other: "kept" } }]);
});
