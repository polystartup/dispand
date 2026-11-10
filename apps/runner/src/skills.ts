import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { isSafeRelativePath } from "@dispand/runner-protocol";
import { parse, stringify } from "yaml";
import { z } from "zod";

/**
 * Skill packages a session gets, fetched from Dispand and written read-only under the
 * runner's state dir, outside every root and the machine's config (`config.ts`). Each package
 * is a plugin the SDK loads (`plugins`): only `.claude-plugin/plugin.json` (the runner's own) and
 * `skills/<path>`, never hooks, commands or MCP servers, whatever the package holds.
 */

/** A skill package as the runner writes it. */
export type SkillPackage = { name: string; files: { path: string; content: Buffer }[] };

/** Why a session's skills couldn't be fetched or written: the session doesn't start. */
export class SkillsRefused extends Error {
  override name = "SkillsRefused";
}

/** A skill's folder (and the `name` the runner writes for it): lowercase words joined by single hyphens, at most 64 characters. */
const SKILL_FOLDER = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A package's (and plugin's) name: one plain path segment. */
const PACKAGE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** Caps of a package (`validatePackage` on the server), with room for base64 and JSON. */
const MAX_FILES = 500;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const Response = z.object({
  name: z.string().regex(PACKAGE_NAME),
  files: z.array(z.object({ path: z.string().max(255), base64: z.base64() })).max(MAX_FILES),
});

/**
 * The folder holding a session's plugins: `<stateDir>/sessions/<hash of the session id>/plugins`.
 * The session id comes from the server: hashed, it is always one plain segment.
 */
export function sessionPluginsDir(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(stateDir, "sessions", key, "plugins");
}

/** The body as text, read as it streams: past `max` bytes, it is cancelled and `SkillsRefused` thrown. */
async function readCapped(res: globalThis.Response, max: number): Promise<string> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > max) {
      await res.body.cancel().catch(() => undefined);
      throw new SkillsRefused("too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetches each package from `GET <server>/runner/packages/<id>` with the runner's token. The
 * server URL is already https (or loopback http, `serverUrl`); redirects are refused, bodies are
 * capped and every path is checked before anything is written. Throws `SkillsRefused`.
 */
export async function fetchPackages(server: string, token: string, refs: { packageId: string; name: string }[]): Promise<SkillPackage[]> {
  const packages: SkillPackage[] = [];
  for (const ref of refs) {
    const url = `${server}/runner/packages/${encodeURIComponent(ref.packageId)}`;
    let res: globalThis.Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw new SkillsRefused(`couldn't fetch skill package ${ref.name} from Dispand`);
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new SkillsRefused(`Dispand refused skill package ${ref.name} (${res.status})`);
    }
    const announced = Number(res.headers.get("content-length") ?? 0);
    if (announced > MAX_RESPONSE_BYTES) {
      await res.body?.cancel();
      throw new SkillsRefused(`skill package ${ref.name} is too large`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES));
    } catch (e) {
      if (e instanceof SkillsRefused) throw new SkillsRefused(`skill package ${ref.name} is too large`);
      throw new SkillsRefused(`skill package ${ref.name} isn't readable`);
    }
    const parsed = Response.safeParse(body);
    if (!parsed.success || parsed.data.name !== ref.name) throw new SkillsRefused(`skill package ${ref.name} isn't readable`);
    packages.push({ name: ref.name, files: parsed.data.files.map((f) => ({ path: f.path, content: Buffer.from(f.base64, "base64") })) });
  }
  return packages;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Every `@` becomes `＠` (U+FF20, which reads the same): with no `@` left, the CLI finds no file
 * mention to expand, whatever characters it takes as a mention's start or end.
 */
const noMentions = (text: string) => text.replaceAll("@", "\uff20");

/**
 * A `SKILL.md` as the runner writes it: a frontmatter it makes itself, holding only `name` (the
 * skill's folder) and `description` (one line, from the original's frontmatter if the runner can
 * read one), then the original's body. No other key (hooks, allowed-tools, model...) reaches the
 * CLI, however the original is written: what the runner can't read stays in the body, below the
 * runner's own frontmatter, which the CLI reads first and can't end early (no `---` in it). The file
 * holds no `@` at all, so no file mention.
 */
export function canonicalSkillMd(folder: string, content: Buffer): Buffer {
  const text = content.toString("utf8");
  const match = FRONTMATTER.exec(text);
  let description = "";
  if (match) {
    try {
      const meta: unknown = parse(match[1]!);
      if (typeof meta === "object" && meta !== null && typeof (meta as { description?: unknown }).description === "string") {
        description = (meta as { description: string }).description;
      }
    } catch {
      // Not readable: no description.
    }
  }
  description = noMentions(description.replace(/\s+/g, " ").replace(/-{3,}/g, "--").trim());
  const body = noMentions((match ? text.slice(match[0].length) : text).replace(/^\r?\n/, ""));
  return Buffer.from(`---\n${stringify({ name: folder, description }, { lineWidth: 0 })}---\n\n${body}`);
}

/** Whether `path` names a `SKILL.md` (any folder, any case: the CLI may find nested ones). */
const isSkillMd = (path: string) => (path.split("/").pop() ?? "").toLowerCase() === "skill.md";

/** Makes everything under `dir` writable again (folders first), so it can be removed. */
async function unlock(dir: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(dir);
  } catch {
    return;
  }
  if (!entry.isDirectory()) return;
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) await unlock(join(dir, name));
}

/** Removes every session's skill files, as on start: sessions a crash left behind have none running. */
export async function clearSessions(stateDir: string): Promise<void> {
  const dir = join(stateDir, "sessions");
  await unlock(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Removes a plugins folder, read-only files included, then its session folder if that is left empty. */
export async function removeSkills(dir: string): Promise<void> {
  await unlock(dir);
  await rm(dir, { recursive: true, force: true });
  await rmdir(join(dir, "..")).catch(() => undefined);
}

/**
 * Writes `packages` as plugins under `dir` (removed first): for each, only
 * `<dir>/<name>/.claude-plugin/plugin.json` (`{ "name": <name> }`, made here) and
 * `<dir>/<name>/skills/<path>`, every `SKILL.md` rewritten by `canonicalSkillMd`. Every name and path is checked (`isSafeRelativePath`) before
 * anything is written; files are created with `wx` and `O_NOFOLLOW`, then made 0444 and folders
 * 0555. Returns the plugin roots, for the SDK's `plugins`. Throws `SkillsRefused`.
 */
export async function writeSkills(dir: string, packages: SkillPackage[]): Promise<string[]> {
  const names = new Set<string>();
  for (const pkg of packages) {
    if (!PACKAGE_NAME.test(pkg.name) || names.has(pkg.name.toLowerCase())) throw new SkillsRefused(`skill package name ${pkg.name} can't be used`);
    names.add(pkg.name.toLowerCase());
    for (const file of pkg.files) {
      if (!isSafeRelativePath(file.path)) throw new SkillsRefused(`skill package ${pkg.name} holds an unsafe path`);
      // The names the runner writes into a SKILL.md (and the CLI turns into commands) are plain:
      // the skill's folder, and the folder of any nested SKILL.md.
      const segments = file.path.split("/");
      const named = isSkillMd(file.path) ? [segments[0], segments.at(-2)] : [segments[0]];
      if (segments.length < 2 || named.some((n) => n === undefined || !SKILL_FOLDER.test(n))) {
        throw new SkillsRefused(`skill package ${pkg.name} holds a skill folder named otherwise than lowercase words joined by single hyphens`);
      }
    }
  }
  await unlock(dir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const folders: string[] = [];
  const write = async (path: string, content: Buffer) => {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await chmod(path, 0o444);
  };
  const folder = async (path: string) => {
    // Not recursive past the plugin's own folders: each level is made here, so none is a link.
    await mkdir(path, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    const entry = await lstat(path);
    if (!entry.isDirectory()) throw new SkillsRefused("a skill package's folders collide with its files");
    folders.push(path);
  };
  const roots: string[] = [];
  for (const pkg of packages) {
    const root = join(dir, pkg.name);
    await folder(root);
    await folder(join(root, ".claude-plugin"));
    await write(join(root, ".claude-plugin", "plugin.json"), Buffer.from(`${JSON.stringify({ name: pkg.name })}\n`));
    await folder(join(root, "skills"));
    for (const file of pkg.files) {
      const segments = file.path.split("/");
      let at = join(root, "skills");
      for (const segment of segments.slice(0, -1)) {
        at = join(at, segment);
        await folder(at);
      }
      const content = isSkillMd(file.path) ? canonicalSkillMd(segments.at(-2)!, file.content) : file.content;
      await write(join(at, segments.at(-1)!), content).catch((err: NodeJS.ErrnoException) => {
        throw new SkillsRefused(`skill package ${pkg.name} couldn't be written (${err.code ?? "error"})`);
      });
    }
    roots.push(root);
  }
  // Deepest first, so a folder is still writable while its children are locked.
  for (const path of folders.reverse()) await chmod(path, 0o555);
  return roots;
}
