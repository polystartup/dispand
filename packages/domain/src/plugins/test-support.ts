import { call } from "@orpc/server";
import { router } from "../rpc/router.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** The law-firm fixture (`fixtures/law-firm/`, an Agent Plugins plugin with `com.dispand` definitions), as files to write. */
export function lawFirm(): Record<string, string> {
  const root = fileURLToPath(new URL("./fixtures/law-firm/", import.meta.url));
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const full = join(d.parentPath, d.name);
        return [relative(root, full), readFileSync(full, "utf8")];
      }),
  );
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
  const commit = (more: Record<string, FixtureFile>, removed: string[] = []) => {
    writeTree(dir, more);
    for (const path of removed) rmSync(join(dir, path), { force: true });
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

/** The law-firm fixture as a plugin of a marketplace, its case-law server at `caseLawUrl` when given (a fake MCP server's). */
export function lawFirmMarket(caseLawUrl?: string) {
  const files = lawFirm();
  if (caseLawUrl) files["mcp.json"] = files["mcp.json"]!.replace("https://case-law.example.com/mcp", caseLawUrl);
  const plugin = fixtureRepo(files);
  const repo = fixtureRepo({ ".claude-plugin/marketplace.json": JSON.stringify({ name: "firms", plugins: [{ name: "law-firm", source: { source: "url", url: plugin.url } }] }) });
  return {
    plugin,
    repo,
    remove: () => {
      plugin.remove();
      repo.remove();
    },
  };
}

/**
 * Removes a plugin as its owner does from the sheet. `keep`: `"all"` keeps every element as the
 * owner's own, `"used"` only those asked about with what they need, and `{ remove }` all but
 * the elements of those ids.
 */
export async function removePlugin(context: object, id: string, keep: "all" | "used" | { remove: string[] } = "all"): Promise<void> {
  const preview = await call(router.plugins.uninstallPreview, { id }, { context: context as never });
  const kept = new Set<string>();
  if (keep === "used") {
    const walk = (key: string) => {
      if (kept.has(key)) return;
      kept.add(key);
      for (const need of preview.elements.find((e) => e.key === key)!.needs) walk(need);
    };
    for (const e of preview.elements.filter((e) => e.reasons.length)) walk(e.key);
  } else for (const e of preview.elements) if (keep === "all" || !keep.remove.includes(e.id)) kept.add(e.key);
  // Every element gets a stated choice, as the sheet sends them.
  const choices = Object.fromEntries(preview.elements.map((e) => [e.key, kept.has(e.key) ? ("keep" as const) : ("delete" as const)]));
  await call(router.plugins.uninstall, { id, reviewed: preview.reviewed, choices }, { context: context as never });
}

/** Updates a plugin as its owner does from the sheet: looks at what would change, then confirms it, keeping their own values unless `take` names a conflict. */
export async function updatePlugin(context: object, id: string, take: string[] = []) {
  const preview = await call(router.plugins.updatePreview, { id }, { context: context as never });
  return call(router.plugins.update, { id, reviewed: preview.reviewed, take }, { context: context as never });
}
