import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { attachments, rows, tables, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { detectImage, MAX_FILE_BYTES, openAttachment, sweepAttachments } from "./files.ts";
import { writeRow } from "./rows.ts";

type Ctx = Awaited<ReturnType<typeof ownerContext>>;

// The smallest valid PNG header: signature, then the IHDR chunk's start.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");

async function projects(context: Ctx) {
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const logo = await call(router.fields.create, { tableId: table.id, name: "Logo", type: "attachment" }, { context });
  return { table, logo };
}

const upload = (context: Ctx, tableId: string, bytes: Uint8Array<ArrayBuffer>, name: string, type = "") =>
  call(router.files.upload, { tableId, file: new File([bytes], name, { type }) }, { context });

const hourAgo = (now: Date, minutes = 61) => new Date(now.getTime() - minutes * 60_000);

test("detectImage reads magic bytes only", () => {
  expect(detectImage(PNG)).toBe("image/png");
  expect(detectImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(detectImage(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
  expect(detectImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(detectImage(SVG)).toBeNull();
  expect(detectImage(new Uint8Array())).toBeNull();
});

test("upload stores the file under the owner and sniffs images", async () => {
  const context = await ownerContext();
  const { table } = await projects(context);
  const file = await upload(context, table.id, PNG, "x.bin", "application/octet-stream");
  expect(file).toEqual({ id: expect.stringMatching(/^att_/), name: "x.bin", mime: "image/png", size: PNG.length, image: true });
  expect(new Uint8Array(await readFile(join(context.filesDir, context.ownerId, file.id)))).toEqual(PNG);
  expect(await readdir(join(context.filesDir, context.ownerId))).toEqual([file.id]); // no temp file left
  const opened = await openAttachment(context.db, context.filesDir, context.ownerId, file.id);
  expect(opened).toMatchObject({ name: "x.bin", mime: "image/png", size: PNG.length, image: true });
  expect(new Uint8Array(await new Response(opened!.body).arrayBuffer())).toEqual(PNG);
});

test("an SVG or HTML named .png is not an image", async () => {
  const context = await ownerContext();
  const { table } = await projects(context);
  for (const bytes of [SVG, HTML]) {
    expect(await upload(context, table.id, bytes, "logo.png", "image/png")).toMatchObject({ mime: "application/octet-stream", image: false });
  }
});

test("upload over 10 MiB is refused", async () => {
  const context = await ownerContext();
  const { table } = await projects(context);
  await expect(upload(context, table.id, new Uint8Array(MAX_FILE_BYTES + 1), "big.bin")).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Files are at most 10 MiB",
  });
  expect(await context.db.select().from(attachments)).toEqual([]);
});

test("a cell can only hold attachments of its own table and owner", async () => {
  const context = await ownerContext();
  const { table, logo } = await projects(context);
  const other = await call(router.tables.create, { name: "Other" }, { context });
  const mine = await upload(context, table.id, PNG, "a.png");
  const elsewhere = await upload(context, other.id, PNG, "b.png");
  const write = (ids: string[]) => context.db.transaction((tx) => writeRow(tx, { ownerId: context.ownerId, tableId: table.id, values: { [logo.id]: ids } }));
  expect(await write([mine.id])).toMatchObject({ row: { values: { [logo.id]: [mine.id] } } });
  expect(await write([mine.id, elsewhere.id])).toEqual({ problem: "“Logo”: no such file" });
  expect(await write(["att_missing"])).toEqual({ problem: "“Logo”: no such file" });
});

test("list and get return the attachments of the cells they show", async () => {
  const context = await ownerContext();
  const { table, logo } = await projects(context);
  const file = await upload(context, table.id, PNG, "a.png");
  const row = await call(router.rows.create, { tableId: table.id, values: { [logo.id]: [file.id] } }, { context });
  const view = { [file.id]: file };
  expect(await call(router.rows.list, { tableId: table.id }, { context })).toMatchObject({ rows: [{ id: row.id }], attachments: view });
  expect(await call(router.rows.get, { id: row.id }, { context })).toMatchObject({ id: row.id, attachments: view });
});

test("sweep removes unreferenced files older than an hour and keeps referenced or recent ones", async () => {
  const context = await ownerContext();
  const { table, logo } = await projects(context);
  const kept = await upload(context, table.id, PNG, "kept.png");
  const dropped = await upload(context, table.id, PNG, "dropped.png");
  const recent = await upload(context, table.id, PNG, "recent.png");
  await call(router.rows.create, { tableId: table.id, values: { [logo.id]: [kept.id] } }, { context });
  const now = new Date(Date.now() + 2 * 3600_000);
  await context.db.update(attachments).set({ createdAt: hourAgo(now) }).where(eq(attachments.id, kept.id));
  await context.db.update(attachments).set({ createdAt: hourAgo(now) }).where(eq(attachments.id, dropped.id));
  await context.db.update(attachments).set({ createdAt: hourAgo(now, 10) }).where(eq(attachments.id, recent.id));
  // A file on disk whose row is gone (its table was deleted), and one just written.
  const dir = join(context.filesDir, context.ownerId);
  await writeFile(join(dir, "att_orphan"), "x");
  await utimes(join(dir, "att_orphan"), hourAgo(now), hourAgo(now));
  await writeFile(join(dir, "att_fresh.tmp"), "x");
  await utimes(join(dir, "att_fresh.tmp"), hourAgo(now, 10), hourAgo(now, 10));

  expect(await sweepAttachments(context.db, context.filesDir, now)).toEqual({ removed: 2 });
  expect((await context.db.select({ id: attachments.id }).from(attachments)).map((a) => a.id).sort()).toEqual([kept.id, recent.id].sort());
  expect((await readdir(dir)).sort()).toEqual(["att_fresh.tmp", kept.id, recent.id].sort());
  await stat(join(dir, kept.id));
});

test("deleting a table leaves its files to the sweep", async () => {
  const context = await ownerContext();
  const { table } = await projects(context);
  const file = await upload(context, table.id, PNG, "a.png");
  await call(router.tables.delete, { id: table.id }, { context });
  expect(await context.db.select().from(attachments)).toEqual([]);
  const now = new Date(Date.now() + 2 * 3600_000);
  await utimes(join(context.filesDir, context.ownerId, file.id), hourAgo(now), hourAgo(now));
  await sweepAttachments(context.db, context.filesDir, now);
  expect(await readdir(join(context.filesDir, context.ownerId))).toEqual([]);
});

test("another owner's table can't receive an upload, and their files can't be opened", async () => {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tables).values({ id: "tbl_other", ownerId: "user_other", name: "Secrets" });
  await context.db.insert(attachments).values({ id: "att_other", ownerId: "user_other", tableId: "tbl_other", name: "s.png", mime: "image/png", size: 1, image: true });
  await expect(upload(context, "tbl_other", PNG, "a.png")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await openAttachment(context.db, context.filesDir, context.ownerId, "att_other")).toBeNull();
});

test("retyping an attachment field to text keeps the file names", async () => {
  const context = await ownerContext();
  const { table, logo } = await projects(context);
  const a = await upload(context, table.id, PNG, "a.png");
  const b = await upload(context, table.id, SVG, "b.svg");
  const row = await call(router.rows.create, { tableId: table.id, values: { [logo.id]: [a.id, b.id] } }, { context });
  await call(router.fields.retype, { id: logo.id, type: "text", dryRun: false }, { context });
  expect((await call(router.rows.get, { id: row.id }, { context })).values[logo.id]).toBe("a.png, b.svg");
});

test("editFiles adds and removes against the cell as stored, so one change never drops another", async () => {
  const context = await ownerContext();
  const { table, logo } = await projects(context);
  const a = await upload(context, table.id, PNG, "a.png");
  const b = await upload(context, table.id, PNG, "b.png");
  const c = await upload(context, table.id, PNG, "c.png");
  const row = await call(router.rows.create, { tableId: table.id }, { context });
  const edit = (change: { add?: string[]; remove?: string[] }) => call(router.rows.editFiles, { id: row.id, fieldId: logo.id, add: [], remove: [], ...change }, { context });
  // Two tabs adding at once: both lists land, whichever runs last.
  await Promise.all([edit({ add: [a.id] }), edit({ add: [b.id] })]);
  expect(((await call(router.rows.get, { id: row.id }, { context })).values[logo.id] as string[]).sort()).toEqual([a.id, b.id].sort());
  await edit({ add: [c.id, a.id], remove: [b.id] });
  expect((await call(router.rows.get, { id: row.id }, { context })).values[logo.id]).toEqual([a.id, c.id]);
  await edit({ remove: [a.id, c.id] });
  expect((await call(router.rows.get, { id: row.id }, { context })).values[logo.id]).toBeNull();
  // Only this table's files, and only a files field.
  const other = await call(router.tables.create, { name: "Other" }, { context });
  const elsewhere = await upload(context, other.id, PNG, "x.png");
  await expect(edit({ add: [elsewhere.id] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "“Logo”: no such file" });
  await expect(call(router.rows.editFiles, { id: row.id, fieldId: table.fields[0]!.id, add: [a.id], remove: [] }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("another owner's row can't have its files edited", async () => {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tables).values({ id: "tbl_other", ownerId: "user_other", name: "Secrets" });
  await context.db.insert(rows).values({ id: "row_other", ownerId: "user_other", tableId: "tbl_other", values: {} });
  await expect(call(router.rows.editFiles, { id: "row_other", fieldId: "fld_x", add: [], remove: [] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
