import { ORPCError } from "@orpc/server";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { attachments, rows as rowsTable, tables as tablesTable } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";

// Files of attachment cells. Each one is `<filesDir>/<ownerId>/<attachmentId>`: both ids are made
// by the server, so nothing an upload says reaches the path. Whether a file is an image comes
// from its first bytes only, never from its name or the type the browser sent; only those
// images are ever served inline (see `apps/web/src/server/files.ts`).

const owner = base.use(authed);

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** An upload or an orphan file is kept this long before the sweep may remove it. */
const GRACE_MS = 3600_000;

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
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const image = detectImage(bytes);
  const id = newId("att");
  const dir = ownerDir(context.filesDir, context.ownerId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Complete before its name exists: a reader never sees half a file. A failure past this point
  // leaves a file without a row, which the sweep removes.
  await writeFile(join(dir, `${id}.tmp`), bytes, { flag: "wx", mode: 0o600 });
  await rename(join(dir, `${id}.tmp`), join(dir, id));
  const [row] = await context.db
    .insert(attachments)
    .values({ id, ownerId: context.ownerId, tableId: table.id, name: storedName(input.file.name), mime: image ?? "application/octet-stream", size: bytes.length, image: image !== null })
    .returning();
  return attachmentView(row!);
});

export const files = { upload };

/**
 * Of these attachment ids, the ones that are attachments of this owner's table, locked
 * `FOR SHARE` so the sweep can't remove them before the write that uses them commits.
 */
export async function lockAttachments(tx: Tx, ownerId: string, tableId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const found = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(inArray(attachments.id, ids), eq(attachments.ownerId, ownerId), eq(attachments.tableId, tableId)))
    .for("share");
  return new Set(found.map((a) => a.id));
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

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Removes what no cell uses any more, past an hour: attachment rows no row of their table
 * references (a cell cleared, a field deleted or retyped, an upload never saved), then their
 * files, then files with no attachment row at all (a deleted table's, an interrupted upload's).
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
      .where(and(lt(attachments.createdAt, cutoff), sql`not ${referenced}`))
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    return tx
      .delete(attachments)
      .where(and(inArray(attachments.id, candidates.map((c) => c.id)), sql`not ${referenced}`))
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
  return { removed: gone.length + orphans };
}
