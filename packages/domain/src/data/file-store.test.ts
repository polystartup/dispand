import { call } from "@orpc/server";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { router } from "../rpc/router.ts";
import { jobIdentity, ownerContext } from "../runners/test-support.ts";
import { localFiles, type FileStore, type StoredFile } from "./file-store.ts";
import { attachmentBytes, keepJobFiles, openAttachment, sweepAttachments } from "./files.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const HOUR = 3600_000;

/** A store in memory: what another store (an object store) must do, through the same interface. */
function memoryFiles(): FileStore {
  const stored = new Map<string, { file: StoredFile; bytes: Uint8Array; at: Date }>();
  const key = (ownerId: string, name: string) => JSON.stringify([ownerId, name]);
  return {
    async put(ownerId, id, bytes) {
      stored.set(key(ownerId, id), { file: { ownerId, name: id }, bytes: bytes.slice(), at: new Date() });
    },
    async stream(ownerId, id) {
      const found = stored.get(key(ownerId, id));
      return found ? new Blob([found.bytes as Uint8Array<ArrayBuffer>]).stream() : null;
    },
    async read(ownerId, id) {
      return stored.get(key(ownerId, id))?.bytes ?? null;
    },
    async delete(ownerId, name) {
      stored.delete(key(ownerId, name));
    },
    async *list(before) {
      for (const { file, at } of [...stored.values()]) if (at < before) yield file;
    },
  };
}

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "dispand-store-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const listed = async (store: FileStore, before: Date) => {
  const files: StoredFile[] = [];
  for await (const f of store.list(before)) files.push(f);
  return files.sort((a, b) => a.name.localeCompare(b.name));
};

test.each([
  ["on local disk", async () => localFiles(await tempDir())],
  ["in memory", async () => memoryFiles()],
])("a store %s puts, streams, reads, lists and deletes files by owner and id", async (_, make) => {
  const store = await make();
  const later = new Date(Date.now() + HOUR);
  expect(await store.read("usr_a", "att_1")).toBeNull();
  expect(await store.stream("usr_a", "att_1")).toBeNull();
  expect(await listed(store, later)).toEqual([]);
  await store.put("usr_a", "att_1", PNG);
  await store.put("usr_a", "att_2", Uint8Array.from([1]));
  await store.put("usr_b", "att_3", Uint8Array.from([2]));
  // A Uint8Array (on disk, a Buffer): compared as bytes.
  const read = await store.read("usr_a", "att_1");
  expect(read).toBeInstanceOf(Uint8Array);
  expect(new Uint8Array(read!)).toEqual(PNG);
  expect(new Uint8Array(await new Response(await store.stream("usr_a", "att_1")).arrayBuffer())).toEqual(PNG);
  // Another owner's key is another file.
  expect(await store.read("usr_b", "att_1")).toBeNull();
  expect(await listed(store, later)).toEqual([
    { ownerId: "usr_a", name: "att_1" },
    { ownerId: "usr_a", name: "att_2" },
    { ownerId: "usr_b", name: "att_3" },
  ]);
  // Only files stored before the time given.
  expect(await listed(store, new Date(Date.now() - HOUR))).toEqual([]);
  await store.delete("usr_a", "att_1");
  await store.delete("usr_a", "att_1");
  expect(await store.read("usr_a", "att_1")).toBeNull();
  expect((await listed(store, later)).map((f) => f.name)).toEqual(["att_2", "att_3"]);
});

test("the local store keeps today's layout: <dir>/<ownerId>/<id>, directories 0700 and files 0600, no temp file left", async () => {
  const dir = await tempDir();
  const store = localFiles(dir);
  await store.put("usr_a", "att_1", PNG);
  expect(await readdir(join(dir, "usr_a"))).toEqual(["att_1"]);
  expect((await stat(join(dir, "usr_a"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(dir, "usr_a", "att_1"))).mode & 0o777).toBe(0o600);
  // What an interrupted write left is listed for the sweep, by its name.
  await writeFile(join(dir, "usr_a", "att_2.tmp"), "x");
  expect((await listed(store, new Date(Date.now() + HOUR))).map((f) => f.name)).toEqual(["att_1", "att_2.tmp"]);
});

test("the file suite runs through any store: upload, download, a Job's files, their bytes and the sweep", async () => {
  const store = memoryFiles();
  const context = { ...(await ownerContext()), files: store };
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const logo = await call(router.fields.create, { tableId: table.id, name: "Logo", type: "attachment" }, { context });
  const upload = (name: string) => call(router.files.upload, { tableId: table.id, file: new File([PNG], name) }, { context });
  const [kept, dropped] = [await upload("kept.png"), await upload("dropped.png")];
  await call(router.rows.create, { tableId: table.id, values: { [logo.id]: [kept.id] } }, { context });

  const opened = await openAttachment(context.db, store, context.ownerId, kept.id);
  expect(opened).toMatchObject({ name: "kept.png", mime: "image/png", image: true });
  expect(new Uint8Array(await new Response(opened!.body).arrayBuffer())).toEqual(PNG);

  const job = await jobIdentity(context);
  const result = await keepJobFiles(context.db, store, job, { text: "", isError: false, files: [{ name: "out.png", bytes: PNG }] });
  const [jobFile] = /attachment (att_\w+)/.exec(result.text)!.slice(1);
  const bytes = await attachmentBytes(context.db, store, context.workspaceId, [kept.id, jobFile!, "att_none"]);
  expect([...bytes.keys()].sort()).toEqual([kept.id, jobFile!].sort());

  // Bytes no row names: a deleted table's, and an interrupted write's.
  await store.put(context.ownerId, "att_orphan", PNG);
  await store.put(context.ownerId, "att_left.tmp", PNG);
  expect(await sweepAttachments(context.db, store, new Date(Date.now() + 2 * HOUR))).toEqual({ removed: 3 });
  expect(await store.read(context.ownerId, dropped.id)).toBeNull();
  expect((await listed(store, new Date(Date.now() + 2 * HOUR))).map((f) => f.name).sort()).toEqual([kept.id, jobFile!].sort());
});

// Attachment bytes go through the store: no module but the local store reads or writes them on
// disk. Where `filesDir` may still appear, and why; a new place fails until it is listed.
const ROOT = join(import.meta.dirname, "../../../..");
const FILES_DIR: Record<string, string> = {
  "apps/web/src/server/config.ts": "reads DISPAND_FILES_DIR into the config",
  "apps/web/src/server/app.ts": "builds the default store on it",
  "packages/domain/src/runners/test-support.ts": "tests' store on a temp directory, which they also read on disk",
  "packages/domain/src/db/upgrade-fixture.ts": "seeds the files an earlier version left on local disk",
};

/** The modules that store, serve or read attachments' bytes, through the store only. */
const ATTACHMENT_MODULES = [
  "packages/domain/src/data/files.ts",
  "packages/domain/src/cloud/runner.ts",
  "packages/domain/src/engine/cli-harness.ts",
  "packages/domain/src/platform/job-files.ts",
  "packages/domain/src/platform/tools-mcp.ts",
  "packages/domain/src/runners/attachments.ts",
  "packages/domain/src/tools/cloud.ts",
  "apps/web/src/server/files.ts",
];

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "node_modules"
        ? []
        : sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

test("filesDir appears only where it is listed, and the attachment module reads no file itself", () => {
  const found = [...sources(join(ROOT, "packages/domain/src")), ...sources(join(ROOT, "apps/web/src"))]
    .filter((f) => /\bfilesDir\b/.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  expect(found.sort()).toEqual(Object.keys(FILES_DIR).sort());
  for (const f of ATTACHMENT_MODULES) expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/from "node:fs/);
});
