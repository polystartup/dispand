import { createPgConfig } from "@electric-sql/pglite/node-postgres";
import { call } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { say } from "../messages/index.ts";
import { expect, onTestFinished, test } from "vitest";
import { attachments, chatQueue, messages, organizationMembers, organizations, rows, runs, stepRuns, tables, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { openDb } from "../db/client.ts";
import { router } from "../rpc/router.ts";
import { inScope, setTenancy, shared, SYSTEM } from "../db/scope.ts";
import { jobIdentity, ownerContext, pgliteClient, recordScopes } from "../runners/test-support.ts";
import { detectImage, keepJobFiles, MAX_FILE_BYTES, openAttachment, sweepAttachments, sweepScopes } from "./files.ts";
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
    message: "Files are at most 10 MiB.", data: say("data.file.tooLarge"),
  });
  expect(await context.db.select().from(attachments)).toEqual([]);
});

test("a cell can only hold attachments of its own table and owner", async () => {
  const context = await ownerContext();
  const { table, logo } = await projects(context);
  const other = await call(router.tables.create, { name: "Other" }, { context });
  const mine = await upload(context, table.id, PNG, "a.png");
  const elsewhere = await upload(context, other.id, PNG, "b.png");
  const write = (ids: string[]) => context.db.transaction((tx) => writeRow(tx, { ownerId: context.ownerId, workspaceId: context.workspaceId, tableId: table.id, values: { [logo.id]: ids }, actor: { type: "user", userId: context.ownerId } }));
  expect(await write([mine.id])).toMatchObject({ row: { values: { [logo.id]: [mine.id] } } });
  expect(await write([mine.id, elsewhere.id])).toEqual({ problem: say("data.row.noFile", { field: "Logo" }) });
  expect(await write(["att_missing"])).toEqual({ problem: say("data.row.noFile", { field: "Logo" }) });
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

/**
 * The worker's database reached through node-postgres, which sends a `Date` in Node's zone, with
 * Node in `node` and the database session in `database` until the test ends.
 */
async function zonedDb(context: Ctx, zones: { node: string; database: string }) {
  const $client = pgliteClient(context.db);
  const config = createPgConfig($client);
  // node-postgres hands Parse its query's `types`, an object with drizzle, which PGlite's adapter reads as an array.
  const parse = config.connection.parse.bind(config.connection);
  config.connection.parse = (query: object) => parse({ ...query, types: [] });
  const pool = new pg.Pool(config);
  const before = (await $client.query<{ TimeZone: string }>("show timezone")).rows[0]!.TimeZone;
  const tz = process.env.TZ;
  onTestFinished(async () => {
    await pool.end();
    await $client.query(`set timezone to '${before}'`);
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });
  process.env.TZ = zones.node;
  await $client.query(`set timezone to '${zones.database}'`);
  return openDb(pool);
}

test.each([
  { node: "Asia/Kolkata", database: "UTC" },
  { node: "UTC", database: "Asia/Kolkata" },
])("the sweep keeps an upload in its grace period and removes an expired one, Node in $node and the database in $database", { tags: ["pglite-only"] }, async (zones) => {
  const context = await ownerContext();
  const { table } = await projects(context);
  const db = await zonedDb(context, zones);
  // The database stamps an upload; the sweep compares that time with one Node computes.
  const recent = await upload(context, table.id, PNG, "recent.png");
  const expired = await upload(context, table.id, PNG, "expired.png");
  await db.update(attachments).set({ createdAt: sql`now() - interval '61 minutes'` }).where(eq(attachments.id, expired.id));

  expect(await sweepAttachments(db, context.filesDir, new Date())).toEqual({ removed: 1 });
  expect((await db.select({ id: attachments.id }).from(attachments)).map((a) => a.id)).toEqual([recent.id]);
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

test("another workspace's table can't receive an upload, and their files can't be opened", async () => {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(organizations).values({ id: "org_other" });
  await context.db.insert(workspaces).values({ id: "ws_other", organizationId: "org_other" });
  await context.db.insert(tables).values({ id: "tbl_other", workspaceId: "ws_other", ownerId: "user_other", name: "Secrets" });
  await context.db.insert(attachments).values({ id: "att_other", workspaceId: "ws_other", ownerId: "user_other", tableId: "tbl_other", name: "s.png", mime: "image/png", size: 1, image: true });
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
  await expect(edit({ add: [elsewhere.id] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "“Logo” names a file that doesn't exist.", data: say("data.row.noFile", { field: "Logo" }) });
  await expect(call(router.rows.editFiles, { id: row.id, fieldId: table.fields[0]!.id, add: [a.id], remove: [] }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("another workspace's row can't have its files edited", async () => {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(organizations).values({ id: "org_other" });
  await context.db.insert(workspaces).values({ id: "ws_other", organizationId: "org_other" });
  await context.db.insert(tables).values({ id: "tbl_other", workspaceId: "ws_other", ownerId: "user_other", name: "Secrets" });
  await context.db.insert(rows).values({ id: "row_other", ownerId: "user_other", tableId: "tbl_other", values: {} });
  await expect(call(router.rows.editFiles, { id: "row_other", fieldId: "fld_x", add: [], remove: [] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("workspace readers can download human-published chat files and the workspace's table files; drafts and raw tool files stay private", async () => {
  const context = await ownerContext();
  const { db, ownerId, filesDir } = context;
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const [workspace] = await db.select().from(workspaces);
  const { id: workspaceId, organizationId } = workspace!;
  const file = await call(router.files.hold, { file: new File([PNG], "result.png") }, { context });
  const get = (reader: string) => openAttachment(db, filesDir, reader, file.id);
  await db.insert(user).values({ id: "reader", name: "Reader", email: "reader@example.com" });
  await db.insert(organizationMembers).values({ organizationId, userId: "reader", role: "member" });
  await db.insert(workspaceMembers).values({ workspaceId, userId: "reader", role: "member" });
  expect(await get("reader")).toBeNull();

  await db.insert(runs).values({ id: "job", workspaceId, ownerId, version: 0, status: "succeeded", source: "agent" });
  await db.update(attachments).set({ jobId: "job" }).where(eq(attachments.id, file.id));
  await db.insert(stepRuns).values({ id: "step", runId: "job", nodeId: "chat", status: "running" });
  await db.insert(chatQueue).values({ id: "draft", ownerId, runId: "job", stepRunId: "step", text: "Queued", files: [{ id: file.id, name: file.name }] });
  expect(await get("reader")).toBeNull();
  await db.update(chatQueue).set({ state: "dispatched", files: null });
  await db.insert(messages).values({ id: "output", ownerId, runId: "job", stepRunId: "step", role: "tool", text: file.id, files: [{ id: file.id, name: file.name }] });
  expect(await get("reader")).toBeNull();
  await db.insert(messages).values({ id: "published", ownerId, runId: "job", stepRunId: "step", role: "user", text: "Result", files: [{ id: file.id, name: file.name }] });
  const shared = await get("reader");
  expect(shared).not.toBeNull();
  expect(new Uint8Array(await new Response(shared!.body).arrayBuffer())).toEqual(PNG);
  await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "reader"));
  expect(await get("reader")).toBeNull();
  await db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, ownerId));
  expect(await get(ownerId)).toBeNull();

  await db.update(attachments).set({ tableId: table.id }).where(eq(attachments.id, file.id));
  await db.insert(workspaceMembers).values({ workspaceId, userId: "reader", role: "member" });
  // A table's file is its workspace's: any member downloads it, someone with no role there doesn't.
  const tableFile = await get("reader");
  expect(tableFile).not.toBeNull();
  await tableFile!.body.cancel();
  expect(await get(ownerId)).toBeNull();
  await db.update(organizationMembers).set({ role: "owner" }).where(eq(organizationMembers.userId, ownerId));
  const adopted = await get(ownerId);
  expect(adopted).not.toBeNull();
  await adopted!.body.cancel();
});

const usedBytes = async (context: Ctx) => (await context.db.select({ used: organizations.filesUsedBytes }).from(organizations).where(eq(organizations.id, context.organizationId)))[0]!.used;
const setQuota = (context: Ctx, bytes: number | null) => context.db.update(organizations).set({ filesQuotaBytes: bytes }).where(eq(organizations.id, context.organizationId));
const loose = (context: Ctx, workspaceId: string, size: number, db: Pick<Ctx["db"], "insert"> = context.db) =>
  db.insert(attachments).values({ id: `att_${Math.random().toString(36).slice(2)}`, ownerId: context.ownerId, workspaceId, name: "f", mime: "application/octet-stream", size, image: false });
const quotaRefused = { cause: { code: "P0D02" } };

test("a freshly set-up install is capped at 10 GiB", async () => {
  const context = await ownerContext();
  expect(await context.db.select({ quota: organizations.filesQuotaBytes, used: organizations.filesUsedBytes }).from(organizations)).toEqual([{ quota: 10_737_418_240, used: 0 }]);
  expect(await call(router.workspace.filesLimit, undefined, { context })).toEqual({ mib: 10_240 });
});

test("two workspaces of one organization share the quota", async () => {
  const context = await ownerContext();
  await context.db.insert(workspaces).values({ id: "sibling", organizationId: context.organizationId });
  await setQuota(context, 10);
  await loose(context, context.workspaceId, 5);
  await loose(context, "sibling", 5);
  expect(await usedBytes(context)).toBe(10);
  await expect(loose(context, "sibling", 1)).rejects.toMatchObject(quotaRefused);
  await expect(loose(context, context.workspaceId, 1)).rejects.toMatchObject(quotaRefused);
});

test("concurrent uploads in two workspaces can't both pass the last bytes", async () => {
  const context = await ownerContext();
  await context.db.insert(workspaces).values({ id: "sibling", organizationId: context.organizationId });
  await setQuota(context, 10);
  const results = await Promise.allSettled([context.workspaceId, "sibling"].map((ws) => context.db.transaction((tx) => loose(context, ws, 6, tx))));
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(await usedBytes(context)).toBe(6);
});

test("deleting an attachment frees its bytes, and deleting a table frees its attachments' bytes", async () => {
  const context = await ownerContext();
  const { table } = await projects(context);
  const file = await upload(context, table.id, PNG, "a.png");
  await upload(context, table.id, PNG, "b.png");
  expect(await usedBytes(context)).toBe(2 * PNG.length);
  await context.db.delete(attachments).where(eq(attachments.id, file.id));
  expect(await usedBytes(context)).toBe(PNG.length);
  await call(router.tables.delete, { id: table.id }, { context });
  expect(await usedBytes(context)).toBe(0);
});

test("after lowering the limit below usage, a delete succeeds and an upload is refused, leaving no file", async () => {
  const context = await ownerContext();
  const { table } = await projects(context);
  const file = await upload(context, table.id, PNG, "a.png");
  await setQuota(context, 1);
  await expect(upload(context, table.id, PNG, "b.png")).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "data.file.installFull" } });
  expect(await readdir(join(context.filesDir, context.ownerId))).toEqual([file.id]);
  await context.db.delete(attachments).where(eq(attachments.id, file.id));
  expect(await usedBytes(context)).toBe(0);
});

test("a refused batch of a Job's files writes nothing to disk", async () => {
  const context = await ownerContext();
  const job = await jobIdentity(context);
  await setQuota(context, 15);
  const kept = await keepJobFiles(context.db, context.filesDir, job, { text: "", isError: false, files: [{ name: "a", bytes: Buffer.alloc(10) }, { name: "b", bytes: Buffer.alloc(10) }] });
  expect(kept.text).toContain("None of the files in this result were kept");
  expect(await readdir(join(context.filesDir, context.ownerId)).catch(() => [])).toEqual([]);
  expect(await context.db.select().from(attachments)).toEqual([]);
  expect(await usedBytes(context)).toBe(0);
});

test("a manager can't change the limit, an organization owner can", async () => {
  const context = await ownerContext();
  await call(router.workspace.setFilesLimit, { mib: 500 }, { context });
  expect((await context.db.select({ quota: organizations.filesQuotaBytes }).from(organizations))[0]!.quota).toBe(500 * 1024 * 1024);
  await context.db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, context.ownerId));
  await context.db.insert(workspaceMembers).values({ workspaceId: context.workspaceId, userId: context.ownerId, role: "manager" });
  await expect(call(router.workspace.setFilesLimit, { mib: 5 }, { context })).rejects.toMatchObject({ code: "FORBIDDEN", data: { key: "auth.ownerOnly" } });
});

/** An attachment of no table and no Job (held for a message), on disk, its file written `at`. */
async function held(context: Ctx, id: string, workspaceId: string, createdAt: Date, at: Date) {
  await context.db.insert(attachments).values({ id, workspaceId, ownerId: context.ownerId, name: "a.png", mime: "image/png", size: 1, image: true, createdAt });
  const dir = join(context.filesDir, context.ownerId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), "x");
  await utimes(join(dir, id), at, at);
}

test("sweepScopes lists the workspaces with an attachment to remove, never an idle one", { tags: ["pglite-only"] }, async () => {
  const context = await ownerContext();
  const now = new Date(Date.now() + 2 * 3600_000);
  await context.db.insert(workspaces).values({ id: "ws_b", organizationId: context.organizationId });
  await held(context, "att_fresh", context.workspaceId, now, now);
  expect(await sweepScopes(context.db, now)).toEqual([]);
  await held(context, "att_old", "ws_b", hourAgo(now, 25 * 60), hourAgo(now, 25 * 60));
  const recorder = await recordScopes(context.db);
  expect(await sweepScopes(recorder.db, now)).toEqual([{ organizationId: context.organizationId, workspaceId: "ws_b" }]);
  // Under SYSTEM it reads no content: no cell, no message, only ids and times.
  expect(recorder.statements.map((s) => s.sql).join("\n")).not.toMatch(/"rows"|"messages"/);
});

test("an old file of B that its row still holds survives A's pass", { tags: ["pglite-only"] }, async () => {
  const context = await ownerContext();
  const now = new Date(Date.now() + 2 * 3600_000);
  await context.db.insert(workspaces).values({ id: "ws_b", organizationId: context.organizationId });
  await held(context, "att_a", context.workspaceId, hourAgo(now, 25 * 60), hourAgo(now, 25 * 60));
  // Its row is recent (held for a message), its file older than the grace.
  await held(context, "att_b", "ws_b", now, hourAgo(now));
  const recorder = await recordScopes(context.db);
  recorder.register("att_b", "ws_b");
  const a = { organizationId: context.organizationId, workspaceId: context.workspaceId };
  // A pass of A alone, as a tenancy splitting work by workspace would run it.
  setTenancy(recorder.db, { each: (_db, _scopes, work) => inScope(a, work), forRun: shared.forRun });
  onTestFinished(() => setTenancy(recorder.db, shared));
  await inScope(SYSTEM, () => sweepAttachments(recorder.db, context.filesDir, now));
  expect(await readdir(join(context.filesDir, context.ownerId))).toEqual(["att_b"]);
  expect(recorder.statements.some((s) => s.scope !== SYSTEM && s.scope.workspaceId === a.workspaceId)).toBe(true);
  recorder.expectNoCrossScope();
});
