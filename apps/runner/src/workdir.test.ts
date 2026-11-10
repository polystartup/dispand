import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { RunnerConfig } from "./config.ts";
import { resolveWorkdir, WorkdirRefused } from "./workdir.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A scratch directory holding a root and, next to it, a directory outside the root. */
async function setup() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "workdir-")));
  made.push(base);
  const root = join(base, "root");
  await mkdir(join(root, "repo"), { recursive: true });
  await mkdir(join(base, "x"));
  const config: RunnerConfig = { server: "https://dispand.test", roots: [root], allowBypass: false };
  return { base, root, config };
}

const perRun = (runKey: string) => ({ mode: "per-run" as const, runKey });

test("per-run dir is created fresh under the first root", async () => {
  const { root, base, config } = await setup();
  const dir = await resolveWorkdir({ ...config, roots: [root, join(base, "x")] }, perRun("run_01J"));
  expect(dir).toBe(join(root, "runs", "run_01J"));
  expect((await stat(dir)).isDirectory()).toBe(true);
  // Only the runner's user can see into it.
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, "runs"))).mode & 0o777).toBe(0o700);
  // Only the folder plan mode writes to (see claude.ts).
  expect(await readdir(dir)).toEqual([".dispand"]);
  expect((await stat(join(dir, ".dispand", "plans"))).isDirectory()).toBe(true);
});

test("a per-run dir that already exists is refused: every session starts in a new folder", async () => {
  const { root, config } = await setup();
  await mkdir(join(root, "runs", "run_old"), { recursive: true });
  await expect(resolveWorkdir(config, perRun("run_old"))).rejects.toThrow(WorkdirRefused);
});

test("resuming a CLI session reuses its own per-run folder, a real directory in the root", async () => {
  const { root, base, config } = await setup();
  const first = await resolveWorkdir(config, perRun("run_r"));
  expect(await resolveWorkdir(config, perRun("run_r"), [], true)).toBe(first);
  await symlink(join(base, "x"), join(root, "runs", "run_link"));
  await expect(resolveWorkdir(config, perRun("run_link"), [], true)).rejects.toThrow(WorkdirRefused);
  await expect(resolveWorkdir(config, perRun("run_gone"), [], true)).rejects.toThrow(WorkdirRefused);
});

test("refuses a per-run dir that is a symlink out of the root", async () => {
  const { root, base, config } = await setup();
  await mkdir(join(root, "runs"));
  await symlink(join(base, "x"), join(root, "runs", "run_planted"));
  await expect(resolveWorkdir(config, perRun("run_planted"))).rejects.toThrow(WorkdirRefused);
});

test("a per-run dir under a runs symlink out of the root is refused before anything is created", async () => {
  const { root, base, config } = await setup();
  await symlink(join(base, "x"), join(root, "runs"));
  await expect(resolveWorkdir(config, perRun("run_new"))).rejects.toThrow(WorkdirRefused);
  await expect(stat(join(base, "x", "run_new"))).rejects.toThrow();
});

test("a root inside the machine's config, or inside a project's .claude, gets no per-run dir", async () => {
  const { root, base, config } = await setup();
  await expect(resolveWorkdir(config, perRun("run_a"), [root])).rejects.toThrow(WorkdirRefused);
  await mkdir(join(base, "project", ".claude"), { recursive: true });
  await expect(resolveWorkdir({ ...config, roots: [join(base, "project", ".claude")] }, perRun("run_b"))).rejects.toThrow(WorkdirRefused);
  await expect(stat(join(base, "project", ".claude", "runs"))).rejects.toThrow();
});

test("the path from the root to a run folder has no symlink: a runs link inside the root is refused too", async () => {
  const { root, config } = await setup();
  await mkdir(join(root, ".claude", "skills"), { recursive: true });
  await symlink(join(root, ".claude", "skills"), join(root, "runs"));
  await expect(resolveWorkdir(config, perRun("run_new"))).rejects.toThrow(WorkdirRefused);
  await expect(stat(join(root, ".claude", "skills", "run_new"))).rejects.toThrow();
});

test("a runs that is a file is refused", async () => {
  const { root, config } = await setup();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "runs"), "");
  await expect(resolveWorkdir(config, perRun("run_new"))).rejects.toThrow(WorkdirRefused);
});

test("resuming refuses a run folder that is a symlink, even to a folder inside runs", async () => {
  const { root, config } = await setup();
  const real = await resolveWorkdir(config, perRun("run_real"));
  await symlink(real, join(root, "runs", "run_alias"));
  await expect(resolveWorkdir(config, perRun("run_alias"), [], true)).rejects.toThrow(WorkdirRefused);
  expect(await resolveWorkdir(config, perRun("run_real"), [], true)).toBe(real);
});
