import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { isSafeRelativePath, storable } from "@dispand/runner-protocol";
import { parse } from "yaml";
import { type Message, say, SayError } from "../messages/index.ts";
import { MAX_FILE_BYTES, MAX_FILES, PackageError, SKILL_NAME, type SkillFile, splitSkillMd, validatePackage } from "../skills/package.ts";

/** What both plugin readers share: the root, the read's budget, regular files and skill folders. */

export type NotImported = {
  component: "manifest" | "hook" | "command" | "bin" | "mcp-server" | "skill" | "definition" | "file";
  name: string;
  reason: Message;
};

export type PluginSkill = { name: string; description: string; files: SkillFile[] };

export class PluginError extends SayError {
  override name = "PluginError";
}

export const MAX_JSON_BYTES = 1024 * 1024;
/** One read of a plugin looks at this many files and folders, and reads this many bytes, at most. */
const MAX_ENTRIES = 20_000;
const MAX_READ_BYTES = 64 * 1024 * 1024;
/** Skills one plugin may offer. */
const MAX_SKILLS = 200;
/** What is listed as not imported, at most; the rest is counted. */
const MAX_NOT_IMPORTED = 200;

/**
 * What each read under way has spent: reads are asynchronous, so several may run at once, each
 * with its own. Every listing and every read goes through `spend`, so no shape of plugin can make
 * a read do more work.
 */
const budget = new AsyncLocalStorage<{ entries: number; bytes: number }>();

export function spend(entries: number, bytes = 0): void {
  const spent = budget.getStore();
  if (!spent) return;
  spent.entries += entries;
  spent.bytes += bytes;
  if (spent.entries > MAX_ENTRIES || spent.bytes > MAX_READ_BYTES) {
    throw new PluginError("pluginRead.tooLarge", { files: MAX_ENTRIES });
  }
}

/** Runs one read of a plugin under a fresh budget. */
export function withBudget<T>(read: () => Promise<T>): Promise<T> {
  return budget.run({ entries: 0, bytes: 0 }, read);
}

/**
 * What a read leaves out. Every item is charged to the read's budget, and only the first
 * `MAX_NOT_IMPORTED` are kept (the rest counted), so listing can't cost more than reading.
 */
export class Notes {
  readonly items: NotImported[] = [];
  private more = 0;

  push(...notes: NotImported[]): void {
    for (const note of notes) {
      spend(1);
      if (this.items.length < MAX_NOT_IMPORTED) this.items.push(note);
      else this.more += 1;
    }
  }

  /** Takes over another collector's notes (already charged). */
  absorb(other: Notes): void {
    for (const note of other.items) {
      if (this.items.length < MAX_NOT_IMPORTED) this.items.push(note);
      else this.more += 1;
    }
    this.more += other.more;
  }

  list(): NotImported[] {
    return this.more > 0 ? [...this.items, { component: "file", name: "…", reason: say("notImported.more", { count: this.more }) }] : this.items;
  }
}

/** A folder's entries, counted against the read's budget. */
export async function list(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true });
  spend(entries.length);
  return entries;
}

/** Whether `child` (a real path) is `parent` or inside it. */
export function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The plugin's root folder inside a checkout: `path` (relative, `./` allowed) must name a real
 * folder, not a link, whose real path is inside the checkout. Throws `PluginError`.
 */
export async function resolvePluginRoot(checkout: string, path = "."): Promise<string> {
  if (isAbsolute(path) || path.includes("\\") || !storable(path)) throw new PluginError("pluginRead.folder.notRelative");
  const root = await realpath(checkout);
  const target = join(root, normalize(path));
  if (!inside(root, target)) throw new PluginError("pluginRead.folder.outside");
  let real: string;
  try {
    if (!(await lstat(target)).isDirectory()) throw new Error();
    real = await realpath(target);
  } catch {
    throw new PluginError("pluginRead.folder.missing");
  }
  if (!inside(root, real)) throw new PluginError("pluginRead.folder.outside");
  return real;
}

/** What is at `<root>/<rel>`, without following a link: nothing, a regular file, a folder, or something else. */
export async function kindAt(root: string, rel: string): Promise<"absent" | "file" | "dir" | "other"> {
  try {
    const stat = await lstat(join(root, rel));
    return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
  } catch {
    return "absent";
  }
}

/** A regular file under `root` at `rel`, read whole (at most `max` bytes), or null when it isn't one. */
export async function readRegular(root: string, rel: string, max: number): Promise<Buffer | null> {
  const path = join(root, rel);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > max) return null;
    if (!inside(root, await realpath(path))) return null;
    spend(1, stat.size);
    return await readFile(path);
  } catch (e) {
    if (e instanceof PluginError) throw e;
    return null;
  }
}

export async function readJson(root: string, rel: string): Promise<unknown> {
  const bytes = await readRegular(root, rel, MAX_JSON_BYTES);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** A plugin-relative path from a manifest (`./x`, `x`), normalized, if it stays inside the plugin; else null. */
export function pluginPath(root: string, value: string): string | null {
  if (isAbsolute(value) || value.includes("\\") || !storable(value)) return null;
  const rel = normalize(value).replace(/\/+$/, "") || ".";
  return inside(root, join(root, rel)) ? rel : null;
}

/** Every file under `<root>/<rel>`, as `<skill>/<path>`; links and other non-regular files are skipped and listed. */
async function skillFiles(root: string, rel: string, skill: string, notImported: Notes): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  let visited = 0;
  const walk = async (dir: string, prefix: string) => {
    let entries;
    try {
      entries = await list(dir);
    } catch (e) {
      if (e instanceof PluginError) throw e;
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // The checkout's own, at its root, where a repository that is one skill starts: never the skill's.
      if (entry.name === ".git") continue;
      // A skill holds at most MAX_FILES files: past twice that many entries, it isn't one.
      if (++visited > MAX_FILES * 2) throw new PackageError("skills.package.skillTooManyFiles", skill, { max: MAX_FILES });
      const path = `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (!isSafeRelativePath(path)) {
        notImported.push({ component: "file", name: path, reason: say("notImported.skillPath") });
        continue;
      }
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) notImported.push({ component: "file", name: path, reason: say("notImported.symlink") });
      else if (stat.isDirectory()) await walk(full, path);
      else if (!stat.isFile()) notImported.push({ component: "file", name: path, reason: say("notImported.notRegular") });
      else if (stat.size > MAX_FILE_BYTES) notImported.push({ component: "file", name: path, reason: say("notImported.larger") });
      else {
        spend(0, stat.size);
        files.push({ path, content: new Uint8Array(await readFile(full)) });
      }
    }
  };
  await walk(join(root, rel), skill);
  return files;
}

/** The name a skill at the plugin's root (`.`) gives itself in its `SKILL.md`; empty when it gives none. */
async function rootSkillName(root: string): Promise<string> {
  const bytes = await readRegular(root, "SKILL.md", MAX_FILE_BYTES);
  // Decoded as the package's check decodes it (a byte-order mark dropped).
  const parts = bytes && splitSkillMd(new TextDecoder().decode(bytes));
  try {
    const meta: unknown = parts ? parse(parts.frontmatter) : null;
    const name = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>).name : undefined;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

/**
 * The skills in `folders` (plugin-relative), each read and validated alone: one that doesn't load
 * is listed with its reason. `.` is the plugin's own folder as one skill, named as its `SKILL.md`
 * names it (a repository that is one skill).
 */
export async function readSkillFolders(root: string, folders: string[], notImported: Notes): Promise<PluginSkill[]> {
  if (folders.length > MAX_SKILLS) throw new PluginError("pluginRead.tooManySkills", { max: MAX_SKILLS });
  const skills: PluginSkill[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  for (const folder of folders) {
    const rel = pluginPath(root, folder);
    // Each folder is read once, whether it imports or not.
    const key = rel ?? folder;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = rel === "." ? await rootSkillName(root) : basename(rel ?? folder);
    if (rel === null) {
      notImported.push({ component: "skill", name: folder, reason: say("notImported.folderOutside") });
      continue;
    }
    const full = join(root, rel);
    let real: string;
    try {
      if (!(await lstat(full)).isDirectory()) throw new Error();
      real = await realpath(full);
    } catch {
      notImported.push({ component: "skill", name, reason: say("notImported.folderMissing") });
      continue;
    }
    if (!inside(root, real)) {
      notImported.push({ component: "skill", name, reason: say("notImported.folderOutside") });
      continue;
    }
    if (!SKILL_NAME.test(name)) {
      notImported.push({ component: "skill", name: name && storable(name) ? name : folder, reason: say("notImported.skillName") });
      continue;
    }
    if (names.has(name)) {
      notImported.push({ component: "skill", name, reason: say("notImported.skillDuplicate") });
      continue;
    }
    names.add(name);
    const skipped = new Notes();
    try {
      const files = await skillFiles(root, rel, name, skipped);
      notImported.absorb(skipped);
      const [skill] = validatePackage(files).skills;
      skills.push({ name, description: skill!.description, files });
    } catch (e) {
      if (!(e instanceof PackageError)) throw e;
      notImported.push({ component: "skill", name, reason: e.say });
    }
  }
  return skills;
}

/**
 * What a runner takes of one plugin (`apps/runner/src/plugin-servers.ts`): files, and bytes in
 * all, so that their base64 in the files route's JSON stays within the runner's 16 MiB response cap.
 */
export const MAX_RUNNER_FILES = 500;
export const MAX_RUNNER_BYTES = 11 * 1024 * 1024;

/**
 * Every regular file under `root` a runner can write (`isSafeRelativePath`), for a plugin's stdio
 * servers: links, other non-regular files and `.git` are left out, and a path a runner can't
 * write is listed in `notImported`. Past `MAX_RUNNER_FILES` files or `MAX_RUNNER_BYTES` bytes,
 * null: a runner would refuse them, and the plugin installs without them.
 */
export async function readRunnerFiles(
  root: string,
  notImported: Notes,
  isPath: (path: string) => boolean = isSafeRelativePath,
): Promise<{ path: string; content: Uint8Array }[] | null> {
  const files: { path: string; content: Uint8Array }[] = [];
  let bytes = 0;
  const tooLarge = new Error("too large");
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await list(dir)) {
      if (entry.name === ".git") continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      const stat = await lstat(full);
      if (stat.isDirectory()) await walk(full, path);
      else if (stat.isFile() && !isPath(path)) notImported.push({ component: "file", name: path, reason: say("notImported.runnerPath") });
      else if (stat.isFile()) {
        bytes += stat.size;
        if (files.length >= MAX_RUNNER_FILES || bytes > MAX_RUNNER_BYTES) throw tooLarge;
        spend(0, stat.size);
        files.push({ path, content: new Uint8Array(await readFile(full)) });
      }
    }
  };
  try {
    await walk(root, "");
  } catch (e) {
    if (e !== tooLarge) throw e;
    return null;
  }
  return files;
}
