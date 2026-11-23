import { MAX_FILE_BYTES, MAX_RESULT_FILES, resultRefusal } from "@dispand/runner-protocol";
import { ORPCError } from "@orpc/server";
import { and, count, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { attachments, messages, organizations, rows as rowsTable, runners, runs, stepRuns, tables as tablesTable, workspaces, type EventActor, type MessageFile } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { message } from "../messages/index.ts";
import { authed, base } from "../rpc/context.ts";
import { meter } from "../telemetry/index.ts";
import { hasLegacyWorkspaceAccess, readableRun, requireLegacyWorkspace } from "../workspace/access.ts";
import { asMember } from "../workspace/authorize.ts";
import { eachScope, inScope, SYSTEM, type Scope } from "../db/scope.ts";
import type { ToolResult } from "../tools/mcp.ts";

// Files of attachment cells. Each one is `<filesDir>/<ownerId>/<attachmentId>`: both ids are made
// by the server, so nothing an upload says reaches the path. Whether a file is an image comes
// from its first bytes only, never from its name or the type the browser sent; only those
// images are ever served inline (see `apps/web/src/server/files.ts`). A file is a table's (uploaded
// to it, or written in one of its rows) or, until then, the Job's a tool returned it to or a
// chat message carried. A file attached in a chat is held for its owner (no table, no Job) until
// the message that carries it is sent, which gives it to that message's Job.

const owner = base.use(authed);

export { MAX_FILE_BYTES, MAX_RESULT_FILES };
/** An upload or an orphan file is kept this long before the sweep may remove it; a Job's files, this long after the Job ends. */
const GRACE_MS = 3600_000;
/** A file held for a chat message that was never sent (or left by a deleted Job) is kept this long. */
const HELD_MS = 24 * 3600_000;
const MIB = 1024 * 1024;
/**
 * What one Job keeps in all, whatever a file came from: 200 MiB is ten results of large files,
 * and 100 files five full results. A runaway loop of calls stops there, well before the disk.
 */
export const MAX_JOB_BYTES = 200 * MIB;
export const MAX_JOB_FILES = 100;

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
    .select({ id: tablesTable.id, workspaceId: tablesTable.workspaceId })
    .from(tablesTable)
    .where(and(eq(tablesTable.id, input.tableId), eq(tablesTable.ownerId, context.ownerId)));
  if (!table) throw new ORPCError("NOT_FOUND", message("data.table.notFound"));
  if (input.file.size > MAX_FILE_BYTES) throw new ORPCError("BAD_REQUEST", message("data.file.tooLarge"));
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const [row] = await storeOrRefuse(context.db, table.workspaceId, (tx) => storeAttachments(tx, context.filesDir, [{ ownerId: context.ownerId, workspaceId: table.workspaceId, tableId: table.id, name: input.file.name, bytes }]));
  counts.counter("dispand.attachments.stored").add(1, { "dispand.attachment.source": "upload" });
  return attachmentView(row!);
});

/**
 * A file attached in a chat, held for its owner until the message that carries it is sent
 * (`takeChatFiles`), and removed a day later if it never is. It counts in the organization's
 * total from now on.
 */
const hold = owner.input(z.object({ file: z.file() })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("data.file.agentOnly"));
  if (input.file.size > MAX_FILE_BYTES) throw new ORPCError("BAD_REQUEST", message("data.file.tooLarge"));
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const workspaceId = await requireLegacyWorkspace(context);
  const [row] = await storeOrRefuse(context.db, workspaceId, (tx) => storeAttachments(tx, context.filesDir, [{ ownerId: context.ownerId, workspaceId, name: input.file.name, bytes }]));
  counts.counter("dispand.attachments.stored").add(1, { "dispand.attachment.source": "chat" });
  return attachmentView(row!);
});

/**
 * Gives files held for the owner (`hold`) to the Job a chat message of theirs goes to, in the
 * transaction that writes the message: all or none, within a message's limits (20 files, 10 MiB
 * each) and the Job's totals, under the lock `keepJobFiles` takes. Their bytes count in the
 * organization's total since they were held. Throws a person's message when they can't be given.
 */
export async function takeChatFiles(tx: Tx, ownerId: string, runId: string, ids: string[]): Promise<MessageFile[]> {
  if (ids.length === 0) return [];
  if (new Set(ids).size !== ids.length || ids.length > MAX_RESULT_FILES) throw new ORPCError("BAD_REQUEST", message("data.file.tooMany", { max: MAX_RESULT_FILES }));
  await lockJobFiles(tx, runId);
  const held = await tx
    .select()
    .from(attachments)
    .where(and(inArray(attachments.id, ids), eq(attachments.ownerId, ownerId), inArray(attachments.workspaceId, tx.select({ id: runs.workspaceId }).from(runs).where(eq(runs.id, runId))), isNull(attachments.tableId), isNull(attachments.jobId)))
    .for("update");
  if (held.length !== ids.length) throw new ORPCError("BAD_REQUEST", message("data.file.gone"));
  const size = held.reduce((n, f) => n + f.size, 0);
  const now = await totals(tx, runId);
  if (now.jobFiles + held.length > MAX_JOB_FILES || now.jobBytes + size > MAX_JOB_BYTES) {
    counts.counter("dispand.attachments.refused").add(held.length, { "dispand.attachment.limit": "job" });
    throw new ORPCError("BAD_REQUEST", message("data.file.jobFull", { files: MAX_JOB_FILES, mib: MAX_JOB_BYTES / MIB }));
  }
  await tx.update(attachments).set({ jobId: runId }).where(inArray(attachments.id, ids));
  const byId = new Map(held.map((f) => [f.id, f]));
  return ids.map((id) => {
    const file = byId.get(id)!;
    return { id, name: file.name, ...(file.image ? { image: true } : {}) };
  });
}

/** One Job's files at a time: two results can't both pass a Job's totals only one of them fits. */
const lockJobFiles = (tx: Tx, runId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dispand:job-files:${runId}`}))`);

type NewFile = { ownerId: string; workspaceId: string; tableId?: string; jobId?: string; name: string; bytes: Uint8Array };

/**
 * Stores files (each at most `MAX_FILE_BYTES`, checked by the caller) for a table, a Job or a held
 * chat message: their type sniffed from their first bytes. Every row goes in before any byte is
 * written, so the organization's limit (`dispand_files_usage()`, P0D02) refuses a batch before
 * the disk sees it; a failure past that rolls the rows back and leaves files the sweep removes.
 */
async function storeAttachments(tx: Tx, filesDir: string, files: NewFile[]) {
  const rows = [];
  for (const file of files) {
    const image = detectImage(file.bytes);
    const [row] = await tx
      .insert(attachments)
      .values({ id: newId("att"), ownerId: file.ownerId, workspaceId: file.workspaceId, tableId: file.tableId ?? null, jobId: file.jobId ?? null, name: storedName(file.name), mime: image ?? "application/octet-stream", size: file.bytes.length, image: image !== null })
      .returning();
    rows.push(row!);
  }
  for (const [i, row] of rows.entries()) {
    const dir = ownerDir(filesDir, row.ownerId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Complete before its name exists: a reader never sees half a file.
    await writeFile(join(dir, `${row.id}.tmp`), files[i]!.bytes, { flag: "wx", mode: 0o600 });
    await rename(join(dir, `${row.id}.tmp`), join(dir, row.id));
  }
  return rows;
}

const overQuota = (err: unknown) => {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e.code === "P0D02" || e.cause?.code === "P0D02";
};

/** Runs `store` in a transaction; a refusal of the organization's limit becomes the person's message. */
async function storeOrRefuse<T>(db: Db, workspaceId: string, store: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(store);
  } catch (err) {
    if (!overQuota(err)) throw err;
    counts.counter("dispand.attachments.refused").add(1, { "dispand.attachment.limit": "install" });
    throw new ORPCError("BAD_REQUEST", message("data.file.installFull", { limit: (await filesLimitOf(db, workspaceId)) ?? 0 }));
  }
}

/** The organization's limit on all its files, in MiB; null: no limit. */
export async function filesLimitOf(db: Db | Tx, workspaceId: string): Promise<number | null> {
  const [row] = await db.select({ bytes: organizations.filesQuotaBytes }).from(workspaces).innerJoin(organizations, eq(organizations.id, workspaces.organizationId)).where(eq(workspaces.id, workspaceId));
  return row?.bytes == null ? null : Math.round(row.bytes / MIB);
}

/**
 * The files a Job keeps. A Job's file stays counted once a table takes it (its `jobId` stays).
 * Every file a Job holds is an attachment row with its `jobId`, whatever it came from, so a new
 * source counts here by storing its files that way.
 */
async function totals(tx: Tx, jobId: string): Promise<{ jobFiles: number; jobBytes: number }> {
  const [job] = await tx.select({ n: count(), bytes: sql<string>`coalesce(sum(${attachments.size}), 0)` }).from(attachments).where(eq(attachments.jobId, jobId));
  return { jobFiles: job?.n ?? 0, jobBytes: Number(job?.bytes ?? 0) };
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
  return null;
}

/**
 * The files of a tool's result, kept as attachments of the Job that called it (with the same
 * sniffing as uploads), and the result's text telling the agent their ids in place of the bytes.
 * All or none: a result that passes a limit (a file over 10 MiB, more than 20 files, the Job's
 * totals or the organization's) keeps none of its files, and the text says why. The Job can then write
 * them in a file field (`writeRow`). `source` names where they came from, for the metrics.
 */
export async function keepJobFiles(db: Db, filesDir: string, job: { ownerId: string; runId: string }, result: ToolResult, source: "tool" | "runner-tool" = "tool"): Promise<ToolResult> {
  const { files, ...rest } = result;
  if (!files?.length) return rest;
  const [run] = await db.select({ workspaceId: runs.workspaceId }).from(runs).where(eq(runs.id, job.runId));
  const workspaceId = run!.workspaceId;
  const outcome = await db.transaction(async (tx) => {
    await lockJobFiles(tx, job.runId);
    const refused = await refusal(tx, job, files.map((f) => ({ name: storedName(f.name), size: f.bytes.length })));
    if (refused) return refused;
    return storeAttachments(tx, filesDir, files.map((f) => ({ ownerId: job.ownerId, workspaceId, jobId: job.runId, name: f.name, bytes: f.bytes })));
  }).catch(async (err: unknown) => {
    if (!overQuota(err)) throw err;
    const limit = await filesLimitOf(db, workspaceId);
    return { limit: "install" as const, text: `None of the files in this result were kept: with them, Dispand's files would pass ${limit} MiB, the most this organization keeps (a setting of its owner).` };
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

export const files = { upload, hold };

/**
 * Of these attachment ids, the ones that are attachments of this table of the workspace, locked
 * `FOR SHARE` so the sweep can't remove them before the write that uses them commits. A Job
 * writing (`actor`) may also use the files its tools returned that no table has yet (`adopt`,
 * locked `FOR UPDATE`): the write gives them to this table (`adoptAttachments`) once it is sure to
 * happen. Any other file (another table's, another Job's) isn't found.
 */
export async function lockAttachments(tx: Tx, workspaceId: string, tableId: string, ids: string[], actor?: EventActor): Promise<{ known: Set<string>; adopt: string[] }> {
  if (ids.length === 0) return { known: new Set(), adopt: [] };
  const found = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(inArray(attachments.id, ids), eq(attachments.workspaceId, workspaceId), eq(attachments.tableId, tableId)))
    .for("share");
  const adopt =
    actor?.type === "job"
      ? await tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(and(inArray(attachments.id, ids), eq(attachments.workspaceId, workspaceId), eq(attachments.jobId, actor.runId), isNull(attachments.tableId)))
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

/** Other Job readers can download only a file attached to a person's committed transcript message. */
export async function openAttachment(db: Db, filesDir: string, userId: string, id: string) {
  // The file's workspace, under SYSTEM; the person's membership there, then the read in its scope.
  const [placed] = await inScope(SYSTEM, () => db.select({ organizationId: workspaces.organizationId, workspaceId: workspaces.id }).from(attachments)
    .innerJoin(workspaces, eq(workspaces.id, attachments.workspaceId)).where(eq(attachments.id, id)));
  return asMember(db, userId, placed, () => readAttachment(db, filesDir, userId, id));
}

async function readAttachment(db: Db, filesDir: string, userId: string, id: string) {
  const [row] = await db.select({ file: attachments }).from(attachments)
    .leftJoin(runs, and(eq(runs.id, attachments.jobId), eq(runs.ownerId, attachments.ownerId)))
    .where(and(eq(attachments.id, id), or(
      and(eq(attachments.ownerId, userId), or(isNull(attachments.jobId), isNotNull(attachments.tableId))),
      and(isNull(attachments.tableId), readableRun({ db, ownerId: userId }), or(eq(attachments.ownerId, userId), inUserMessage)),
    )));
  if (!row || (row.file.tableId !== null && !await hasLegacyWorkspaceAccess({ db, ownerId: userId }))) return null;
  return streamAttachment(filesDir, row.file);
}

async function streamAttachment(filesDir: string, found: typeof attachments.$inferSelect) {
  try {
    const handle = await open(join(ownerDir(filesDir, found.ownerId), found.id));
    const body = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
    return { body, name: found.name, mime: found.mime, size: found.size, image: found.image };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * A chat attachment as `GET RUNNER_ATTACHMENTS_PATH/<id>` sends it to a runner: only a file of
 * the runner's workspace that a message of its Job carries (`takeChatFiles`), that Job having a
 * session on that runner; null
 * (404) for anything else, so a runner learns nothing about other files.
 */
export async function attachmentForRunner(db: Db, filesDir: string, runnerId: string, id: string) {
  const [found] = await db
    .select({ file: attachments })
    .from(attachments)
    .innerJoin(stepRuns, and(eq(stepRuns.runId, attachments.jobId), eq(stepRuns.runnerId, runnerId)))
    .innerJoin(runs, and(eq(runs.id, stepRuns.runId), eq(runs.workspaceId, attachments.workspaceId)))
    .innerJoin(runners, and(eq(runners.id, stepRuns.runnerId), eq(runners.workspaceId, runs.workspaceId)))
    .where(and(eq(attachments.id, id), inMessage))
    .limit(1);
  return found ? streamAttachment(filesDir, found.file) : null;
}

/** The bytes of these files of the workspace, by id: a file gone (swept, its Job deleted) is missing. */
export async function attachmentBytes(db: Db, filesDir: string, workspaceId: string, ids: string[]): Promise<Map<string, Uint8Array>> {
  const found = ids.length === 0 ? [] : await db.select({ id: attachments.id, ownerId: attachments.ownerId }).from(attachments).where(and(inArray(attachments.id, ids), eq(attachments.workspaceId, workspaceId)));
  const bytes = new Map<string, Uint8Array>();
  for (const { id, ownerId } of found) {
    try {
      bytes.set(id, await readFile(join(ownerDir(filesDir, ownerId), id)));
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }
  return bytes;
}

/** Some cell of the attachment's table holds its id. */
const referenced = sql`exists (select 1 from ${rowsTable} where ${rowsTable.tableId} = ${attachments.tableId}
  and jsonb_path_exists(${rowsTable.values}, '$.*[*] ? (@ == $id)', jsonb_build_object('id', ${attachments.id})))`;

/** A message of the attachment's Job carries it: the chat's history reads it at every turn. */
const carriesFile = sql`${messages.runId} = ${attachments.jobId}
  and ${messages.files} @> jsonb_build_array(jsonb_build_object('id', ${attachments.id}))`;
const inMessage = sql`exists (select 1 from ${messages} where ${carriesFile})`;
const inUserMessage = sql`exists (select 1 from ${messages} where ${carriesFile} and ${messages.role} = 'user')`;

/**
 * What the sweep removes, `cutoff` being an hour ago and `heldCutoff` a day ago: a table's file no
 * row of it references and no message carries, past an hour; a Job's file no table took and no message of it carries, an
 * hour after the Job ended (a chat's files stay with their Job, which a new message reopens); a
 * file of no table and no Job (held for a chat message never sent, or its Job deleted), a day
 * after it came.
 */
const unused = (cutoff: Date, heldCutoff: Date) =>
  sql`((${attachments.tableId} is not null and ${attachments.createdAt} < ${cutoff} and not ${referenced} and not ${inMessage})
    or (${attachments.tableId} is null and ${attachments.jobId} is null and ${attachments.createdAt} < ${heldCutoff})
    or (${attachments.tableId} is null and not ${inMessage} and exists (select 1 from ${runs} where ${runs.id} = ${attachments.jobId} and ${runs.finishedAt} < ${cutoff})))`;

/**
 * The workspaces with an attachment the sweep may remove, read under SYSTEM from ids and times
 * only: past the grace, or of a Job that ended before it. Every `unused` attachment is one of
 * them; whether it is unused (its cells, its messages) is read in its workspace's pass.
 */
export async function sweepScopes(db: Db, now: Date): Promise<Scope[]> {
  const cutoff = new Date(now.getTime() - GRACE_MS);
  const old = or(lt(attachments.createdAt, cutoff), sql`exists (select 1 from ${runs} where ${runs.id} = ${attachments.jobId} and ${runs.finishedAt} < ${cutoff})`);
  return inScope(SYSTEM, () => db.selectDistinct({ organizationId: workspaces.organizationId, workspaceId: workspaces.id }).from(attachments)
    .innerJoin(workspaces, eq(workspaces.id, attachments.workspaceId)).where(old));
}

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
  const heldCutoff = new Date(now.getTime() - HELD_MS);
  // The rows per workspace (`eachScope`); once, as is, on a single-tenant database.
  const gone: { id: string; ownerId: string }[] = [];
  await eachScope(db, (db) => sweepScopes(db, now), async () => {
    gone.push(
      ...(await db.transaction(async (tx) => {
        // Locked first, skipping any a write holds: that write may be about to reference it. Checked
        // again in a later statement, which sees every write that committed before the lock.
        const candidates = await tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(unused(cutoff, heldCutoff))
          .for("update", { skipLocked: true });
        if (candidates.length === 0) return [];
        return tx
          .delete(attachments)
          .where(and(inArray(attachments.id, candidates.map((c) => c.id)), unused(cutoff, heldCutoff)))
          .returning({ id: attachments.id, ownerId: attachments.ownerId });
      })),
    );
  });
  for (const a of gone) await rm(join(ownerDir(filesDir, a.ownerId), a.id), { force: true });

  // The files on disk once, for every workspace: their ids are checked under SYSTEM, so a pass
  // limited to one workspace never takes another's files for orphans.
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
    const known = new Set((await inScope(SYSTEM, () => db.select({ id: attachments.id }).from(attachments).where(inArray(attachments.id, old)))).map((a) => a.id));
    for (const name of old.filter((n) => !known.has(n))) {
      await unlink(join(dir, name)).catch((err: unknown) => (missing(err) ? undefined : Promise.reject(err)));
      orphans++;
    }
  }
  if (gone.length + orphans > 0) counts.counter("dispand.attachments.swept").add(gone.length + orphans);
  return { removed: gone.length + orphans };
}
