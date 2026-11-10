import { lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStart } from "@dispand/runner-protocol";
import { isConfigPath, realOf } from "./boundary.ts";
import { overlapping, type RunnerConfig } from "./config.ts";

/** Where plan mode writes its plans, relative to the run folder: inside it, not under `.claude`, so the boundary allows it. */
export const PLANS_ROOT = ".dispand";
export const PLANS_DIR = `${PLANS_ROOT}/plans`;

/** The server asked for a folder the runner won't give a session. */
export class WorkdirRefused extends Error {
  override name = "WorkdirRefused";
}

/**
 * The folder a session runs in: a fresh `<roots[0]>/runs/<runKey>` (the protocol keeps the key to
 * one path segment), refused if it exists already. Resuming a CLI session reuses the folder it
 * ran in (its transcript is filed under that path). The path from the root to the folder holds
 * no symlink: the runner makes `runs` itself, a real directory, and the folder's real path must
 * be exactly `<real root>/runs/<runKey>`. The root must keep the machine's config out
 * (`machineConfigPaths`, `isConfigPath`).
 */
export async function resolveWorkdir(
  config: RunnerConfig,
  cwd: SessionStart["cwd"],
  forbidden: string[] = [],
  resuming = false,
): Promise<string> {
  const root = realOf(config.roots[0]!);
  if (isConfigPath(root)) throw new WorkdirRefused(`${root} is a project's .claude or .mcp.json, or inside one`);
  const clash = overlapping(root, forbidden);
  if (clash) throw new WorkdirRefused(`${root} must not contain or be inside ${clash}`);
  const runs = join(root, "runs");
  const dir = join(runs, cwd.runKey);
  const runsEntry = lstatOrNull(runs);
  if (runsEntry && !runsEntry.isDirectory()) throw new WorkdirRefused(`${runs} must be a real directory, not a symlink or a file`);
  // Its real path is exactly where it is named: no symlink on the way.
  const exact = () => {
    if (realOf(dir) !== dir) throw new WorkdirRefused(`${dir} must be a real directory under ${runs}, with no symlink on the way`);
  };
  if (resuming) {
    if (!lstatOrNull(dir)?.isDirectory()) throw new WorkdirRefused(`${dir} is not a directory: nothing to resume in`);
    exact();
    // Made by an older runner without it, or removed: only where nothing (not even a link) is.
    if (!lstatOrNull(join(dir, PLANS_ROOT))) await mkdir(join(dir, PLANS_DIR), { recursive: true });
    return dir;
  }
  // Only the runner's user can see into the folders.
  if (!runsEntry) await mkdir(runs, { recursive: true, mode: 0o700 });
  // Not recursive: fails if the folder exists, even if it appeared since the checks above.
  await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
    throw new WorkdirRefused(err.code === "EEXIST" ? `${dir} already exists: sessions start in a new folder` : `${dir}: ${err.code}`);
  });
  // `runs` may have been swapped for a symlink in between: check where the folder really is.
  exact();
  await mkdir(join(dir, PLANS_DIR), { recursive: true });
  return dir;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
