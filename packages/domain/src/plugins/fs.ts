import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { isSafeRelativePath, storable } from "@dispand/runner-protocol";
import { MAX_FILE_BYTES, MAX_FILES, PackageError, SKILL_NAME, type SkillFile, validatePackage } from "../skills/package.ts";

/** What both plugin readers share: the root, the read's budget, regular files and skill folders. */

export type NotImported = { component: "manifest" | "hook" | "command" | "bin" | "mcp-server" | "skill" | "definition" | "file"; name: string; reason: string };

export type PluginSkill = { name: string; description: string; files: SkillFile[] };

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
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
 * What the read under way has spent (a read is synchronous: one at a time). Every listing and
 * every read goes through `spend`, so no shape of plugin can make a read do more work.
 */
let spent: { entries: number; bytes: number } | null = null;

export function spend(entries: number, bytes = 0): void {
  if (!spent) return;
  spent.entries += entries;
  spent.bytes += bytes;
  if (spent.entries > MAX_ENTRIES || spent.bytes > MAX_READ_BYTES) {
    throw new PluginError(`The plugin is too large to read: more than ${MAX_ENTRIES.toLocaleString("en")} files or 64 MiB`);
  }
}

/** Runs one read of a plugin under a fresh budget. */
export function withBudget<T>(read: () => T): T {
  spent = { entries: 0, bytes: 0 };
  try {
    return read();
  } finally {
    spent = null;
  }
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
    return this.more > 0 ? [...this.items, { component: "file", name: "…", reason: `and ${this.more} more not imported` }] : this.items;
  }
}

/** A folder's entries, counted against the read's budget. */
export function list(dir: string) {
  const entries = readdirSync(dir, { withFileTypes: true });
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
export function resolvePluginRoot(checkout: string, path = "."): string {
  if (isAbsolute(path) || path.includes("\\") || !storable(path)) throw new PluginError("The plugin's folder isn't a relative path");
  const root = realpathSync(checkout);
  const target = join(root, normalize(path));
  if (!inside(root, target)) throw new PluginError("The plugin's folder is outside its repository");
  let real: string;
  try {
    if (!lstatSync(target).isDirectory()) throw new Error();
    real = realpathSync(target);
  } catch {
    throw new PluginError("The plugin's folder isn't in its repository");
  }
  if (!inside(root, real)) throw new PluginError("The plugin's folder is outside its repository");
  return real;
}

/** What is at `<root>/<rel>`, without following a link: nothing, a regular file, a folder, or something else. */
export function kindAt(root: string, rel: string): "absent" | "file" | "dir" | "other" {
  try {
    const stat = lstatSync(join(root, rel));
    return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
  } catch {
    return "absent";
  }
}

/** A regular file under `root` at `rel`, read whole (at most `max` bytes), or null when it isn't one. */
export function readRegular(root: string, rel: string, max: number): Buffer | null {
  const path = join(root, rel);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > max) return null;
    if (!inside(root, realpathSync(path))) return null;
    spend(1, stat.size);
    return readFileSync(path);
  } catch (e) {
    if (e instanceof PluginError) throw e;
    return null;
  }
}

export function readJson(root: string, rel: string): unknown {
  const bytes = readRegular(root, rel, MAX_JSON_BYTES);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

export function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
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
function skillFiles(root: string, rel: string, skill: string, notImported: Notes): SkillFile[] {
  const files: SkillFile[] = [];
  let visited = 0;
  const walk = (dir: string, prefix: string) => {
    let entries;
    try {
      entries = list(dir);
    } catch (e) {
      if (e instanceof PluginError) throw e;
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // A skill holds at most MAX_FILES files: past twice that many entries, it isn't one.
      if (++visited > MAX_FILES * 2) throw new PackageError(`a skill holds at most ${MAX_FILES} files`, skill);
      const path = `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (!isSafeRelativePath(path)) {
        notImported.push({ component: "file", name: path, reason: "Its path isn't allowed in a skill" });
        continue;
      }
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) notImported.push({ component: "file", name: path, reason: "A symbolic link" });
      else if (stat.isDirectory()) walk(full, path);
      else if (!stat.isFile()) notImported.push({ component: "file", name: path, reason: "Not a regular file" });
      else if (stat.size > MAX_FILE_BYTES) notImported.push({ component: "file", name: path, reason: "Larger than 2 MiB" });
      else {
        spend(0, stat.size);
        files.push({ path, content: new Uint8Array(readFileSync(full)) });
      }
    }
  };
  walk(join(root, rel), skill);
  return files;
}

/** The skills in `folders` (plugin-relative), each read and validated alone: one that doesn't load is listed with its reason. */
export function readSkillFolders(root: string, folders: string[], notImported: Notes): PluginSkill[] {
  if (folders.length > MAX_SKILLS) throw new PluginError(`The plugin offers more than ${MAX_SKILLS} skills`);
  const skills: PluginSkill[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  for (const folder of folders) {
    const rel = pluginPath(root, folder);
    // Each folder is read once, whether it imports or not.
    const key = rel ?? folder;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = basename(rel ?? folder);
    if (rel === null || rel === ".") {
      notImported.push({ component: "skill", name: folder, reason: "Its folder is outside the plugin" });
      continue;
    }
    const full = join(root, rel);
    let real: string;
    try {
      if (!lstatSync(full).isDirectory()) throw new Error();
      real = realpathSync(full);
    } catch {
      notImported.push({ component: "skill", name, reason: "Its folder isn't in the plugin (or is a link)" });
      continue;
    }
    if (!inside(root, real)) {
      notImported.push({ component: "skill", name, reason: "Its folder is outside the plugin" });
      continue;
    }
    if (!SKILL_NAME.test(name)) {
      notImported.push({ component: "skill", name, reason: "Its name isn't lowercase letters, digits and hyphens" });
      continue;
    }
    if (names.has(name)) {
      notImported.push({ component: "skill", name, reason: "Another skill of the plugin has its name" });
      continue;
    }
    names.add(name);
    const skipped = new Notes();
    try {
      const files = skillFiles(root, rel, name, skipped);
      notImported.absorb(skipped);
      const [skill] = validatePackage(files).skills;
      skills.push({ name, description: skill!.description, files });
    } catch (e) {
      if (!(e instanceof PackageError)) throw e;
      notImported.push({ component: "skill", name, reason: e.message });
    }
  }
  return skills;
}
