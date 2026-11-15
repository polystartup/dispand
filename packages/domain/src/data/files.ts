import { MAX_FILE_BYTES, MAX_RESULT_FILES, resultRefusal } from "@dispand/runner-protocol";
import { ORPCError } from "@orpc/server";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { attachments, rows as rowsTable, runs, tables as tablesTable, workspaceSettings, type EventActor } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { meter } from "../telemetry/index.ts";
import type { ToolResult } from "../tools/mcp.ts";

// Files of attachment cells. Each one is `<filesDir>/<ownerId>/<attachmentId>`: both ids are made
// by the server, so nothing an upload says reaches the path. Whether a file is an image comes
// from its first bytes only, never from its name or the type the browser sent; only those
// images are ever served inline (see `apps/web/src/server/files.ts`). A file is a table's (uploaded
// to it, or written in one of its rows) or, until then, the Job's a tool returned it to.

const owner = base.use(authed);

export { MAX_FILE_BYTES, MAX_RESULT_FILES };
/** An upload or an orphan file is kept this long before the sweep may remove it; a Job's files, this long after the Job ends. */
const GRACE_MS = 3600_000;
const MIB = 1024 * 1024;
/**
 * What one Job keeps in all, whatever a file came from: 200 MiB is ten results of large files,
 * and 100 files five full results. A runaway loop of calls stops there, well before the disk.
 */
export const MAX_JOB_BYTES = 200 * MIB;
export const MAX_JOB_FILES = 100;
/** What the whole install keeps until its owner sets otherwise (`workspace_settings.files_limit_mib`): 10 GiB. */
export const DEFAULT_FILES_LIMIT_MIB = 10_240;

const counts = meter("files");

export type AttachmentView = { id: string; name: string; mime: string; size: number; image: boolean };
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export function attachmentView(a: typeof attachments.$inferSelect): AttachmentView {
  const { id, name, mime, size, image } = a;
  return { id, name, mime, size, image };
}

const startsWith = (head: Uint8Array, bytes: number[], at = 0) => bytes.every((b, i) => head[at + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** The image type from the file's magic bytes; null for anything else, SVG included. */
export function detectImage(head: Uint8Array): ImageType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) return "image/gif";
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** The name as stored: well-formed, no NUL, at most 255 characters. */
function storedName(name: string): string {
  const clean = name.replaceAll("\0", "").slice(0, 255).toWellFormed();
  return clean.trim() === "" ? "file" : clean;
}

const ownerDir = (filesDir: string, ownerId: string) => join(filesDir, ownerId);

const upload = owner.input(z.object({ tableId: z.string().max(64), file: z.file() })).handler(async ({ input, context }) => {
  const [table] = await context.db
    .select({ id: tablesTable.id })
    .from(tablesTable)
    .where(and(eq(tablesTable.id, input.tableId), eq(tablesTable.ownerId, context.ownerId)));
  if (!table) throw new ORPCError("NOT_FOUND");
  if (input.file.size > MAX_FILE_BYTES) throw new ORPCError("BAD_REQUEST", { message: "Files are at most 10 MiB" });
  const row = await storeAttachment(context.db, context.filesDir, { ownerId: context.ownerId, tableId: table.id, name: input.file.name, bytes: new Uint8Array(await input.file.arrayBuffer()) });
  counts.counter("dispand.attachments.stored").add(1, { "dispand.attachment.source": "upload" });
  return attachmentView(row);
});

/**
 * Stores one file (at most `MAX_FILE_BYTES`, checked by the caller) for a table or a Job: its type
 * sniffed from its first bytes, the file on disk before its row.
 */
async function storeAttachment(db: Db | Tx, filesDir: string, file: { ownerId: string; tableId?: string; jobId?: string; name: string; bytes: Uint8Array }) {
  const image = detectImage(file.bytes);
  const id = newId("att");
  const dir = ownerDir(filesDir, file.ownerId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Complete before its name exists: a reader never sees half a file. A failure past this point
  // leaves a file without a row, which the sweep removes.
  await writeFile(join(dir, `${id}.tmp`), file.bytes, { flag: "wx", mode: 0o600 });
  await rename(join(dir, `${id}.tmp`), join(dir, id));
  const [row] = await db
    .insert(attachments)
    .values({ id, ownerId: file.ownerId, tableId: file.tableId ?? null, jobId: file.jobId ?? null, name: storedName(file.name), mime: image ?? "application/octet-stream", size: file.bytes.length, image: image !== null })
    .returning();
  return row!;
}

/** The install's limit on all its files, in MiB: its owner's setting. */
export async function filesLimitOf(db: Db | Tx, ownerId: string): Promise<number> {
  const [row] = await db.select({ mib: workspaceSettings.filesLimitMib }).from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId));
  return row?.mib ?? DEFAULT_FILES_LIMIT_MIB;
}

/**
 * The files a Job keeps, and the bytes of every file of the install: what the totals cover. A
 * Job's file stays counted once a table takes it (its `jobId` stays). Every file a Job holds is an
 * attachment row with its `jobId`, whatever it came from, so a new source counts here by storing
 * its files that way.
 */
async function totals(tx: Tx, jobId: string): Promise<{ jobFiles: number; jobBytes: number; installBytes: number }> {
  const bytes = sql<string>`coalesce(sum(${attachments.size}), 0)`;
  const [job] = await tx.select({ n: count(), bytes }).from(attachments).where(eq(attachments.jobId, jobId));
  const [install] = await tx.select({ bytes }).from(attachments);
  return { jobFiles: job?.n ?? 0, jobBytes: Number(job?.bytes ?? 0), installBytes: Number(install?.bytes ?? 0) };
}

type Limit = "result" | "job" | "install";

/** Why none of these files may be kept now, and which limit says so; null when every one fits. */
async function refusal(tx: Tx, job: { ownerId: string; runId: string }, files: { name: string; size: number }[]): Promise<{ limit: Limit; text: string } | null> {
  const perResult = resultRefusal(files);
  if (perResult) return { limit: "result", text: perResult };
  const size = files.reduce((n, f) => n + f.size, 0);
  const now = await totals(tx, job.runId);
  if (now.jobFiles + files.length > MAX_JOB_FILES) return { limit: "job", text: `None of the files in this result were kept: this Job already keeps ${now.jobFiles} files, and a Job keeps at most ${MAX_JOB_FILES}.` };
  if (now.jobBytes + size > MAX_JOB_BYTES) return { limit: "job", text: `None of the files in this result were kept: with them, this Job's files would pass ${MAX_JOB_BYTES / MIB} MiB, the most a Job keeps.` };
  const limit = await filesLimitOf(tx, job.ownerId);
  if (now.installBytes + size > limit * MIB) return { limit: "install", text: `None of the files in this result were kept: with them, Dispand's files would pass ${limit} MiB, the most this install keeps (a setting of its owner).` };
  return null;
}

/**
 * The files of a tool's result, kept as attachments of the Job that called it (with the same
 * sniffing as uploads), and the result's text telling the agent their ids in place of the bytes.
 * All or none: a result that passes a limit (a file over 10 MiB, more than 20 files, the Job's
 * totals or the install's) keeps none of its files, and the text says why. The Job can then write
 * them in a file field (`writeRow`). `source` names where they came from, for the metrics.
 */
export async function keepJobFiles(db: Db, filesDir: string, job: { ownerId: string; runId: string }, result: ToolResult, source: "tool" | "runner-tool" = "tool"): Promise<ToolResult> {
  const { files, ...rest } = result;
  if (!files?.length) return rest;
  const outcome = await db.transaction(async (tx) => {
    // One result at a time over the whole install: two can't both pass a total only one of them fits.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dispand:attachments'))`);
    const refused = await refusal(tx, job, files.map((f) => ({ name: storedName(f.name), size: f.bytes.length })));
    if (refused) return refused;
    const rows = [];
    for (const file of files) rows.push(await storeAttachment(tx, filesDir, { ownerId: job.ownerId, jobId: job.runId, name: file.name, bytes: file.bytes }));
    return rows;
  });
  let note: string;
  if (Array.isArray(outcome)) {
    counts.counter("dispand.attachments.stored").add(outcome.length, { "dispand.attachment.source": source });
    const lines = outcome.map((row, i) => `File ${i + 1} (“${row.name}”): attachment ${row.id}, ${row.mime}, ${row.size} bytes`);
    note = `Files in this result, kept for this Job (write an attachment's id in a file field to keep it; the others are removed an hour after the Job ends):\n${lines.join("\n")}`;
  } else {
    counts.counter("dispand.attachments.refused").add(files.length, { "dispand.attachment.limit": outcome.limit });
    note = outcome.text;
  }
  return { ...rest, text: rest.text ? `${rest.text}\n\n${note}` : note };
}

export const files = { upload };

/**
 * Of these attachment ids, the ones that are attachments of this owner's table, locked
 * `FOR SHARE` so the sweep can't remove them before the write that uses them commits. A Job
 * writing (`actor`) may also use the files its tools returned that no table has yet (`adopt`,
 * locked `FOR UPDATE`): the write gives them to this table (`adoptAttachments`) once it is sure to
 * happen. Any other file (another table's, another Job's) isn't found.
 */
export async function lockAttachments(tx: Tx, ownerId: string, tableId: string, ids: string[], actor?: EventActor): Promise<{ known: Set<string>; adopt: string[] }> {
  if (ids.length === 0) return { known: new Set(), adopt: [] };
  const found = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(inArray(attachments.id, ids), eq(attachments.ownerId, ownerId), eq(attachments.tableId, tableId)))
    .for("share");
  const adopt =
    actor?.type === "job"
      ? await tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(and(inArray(attachments.id, ids), eq(attachments.ownerId, ownerId), eq(attachments.jobId, actor.runId), isNull(attachments.tableId)))
          .for("update")
      : [];
  return { known: new Set([...found, ...adopt].map((a) => a.id)), adopt: adopt.map((a) => a.id) };
}

/** Gives a Job's files, locked by `lockAttachments`, to the table a row of which now holds them. */
export async function adoptAttachments(tx: Tx, tableId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(attachments).set({ tableId }).where(and(inArray(attachments.id, ids), isNull(attachments.tableId)));
}

/** The views of these attachments of the owner, by id. */
export async function attachmentsById(db: Db, ownerId: string, ids: string[]): Promise<Record<string, AttachmentView>> {
  if (ids.length === 0) return {};
  const found = await db
    .select()
    .from(attachments)
    .where(and(inArray(attachments.id, [...new Set(ids)]), eq(attachments.ownerId, ownerId)));
  return Object.fromEntries(found.map((a) => [a.id, attachmentView(a)]));
}

/** One of the owner's files, ready to stream; null if it isn't theirs or is gone. */
export async function openAttachment(
  db: Db,
  filesDir: string,
  ownerId: string,
  id: string,
): Promise<{ body: ReadableStream<Uint8Array>; name: string; mime: string; size: number; image: boolean } | null> {
  const [found] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.ownerId, ownerId)));
  if (!found) return null;
  try {
    const handle = await open(join(ownerDir(filesDir, ownerId), found.id));
    const body = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
    return { body, name: found.name, mime: found.mime, size: found.size, image: found.image };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Some cell of the attachment's table holds its id. */
const referenced = sql`exists (select 1 from ${rowsTable} where ${rowsTable.tableId} = ${attachments.tableId}
  and jsonb_path_exists(${rowsTable.values}, '$.*[*] ? (@ == $id)', jsonb_build_object('id', ${attachments.id})))`;

/**
 * What the sweep removes, `cutoff` being an hour ago: a table's file no row of it references,
 * past an hour; a Job's file no table took, an hour after the Job ended (or, its Job deleted, an
 * hour after it came).
 */
const unused = (cutoff: Date) =>
  sql`((${attachments.tableId} is not null and ${attachments.createdAt} < ${cutoff} and not ${referenced})
    or (${attachments.tableId} is null and ${attachments.jobId} is null and ${attachments.createdAt} < ${cutoff})
    or (${attachments.tableId} is null and exists (select 1 from ${runs} where ${runs.id} = ${attachments.jobId} and ${runs.finishedAt} < ${cutoff})))`;

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Removes what no cell uses any more, past an hour: attachment rows no row of their table
 * references (a cell cleared, a field deleted or retyped, an upload never saved) or a Job's
 * files no row took (`unused`), then their files, then files with no attachment row at all (a
 * deleted table's, an interrupted upload's).
 * The one mechanism for every way a file stops being used.
 */
export async function sweepAttachments(db: Db, filesDir: string, now: Date): Promise<{ removed: number }> {
  const cutoff = new Date(now.getTime() - GRACE_MS);
  const gone = await db.transaction(async (tx) => {
    // Locked first, skipping any a write holds: that write may be about to reference it. Checked
    // again in a later statement, which sees every write that committed before the lock.
    const candidates = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(unused(cutoff))
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    return tx
      .delete(attachments)
      .where(and(inArray(attachments.id, candidates.map((c) => c.id)), unused(cutoff)))
      .returning({ id: attachments.id, ownerId: attachments.ownerId });
  });
  for (const a of gone) await rm(join(ownerDir(filesDir, a.ownerId), a.id), { force: true });

  let orphans = 0;
  const owners = await readdir(filesDir).catch((err: unknown) => (missing(err) ? [] : Promise.reject(err)));
  for (const ownerId of owners) {
    const dir = ownerDir(filesDir, ownerId);
    const names = await readdir(dir).catch((err: unknown) => (missing(err) ? [] : Promise.reject(err)));
    const old: string[] = [];
    for (const name of names) {
      const info = await stat(join(dir, name)).catch((err: unknown) => (missing(err) ? null : Promise.reject(err)));
      if (info?.isFile() && info.mtime < cutoff) old.push(name);
    }
    if (old.length === 0) continue;
    const known = new Set((await db.select({ id: attachments.id }).from(attachments).where(inArray(attachments.id, old))).map((a) => a.id));
    for (const name of old.filter((n) => !known.has(n))) {
      await unlink(join(dir, name)).catch((err: unknown) => (missing(err) ? undefined : Promise.reject(err)));
      orphans++;
    }
  }
  if (gone.length + orphans > 0) counts.counter("dispand.attachments.swept").add(gone.length + orphans);
  return { removed: gone.length + orphans };
}
