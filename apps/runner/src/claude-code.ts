// The runner's images don't ship Claude Code: the supervisor installs the version its lockfile
// pins from npm at its first start, onto its state volume, and binds that folder read-only into
// every worker (`sandbox/worker.ts`).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** Where the image keeps Claude Code's `package.json` and lockfile (`apps/runner/clis/claude-code`). */
export const CLAUDE_CODE_LOCK = "/opt/dispand-clis/claude-code";
/** Where a worker finds it: `claude` on the worker image's PATH links into this folder. */
export const WORKER_CLAUDE_CODE = "/opt/claude-code";

/** The installed Claude Code, in the supervisor's state directory. */
export function claudeCodeDir(stateDir: string): string {
  return join(stateDir, "clis", "claude-code");
}

/**
 * Installs the pinned Claude Code into `claudeCodeDir(stateDir)` unless that lockfile is already
 * installed there. Another pin's install goes first: a failed update leaves no Claude Code rather
 * than an older one. `npm ci` checks every package against the lockfile's integrity hash; the
 * folder gets its final name only once that passed, so a half install is never used.
 */
export async function installClaudeCode(stateDir: string, from = CLAUDE_CODE_LOCK, npm = "npm"): Promise<"installed" | "present"> {
  const dest = claudeCodeDir(stateDir);
  const lock = await readFile(join(from, "package-lock.json"));
  const installed = await readFile(join(dest, "package-lock.json")).catch(() => undefined);
  if (installed?.equals(lock) && existsSync(join(dest, "node_modules", ".bin", "claude"))) return "present";
  await rm(dest, { recursive: true, force: true });
  const parent = join(stateDir, "clis");
  await mkdir(parent, { recursive: true, mode: 0o755 });
  // What an install cut short left behind.
  for (const name of await readdir(parent)) if (name.startsWith(".claude-code-")) await rm(join(parent, name), { recursive: true, force: true });
  const work = await mkdtemp(join(parent, ".claude-code-"));
  const cache = await mkdtemp(join(tmpdir(), "dispand-npm-"));
  try {
    await Promise.all(["package.json", "package-lock.json"].map((f) => copyFile(join(from, f), join(work, f))));
    await promisify(execFile)(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--cache", cache], { cwd: work, timeout: 600_000 });
    await rename(work, dest);
    return "installed";
  } finally {
    await Promise.all([work, cache].map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

let installing: Promise<void> | undefined;

/**
 * The image supervisor's install: started when it starts, joined (or tried again) at each CLI
 * detection, which waits for it at most `waitMs` so a stalled registry holds up nothing else.
 * One at a time, logged, never thrown.
 */
export function ensureClaudeCode(stateDir: string, waitMs = 0): Promise<void> {
  installing ??= installClaudeCode(stateDir)
    .then(
      (done) => void (done === "installed" && console.log("dispand-runner: installed Claude Code")),
      (err: unknown) => console.error(`dispand-runner: can't install Claude Code, its sessions will fail until it is: ${(err as Error).message}`),
    )
    .finally(() => (installing = undefined));
  return Promise.race([installing, new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref())]);
}
