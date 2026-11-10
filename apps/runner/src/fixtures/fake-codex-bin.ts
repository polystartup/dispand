// Test helper: an executable `codex` that runs `fake-codex.ts`, and the log of what it received.
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** A fresh fake `codex` in its own folder, pushed onto `made` for removal; `env` configures it (see `fake-codex.ts`). */
export async function fakeCodex(made: string[], env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fake-codex-"));
  made.push(dir);
  const path = join(dir, "codex");
  const log = join(dir, "log.jsonl");
  await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${resolve("src/fixtures/fake-codex.ts")}" "$@"\n`);
  await chmod(path, 0o755);
  const received = async () =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { path, dir, received, env: { ...process.env, FAKE_CODEX_LOG: log, ...env } };
}
