import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, vi } from "vitest";

/** A file of a fixture: its text, or a symbolic link to `link`. */
export type FixtureFile = string | { link: string };

/** Writes `files` (relative paths) under `dir`. */
export function writeTree(dir: string, files: Record<string, FixtureFile>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    rmSync(full, { force: true });
    if (typeof content === "string") writeFileSync(full, content);
    else symlinkSync(content.link, full);
  }
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** A local Git repository for tests: `commit` adds files and returns the new commit's sha. */
export function fixtureRepo(files: Record<string, FixtureFile>) {
  const dir = mkdtempSync(join(tmpdir(), "dispand-fixture-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const commit = (more: Record<string, FixtureFile>) => {
    writeTree(dir, more);
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const sha = commit(files);
  return { dir, url: pathToFileURL(dir).href, sha, commit, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A `SKILL.md` with its frontmatter. */
export const skillMd = (name: string, description = `Does ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

type Route = string | Uint8Array | { status: number; location?: string };

/** A fake site (no network): `routes` maps full URLs to bodies, statuses or redirects. Records what was asked. */
export function fakeSite(routes: Record<string, Route>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    expect(init?.redirect).toBe("manual");
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (typeof route === "string" || route instanceof Uint8Array) return new Response(route, { status: 200 });
    return new Response(null, { status: route.status, headers: route.location ? { location: route.location } : {} });
  });
  return asked;
}

