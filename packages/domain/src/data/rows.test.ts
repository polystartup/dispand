import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { fields, rows, tables, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, recordingDb } from "../runners/test-support.ts";
import type { Cell } from "./fields.ts";
import { writeRow } from "./rows.ts";

type Ctx = Awaited<ReturnType<typeof ownerContext>>;

async function projects(context: Ctx) {
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const add = (name: string, type: "number" | "checkbox" | "date" | "single-select" | "attachment" | "url", choices: { id: string; label: string }[] = []) =>
    call(router.fields.create, { tableId: table.id, name, type, choices }, { context });
  return {
    table,
    name: table.fields[0]!,
    price: await add("Price", "number"),
    done: await add("Done", "checkbox"),
    due: await add("Due", "date"),
    status: await add("Status", "single-select", [
      { id: "c_live", label: "Live" },
      { id: "c_idea", label: "Idea" },
    ]),
    logo: await add("Logo", "attachment"),
  };
}

const names = (list: { values: Record<string, Cell> }[], fieldId: string) => list.map((r) => r.values[fieldId]);

test("rows CRUD and total", async () => {
  const context = await ownerContext();
  const { table, name, price } = await projects(context);
  const a = await call(router.rows.create, { tableId: table.id, values: { [name.id]: "Alpha", [price.id]: 3 } }, { context });
  expect(a).toMatchObject({ id: expect.stringMatching(/^row_/), tableId: table.id, values: { [name.id]: "Alpha", [price.id]: 3 } });
  const b = await call(router.rows.create, { tableId: table.id }, { context });
  expect(b.values).toEqual({});
  expect(await call(router.rows.get, { id: a.id }, { context })).toEqual({ ...a, attachments: {} });

  const updated = await call(router.rows.update, { id: a.id, values: { [price.id]: null } }, { context });
  expect(updated.values).toEqual({ [name.id]: "Alpha", [price.id]: null });

  const page = await call(router.rows.list, { tableId: table.id, limit: 1 }, { context });
  expect(page).toMatchObject({ total: 2, rows: [{ id: a.id }] });
  expect((await call(router.rows.list, { tableId: table.id, offset: 1 }, { context })).rows.map((r) => r.id)).toEqual([b.id]);

  await call(router.rows.delete, { ids: [a.id, b.id] }, { context });
  expect(await call(router.rows.list, { tableId: table.id }, { context })).toEqual({ rows: [], total: 0, attachments: {} });
  await expect(call(router.rows.get, { id: a.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("filters: contains matches % and _ literally", async () => {
  const context = await ownerContext();
  const { table, name } = await projects(context);
  for (const text of ["50%", "5_0", "500"]) await call(router.rows.create, { tableId: table.id, values: { [name.id]: text } }, { context });
  const find = async (value: string, op: "contains" | "not-contains" = "contains") =>
    names((await call(router.rows.list, { tableId: table.id, query: { filters: [{ fieldId: name.id, op, value }], sort: [] } }, { context })).rows, name.id);
  expect(await find("%")).toEqual(["50%"]);
  expect(await find("_")).toEqual(["5_0"]);
  expect(await find("5")).toEqual(["50%", "5_0", "500"]);
  expect(await find("%", "not-contains")).toEqual(["5_0", "500"]);
});

test("filters and sorts by type", async () => {
  const context = await ownerContext();
  const { table, name, price, done, due, status, logo } = await projects(context);
  const rowsIn: Record<string, Cell>[] = [
    { [name.id]: "a", [price.id]: 10, [done.id]: true, [due.id]: "2026-11-04", [status.id]: "c_idea", [logo.id]: [] },
    { [name.id]: "b", [price.id]: 2, [done.id]: false, [due.id]: "2026-01-15", [status.id]: "c_live" },
    { [name.id]: "c", [price.id]: null, [due.id]: null, [logo.id]: null },
    { [name.id]: "" },
  ];
  for (const values of rowsIn) await call(router.rows.create, { tableId: table.id, values }, { context });
  const list = async (query: object) =>
    names((await call(router.rows.list, { tableId: table.id, query: { filters: [], sort: [], ...query } }, { context })).rows, name.id);

  // Numbers sort as numbers, empty last either way.
  expect(await list({ sort: [{ fieldId: price.id, dir: "asc" }] })).toEqual(["b", "a", "c", ""]);
  expect(await list({ sort: [{ fieldId: price.id, dir: "desc" }] })).toEqual(["a", "b", "c", ""]);
  expect(await list({ filters: [{ fieldId: price.id, op: ">", value: "3" }] })).toEqual(["a"]);
  expect(await list({ filters: [{ fieldId: price.id, op: "!=", value: "10" }] })).toEqual(["b", "c", ""]);
  // Unchecked includes false and missing.
  expect(await list({ filters: [{ fieldId: done.id, op: "unchecked" }] })).toEqual(["b", "c", ""]);
  expect(await list({ filters: [{ fieldId: done.id, op: "checked" }] })).toEqual(["a"]);
  // Dates compare as calendar dates.
  expect(await list({ filters: [{ fieldId: due.id, op: "before", value: "2026-06-01" }] })).toEqual(["b"]);
  expect(await list({ sort: [{ fieldId: due.id, dir: "asc" }] })).toEqual(["b", "a", "c", ""]);
  // A single select sorts by choice order (Live before Idea), and filters by label.
  expect(await list({ sort: [{ fieldId: status.id, dir: "asc" }] })).toEqual(["b", "a", "c", ""]);
  expect(await list({ filters: [{ fieldId: status.id, op: "is", value: "idea" }] })).toEqual(["a"]);
  expect(await list({ filters: [{ fieldId: status.id, op: "is-not", value: "Idea" }] })).toEqual(["b", "c", ""]);
  // Empty is missing, null, "" or [].
  expect(await list({ filters: [{ fieldId: logo.id, op: "empty" }] })).toEqual(["a", "b", "c", ""]);
  expect(await list({ filters: [{ fieldId: name.id, op: "empty" }] })).toEqual([""]);
  expect(await list({ filters: [{ fieldId: price.id, op: "empty" }] })).toEqual(["c", ""]);
  expect(await list({ filters: [{ fieldId: price.id, op: "not-empty" }] })).toEqual(["a", "b"]);
  // Text sorts case-insensitively, empty last; filters are ANDed.
  expect(await list({ sort: [{ fieldId: name.id, dir: "desc" }] })).toEqual(["c", "b", "a", ""]);
  expect(
    await list({
      filters: [
        { fieldId: price.id, op: "not-empty" },
        { fieldId: done.id, op: "unchecked" },
      ],
    }),
  ).toEqual(["b"]);
});

test("update merges cells: two concurrent updates of different cells both land", async () => {
  const context = await ownerContext();
  const { table, name, price } = await projects(context);
  const row = await call(router.rows.create, { tableId: table.id }, { context });
  await Promise.all([
    call(router.rows.update, { id: row.id, values: { [name.id]: "Alpha" } }, { context }),
    call(router.rows.update, { id: row.id, values: { [price.id]: 5 } }, { context }),
  ]);
  expect((await call(router.rows.get, { id: row.id }, { context })).values).toEqual({ [name.id]: "Alpha", [price.id]: 5 });
});

test("a write racing a retype is checked against the new type", async () => {
  const context = await ownerContext();
  const { table, name } = await projects(context);
  const row = await call(router.rows.create, { tableId: table.id, values: { [name.id]: "12" } }, { context });
  // A schema change holds the table's row (as fields.retype does) while the write is sent.
  let write: Promise<unknown> | undefined;
  await context.db.transaction(async (tx) => {
    await tx.select().from(tables).where(eq(tables.id, table.id)).for("update");
    write = call(router.rows.update, { id: row.id, values: { [name.id]: "7" } }, { context }).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await tx.update(fields).set({ type: "number" }).where(eq(fields.id, name.id));
    await tx.update(rows).set({ values: { [name.id]: 12 } }).where(eq(rows.id, row.id));
  });
  expect(await write).toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("“Name”") });
  expect((await call(router.rows.get, { id: row.id }, { context })).values).toEqual({ [name.id]: 12 });
});

test("writeRow takes the table's row FOR SHARE before it reads the fields", async () => {
  const { db, statements } = await recordingDb();
  await db.insert(user).values({ id: "user_1", name: "Ada", email: "ada@example.com" });
  await db.insert(tables).values({ id: "tbl_1", ownerId: "user_1", name: "T" });
  await db.insert(fields).values({ id: "fld_1", ownerId: "user_1", tableId: "tbl_1", name: "Name", type: "text", position: 0 });
  statements.length = 0;
  const result = await db.transaction((tx) => writeRow(tx, { ownerId: "user_1", tableId: "tbl_1", values: { fld_1: "x" } }));
  expect(result).toMatchObject({ row: { values: { fld_1: "x" } } });
  const lock = statements.findIndex((q) => /from "tables".* for share/s.test(q));
  const read = statements.findIndex((q) => /from "fields"/.test(q));
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(lock).toBeLessThan(read);
});

test("an unknown field or a value of the wrong type is refused", async () => {
  const context = await ownerContext();
  const { table, name, price, due } = await projects(context);
  const row = await call(router.rows.create, { tableId: table.id, values: { [name.id]: "Alpha" } }, { context });
  await expect(call(router.rows.create, { tableId: table.id, values: { fld_nope: "x" } }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("fld_nope"),
  });
  await expect(call(router.rows.update, { id: row.id, values: { [price.id]: "7" } }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("“Price”"),
  });
  await expect(call(router.rows.update, { id: row.id, values: { [due.id]: "tomorrow" } }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("“Due”"),
  });
  await expect(call(router.rows.update, { id: row.id, values: { [name.id]: "x".repeat(10_001) } }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  // Nothing was written.
  expect((await call(router.rows.get, { id: row.id }, { context })).values).toEqual({ [name.id]: "Alpha" });
  expect((await call(router.rows.list, { tableId: table.id }, { context })).total).toBe(1);
});

test("a select value that isn't a choice is refused", async () => {
  const context = await ownerContext();
  const { table, status } = await projects(context);
  await expect(call(router.rows.create, { tableId: table.id, values: { [status.id]: "c_other" } }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("“Status”"),
  });
  // The label isn't the value either: the grid sends choice ids.
  await expect(call(router.rows.create, { tableId: table.id, values: { [status.id]: "Live" } }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect((await call(router.rows.create, { tableId: table.id, values: { [status.id]: "c_live" } }, { context })).values).toEqual({
    [status.id]: "c_live",
  });
});

test("list refuses a page over 500 and a query with an unknown field", async () => {
  const context = await ownerContext();
  const { table, price } = await projects(context);
  await expect(call(router.rows.list, { tableId: table.id, limit: 501 }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    call(router.rows.list, { tableId: table.id, query: { filters: [{ fieldId: "fld_gone", op: "empty" }], sort: [] } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    call(router.rows.list, { tableId: table.id, query: { filters: [{ fieldId: price.id, op: ">", value: "lots" }], sort: [] } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "“Price”: expected a number, got “lots”" });
});

test("delete refuses ids of another table or owner", async () => {
  const context = await ownerContext();
  const { table } = await projects(context);
  const other = await call(router.tables.create, { name: "Other" }, { context });
  const a = await call(router.rows.create, { tableId: table.id }, { context });
  const b = await call(router.rows.create, { tableId: other.id }, { context });
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tables).values({ id: "tbl_other", ownerId: "user_other", name: "Secrets" });
  await context.db.insert(rows).values({ id: "row_other", ownerId: "user_other", tableId: "tbl_other", values: {} });

  await expect(call(router.rows.delete, { ids: [a.id, b.id] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.rows.delete, { ids: [a.id, "row_other"] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.rows.delete, { ids: ["row_other"] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await context.db.select({ id: rows.id }).from(rows).orderBy(rows.id)).toHaveLength(3);
});

test("stream yields row changes of the tables asked for only", async () => {
  const context = await ownerContext();
  const { table, name } = await projects(context);
  const other = await call(router.tables.create, { name: "Other" }, { context });
  const abort = new AbortController();
  const stream = await call(router.rows.stream, { tableIds: [table.id] }, { context, signal: abort.signal });
  const first = stream.next();
  await call(router.rows.create, { tableId: other.id }, { context });
  const row = await call(router.rows.create, { tableId: table.id, values: { [name.id]: "A" } }, { context });
  expect((await first).value).toEqual({ type: "rows", tableId: table.id, rowIds: [row.id] });
  await call(router.fields.update, { id: name.id, name: "Title" }, { context });
  expect((await stream.next()).value).toEqual({ type: "schema", tableId: table.id });
  await call(router.rows.delete, { ids: [row.id] }, { context });
  expect((await stream.next()).value).toEqual({ type: "rows", tableId: table.id, rowIds: [row.id] });
  abort.abort();
  await stream.return?.(undefined);
});

test("another owner's table can't be listed, written or streamed", async () => {
  const context = await ownerContext();
  const { table } = await projects(context);
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tables).values({ id: "tbl_other", ownerId: "user_other", name: "Secrets" });
  await context.db.insert(fields).values({ id: "fld_other", ownerId: "user_other", tableId: "tbl_other", name: "Name", type: "text", position: 0 });
  await context.db.insert(rows).values({ id: "row_other", ownerId: "user_other", tableId: "tbl_other", values: { fld_other: "kept" } });

  const attempts = [
    () => call(router.rows.list, { tableId: "tbl_other" }, { context }),
    () => call(router.rows.get, { id: "row_other" }, { context }),
    () => call(router.rows.create, { tableId: "tbl_other", values: { fld_other: "mine" } }, { context }),
    () => call(router.rows.update, { id: "row_other", values: { fld_other: "mine" } }, { context }),
    async () => (await call(router.rows.stream, { tableIds: ["tbl_other"] }, { context })).next(),
    async () => (await call(router.rows.stream, { tableIds: [table.id, "tbl_other"] }, { context })).next(),
  ];
  for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await context.db.select().from(rows).where(eq(rows.tableId, "tbl_other"))).toMatchObject([{ id: "row_other", values: { fld_other: "kept" } }]);
});
