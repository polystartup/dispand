import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryFile } from "@dispand/runner-protocol";
import { afterEach, expect, test } from "vitest";
import { MEMORY_DIR, MemoryRefused, writeMemoryFiles } from "./memory.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A run folder as `resolveWorkdir` leaves it: with its `.dispand` folder. */
async function runDir() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "memory-")));
  made.push(dir);
  await mkdir(join(dir, ".dispand", "plans"), { recursive: true });
  return dir;
}

const file = (scope: string, path: string, text = `${scope}/${path}`): MemoryFile => ({ scope, path, text });

test("each file lands read-only at .dispand/memory/<scope>/<path>, and the folder is emptied first", async () => {
  const dir = await runDir();
  const longest = `${"n/".repeat(9)}${"b".repeat(99)}.md`;
  expect(longest).toHaveLength(120);
  await writeMemoryFiles(dir, [file("workspace", "MEMORY.md"), file("agent", "notes/habits.md"), file("tables/tbl_01J", longest)]);
  const memory = join(dir, MEMORY_DIR);
  expect(await readFile(join(memory, "workspace", "MEMORY.md"), "utf8")).toBe("workspace/MEMORY.md");
  expect(await readFile(join(memory, "agent", "notes", "habits.md"), "utf8")).toBe("agent/notes/habits.md");
  expect(await readFile(join(memory, "tables", "tbl_01J", longest), "utf8")).toBe(`tables/tbl_01J/${longest}`);
  expect((await lstat(join(memory, "agent", "notes", "habits.md"))).mode & 0o777).toBe(0o444);

  // Written again: only what this start carries.
  await writeMemoryFiles(dir, [file("agent", "MEMORY.md", "now")]);
  expect(await readdir(memory)).toEqual(["agent"]);
  expect(await readFile(join(memory, "agent", "MEMORY.md"), "utf8")).toBe("now");
  // None: no folder at all.
  await writeMemoryFiles(dir, []);
  expect(await readdir(join(dir, ".dispand"))).toEqual(["plans"]);
});

test("a path a CLI loads as instructions, or outside its scope, is refused before anything is written", async () => {
  const dir = await runDir();
  for (const path of ["CLAUDE.md", "notes/claude.md", "x/AGENTS.override.md", ".claude/x.md", "../x.md", "/x.md", "a//b.md", "a\\b.md", "x.txt", `${"c".repeat(118)}.md`]) {
    await expect(writeMemoryFiles(dir, [file("agent", "MEMORY.md"), file("agent", path)]), path).rejects.toThrow(MemoryRefused);
  }
  for (const scope of ["tables/../..", "tables/a/b", "..", ".claude"]) {
    await expect(writeMemoryFiles(dir, [file(scope, "x.md")]), scope).rejects.toThrow(MemoryRefused);
  }
  expect(await readdir(join(dir, ".dispand"))).toEqual(["plans"]);
});

test("a .dispand that isn't a real folder is refused, and nothing is written where it leads", async () => {
  const dir = await runDir();
  const elsewhere = join(dir, "elsewhere");
  await mkdir(join(elsewhere, "memory"), { recursive: true });
  await writeFile(join(elsewhere, "memory", "keep.txt"), "kept");
  await rm(join(dir, ".dispand"), { recursive: true });
  await symlink(elsewhere, join(dir, ".dispand"));
  await expect(writeMemoryFiles(dir, [file("agent", "MEMORY.md")])).rejects.toThrow(MemoryRefused);
  expect(await readdir(join(elsewhere, "memory"))).toEqual(["keep.txt"]);
});

test("a link left in the memory folder is removed, never followed", async () => {
  const dir = await runDir();
  const elsewhere = join(dir, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "keep.txt"), "kept");
  await mkdir(join(dir, MEMORY_DIR));
  await symlink(elsewhere, join(dir, MEMORY_DIR, "agent"));
  await writeMemoryFiles(dir, [file("agent", "MEMORY.md")]);
  expect((await lstat(join(dir, MEMORY_DIR, "agent"))).isDirectory()).toBe(true);
  expect(await readdir(elsewhere)).toEqual(["keep.txt"]);
});

test("a file whose place is taken by another is left out, and the rest written", async () => {
  const dir = await runDir();
  await writeMemoryFiles(dir, [file("agent", "a.md"), file("agent", "a.md/b.md"), file("agent", "c.md")]);
  expect((await readdir(join(dir, MEMORY_DIR, "agent"))).sort()).toEqual(["a.md", "c.md"]);
  expect((await lstat(join(dir, MEMORY_DIR, "agent", "a.md"))).isFile()).toBe(true);
});
