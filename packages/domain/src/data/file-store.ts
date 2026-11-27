import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

// Where attachment bytes live. The store holds bytes under keys the domain chooses (the
// attachment's owner id and its id, both made by the server); the `attachments` rows stay the
// record of which file exists, who may read it and its workspace, and nothing reads the store
// without checking the row first (`data/files.ts`). The default keeps them on local disk; an
// install whose app processes run on several hosts passes `buildApp` one they all reach.

/** A stored file as the sweep lists it: its owner id, and its name in the store. */
export type StoredFile = { ownerId: string; name: string };

export type FileStore = {
  /** Stores the bytes, complete before they can be read: a reader never sees half a file. */
  put(ownerId: string, id: string, bytes: Uint8Array): Promise<void>;
  /** The file as a stream; null when it isn't there. */
  stream(ownerId: string, id: string): Promise<ReadableStream<Uint8Array> | null>;
  /** The file's bytes; null when it isn't there. */
  read(ownerId: string, id: string): Promise<Uint8Array | null>;
  /** Removes a file by an attachment id or a name `list` gave; one already gone is no error. */
  delete(ownerId: string, name: string): Promise<void>;
  /**
   * The files stored before `before`, for the sweep, which removes those no attachment row names.
   * A name is an attachment id or what a write that didn't finish left (`<id>.tmp` on disk).
   */
  list(before: Date): AsyncIterable<StoredFile>;
};

/** The promise's value; null when the file or directory isn't there. */
const ifThere = <T>(p: Promise<T>): Promise<T | null> =>
  p.catch((err: unknown) => ((err as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(err)));

/** The files on local disk: `<dir>/<ownerId>/<id>`, directories 0700 and files 0600. */
export function localFiles(dir: string): FileStore {
  const ownerDir = (ownerId: string) => join(dir, ownerId);
  return {
    async put(ownerId, id, bytes) {
      await mkdir(ownerDir(ownerId), { recursive: true, mode: 0o700 });
      // Complete before its name exists: written under a temp name, then renamed.
      const temp = join(ownerDir(ownerId), `${id}.tmp`);
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await rename(temp, join(ownerDir(ownerId), id));
    },
    async stream(ownerId, id) {
      // Opened before it resolves, so a missing file is null rather than an error mid-response.
      const handle = await ifThere(open(join(ownerDir(ownerId), id)));
      return handle && (Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>);
    },
    read: (ownerId, id) => ifThere(readFile(join(ownerDir(ownerId), id))),
    async delete(ownerId, name) {
      await rm(join(ownerDir(ownerId), name), { force: true });
    },
    async *list(before) {
      for (const ownerId of (await ifThere(readdir(dir))) ?? []) {
        for (const name of (await ifThere(readdir(ownerDir(ownerId)))) ?? []) {
          const info = await ifThere(stat(join(ownerDir(ownerId), name)));
          if (info?.isFile() && info.mtime < before) yield { ownerId, name };
        }
      }
    },
  };
}
