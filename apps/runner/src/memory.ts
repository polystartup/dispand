import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { MemoryFile } from "@dispand/runner-protocol";
import { unlock } from "./skills.ts";
import { PLANS_ROOT } from "./workdir.ts";

/**
 * A Job's memory, as files its session reads with its file tools: under the run folder's
 * `.dispand/memory/<scope>/<path>`, outside every folder a CLI loads settings from, and never
 * under a name a CLI loads as instructions (`isMemoryPath`). Written again at every start or
 * resume, so a session reads memory as Dispand sent it last.
 */

/** Where the files go, relative to the run folder. */
export const MEMORY_DIR = `${PLANS_ROOT}/memory`;

/** Why a session's memory files couldn't be written: the session doesn't start. */
export class MemoryRefused extends Error {
  override name = "MemoryRefused";
}

/**
 * Writes `files` under `<runDir>/.dispand/memory`, emptied first. Every scope and path is checked
 * again (`MemoryFile`, so `isMemoryPath`) before anything is written; `.dispand` must be a real
 * folder, and every folder below it is made here, so none is a link. Files are created with `wx`
 * and `O_NOFOLLOW`, then made 0444. A file whose place is already taken (an entry `a.md` beside
 * `a.md/b.md`, or two paths one file system doesn't tell apart by case) is left out: the session
 * still reads it with `memory_read`. Without files, nothing is made.
 */
export async function writeMemoryFiles(runDir: string, files: MemoryFile[]): Promise<void> {
  for (const file of files) {
    if (!MemoryFile.safeParse(file).success) throw new MemoryRefused("a memory file has an unsafe path");
  }
  const root = join(runDir, PLANS_ROOT);
  const entry = await lstat(root).catch(() => null);
  if (!entry?.isDirectory()) throw new MemoryRefused(`${root} must be a real directory`);
  const dir = join(runDir, MEMORY_DIR);
  await unlock(dir);
  await rm(dir, { recursive: true, force: true });
  if (files.length === 0) return;
  await mkdir(dir, { mode: 0o700 });
  const folder = async (path: string): Promise<boolean> => {
    await mkdir(path, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    return (await lstat(path)).isDirectory();
  };
  for (const file of files) {
    const segments = [...file.scope.split("/"), ...file.path.split("/")];
    let at = dir;
    let placed = true;
    for (const segment of segments.slice(0, -1)) {
      at = join(at, segment);
      if (!(await folder(at))) {
        placed = false;
        break;
      }
    }
    if (!placed) continue;
    const path = join(at, segments.at(-1)!);
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(file.text);
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new MemoryRefused(`a memory file couldn't be written (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    await chmod(path, 0o444);
  }
}
