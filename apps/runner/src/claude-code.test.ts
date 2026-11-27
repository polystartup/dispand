import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { claudeCodeDir, installClaudeCode } from "./claude-code.ts";

const run = promisify(execFile);
let base: string;
let state: string;
let lock: string;
let npm: string;
/** Serves the packed tarballs, as the registry does. */
let registry: Server;
let url: string;

/** A lockfile for one package (`tiny`, its `claude` bin) from the registry double, as `apps/runner/clis/claude-code` pins Claude Code. */
async function pin(version: string) {
  const pkg = join(base, `tiny-${version}`);
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "tiny", version, bin: { claude: "claude.js" } }));
  await writeFile(join(pkg, "claude.js"), `#!/usr/bin/env node\nconsole.log("${version} (Claude Code)");\n`);
  await run("npm", ["pack", "--silent", "--pack-destination", join(base, "tarballs")], { cwd: pkg });
  await writeFile(join(lock, "package.json"), JSON.stringify({ name: "pin", private: true, dependencies: { tiny: `${url}/tiny-${version}.tgz` } }));
  await run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund", "--cache", join(base, "cache")], { cwd: lock });
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "claude-code-")));
  state = join(base, "state");
  lock = join(base, "lock");
  await mkdir(state);
  await mkdir(lock);
  await mkdir(join(base, "tarballs"));
  registry = createServer((req, res) => {
    readFile(join(base, "tarballs", basename(req.url ?? ""))).then(
      (body) => res.writeHead(200, { "content-type": "application/octet-stream" }).end(body),
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
  // npm, counting its runs; a download that fails its integrity check isn't retried.
  npm = join(base, "npm");
  await writeFile(npm, `#!/bin/sh\necho ran >> "${join(base, "npm-runs")}"\nnpm_config_fetch_retries=0 exec npm "$@"\n`);
  await chmod(npm, 0o755);
});
afterEach(async () => {
  await new Promise((resolve) => registry.close(resolve));
  await rm(base, { recursive: true, force: true });
});

const runs = () =>
  readFile(join(base, "npm-runs"), "utf8").then(
    (s) => s.trim().split("\n").length,
    () => 0,
  );
const version = async () => (await run(join(claudeCodeDir(state), "node_modules", ".bin", "claude"))).stdout.trim();

test("installs the pinned version once, and again only when the lockfile changes", async () => {
  await pin("1.0.0");
  expect(await installClaudeCode(state, lock, npm)).toBe("installed");
  expect(await version()).toBe("1.0.0 (Claude Code)");
  expect(await installClaudeCode(state, lock, npm)).toBe("present");
  expect(await runs()).toBe(1);
  await pin("1.0.1");
  expect(await installClaudeCode(state, lock, npm)).toBe("installed");
  expect(await version()).toBe("1.0.1 (Claude Code)");
  // Only the install: no work folder left beside it.
  expect(await readdir(join(state, "clis"))).toEqual(["claude-code"]);
});

test("a package that doesn't match the lockfile's integrity hash is never installed", async () => {
  await pin("1.0.0");
  const path = join(lock, "package-lock.json");
  const locked = await readFile(path, "utf8");
  await writeFile(path, locked.replace(/"integrity": "sha512-[^"]+"/, `"integrity": "sha512-${"A".repeat(86)}=="`));
  await expect(installClaudeCode(state, lock, npm)).rejects.toThrow(/EINTEGRITY/);
  expect(await readdir(join(state, "clis"))).toEqual([]);
});

test("a failed update leaves no Claude Code rather than the older one, and what an install cut short left is cleared", async () => {
  await pin("1.0.0");
  await installClaudeCode(state, lock, npm);
  await mkdir(join(state, "clis", ".claude-code-cut"));
  // The next pin, whose package the registry no longer has.
  await pin("1.0.1");
  await rm(join(base, "tarballs", "tiny-1.0.1.tgz"));
  await expect(installClaudeCode(state, lock, npm)).rejects.toThrow();
  expect(await readdir(join(state, "clis"))).toEqual([]);
});

test("an install missing its executable is installed again", async () => {
  await pin("1.0.0");
  await installClaudeCode(state, lock, npm);
  await rm(join(claudeCodeDir(state), "node_modules"), { recursive: true });
  expect(await installClaudeCode(state, lock, npm)).toBe("installed");
  expect(await version()).toBe("1.0.0 (Claude Code)");
});
