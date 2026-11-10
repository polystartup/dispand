import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { isSafeRelativePath, storable } from "@dispand/runner-protocol";
import { parse } from "yaml";
import { MAX_FILE_BYTES, MAX_FILES, PackageError, SKILL_NAME, type SkillFile, splitSkillMd, validatePackage } from "../skills/package.ts";
import { allStorable, type MarketplaceEntry } from "./marketplace.ts";

export type PluginMcpServer =
  | { name: string; type: "http"; url: string; transport: "streamable-http" | "sse"; headers: Record<string, string>; settings: string[] }
  | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string>; settings: string[] };

export type PluginAgent = { name: string; description: string; systemPrompt: string };

export type NotImported = { component: "hook" | "command" | "bin" | "mcp-server" | "skill" | "file"; name: string; reason: string };

export type PluginContents = {
  /** One entry per skill that can be imported, with its files (`<skill>/<path>`). */
  skills: { name: string; description: string; files: SkillFile[] }[];
  mcpServers: PluginMcpServer[];
  agents: PluginAgent[];
  notImported: NotImported[];
};

/** A summary of what a plugin offers: what Installed lists and the install sheet ticks. */
export type PluginComponents = {
  skills: { name: string; description: string }[];
  /** `url` (an HTTP server's, with its placeholders) is where its settings would go: the install sheet shows it. */
  mcpServers: { name: string; type: "http" | "stdio"; settings: string[]; url?: string }[];
  agents: { name: string; description: string }[];
};

export function componentsOf(contents: PluginContents): PluginComponents {
  return {
    skills: contents.skills.map(({ name, description }) => ({ name, description })),
    mcpServers: contents.mcpServers.map((s) => ({ name: s.name, type: s.type, settings: s.settings, ...(s.type === "http" ? { url: s.url } : {}) })),
    agents: contents.agents.map(({ name, description }) => ({ name, description })),
  };
}

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_AGENT_PROMPT = 100_000;
/** One read of a plugin looks at this many files and folders, and reads this many bytes, at most. */
const MAX_ENTRIES = 20_000;
const MAX_READ_BYTES = 64 * 1024 * 1024;
/** Skills one plugin may offer. */
const MAX_SKILLS = 200;

/**
 * What the read under way has spent (`readPlugin` is synchronous: one at a time). Every listing
 * and every read goes through `spend`, so no shape of plugin can make a read do more work.
 */
let spent: { entries: number; bytes: number } | null = null;

function spend(entries: number, bytes = 0): void {
  if (!spent) return;
  spent.entries += entries;
  spent.bytes += bytes;
  if (spent.entries > MAX_ENTRIES || spent.bytes > MAX_READ_BYTES) {
    throw new PluginError(`The plugin is too large to read: more than ${MAX_ENTRIES.toLocaleString("en")} files or 64 MiB`);
  }
}

/**
 * What a read leaves out. Every item is charged to the read's budget, and only the first
 * `MAX_NOT_IMPORTED` are kept (the rest counted), so listing can't cost more than reading.
 */
class Notes {
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
function list(dir: string) {
  const entries = readdirSync(dir, { withFileTypes: true });
  spend(entries.length);
  return entries;
}

/** MCP servers and agents one plugin may offer. */
const MAX_SERVERS = 100;
const MAX_AGENTS = 100;

/** What is listed as not imported, at most; the rest is counted. */
const MAX_NOT_IMPORTED = 200;
const PLUGIN_ROOT_VAR = "CLAUDE_PLUGIN_ROOT";
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

/** Whether `child` (a real path) is `parent` or inside it. */
function inside(parent: string, child: string): boolean {
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

/** A regular file under `root` at `rel`, read whole (at most `max` bytes), or null when it isn't one. */
function readRegular(root: string, rel: string, max: number): Buffer | null {
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

function readJson(root: string, rel: string): unknown {
  const bytes = readRegular(root, rel, MAX_JSON_BYTES);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A plugin-relative path from a manifest (`./x`, `x`), normalized, if it stays inside the plugin; else null. */
function pluginPath(root: string, value: string): string | null {
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

function readSkills(root: string, entry: MarketplaceEntry, notImported: Notes): PluginContents["skills"] {
  let folders: string[];
  if (entry.skills) folders = entry.skills;
  else if (isDir(join(root, "skills"))) {
    folders = list(join(root, "skills"))
      .filter((d) => d.isDirectory())
      .map((d) => `skills/${d.name}`)
      .sort();
  } else folders = [];
  if (folders.length > MAX_SKILLS) throw new PluginError(`The plugin offers more than ${MAX_SKILLS} skills`);
  const skills: PluginContents["skills"] = [];
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

/** `${VAR}` names in a server's strings, `CLAUDE_PLUGIN_ROOT` aside. */
function settingsOf(strings: string[]): string[] {
  const names = new Set<string>();
  for (const s of strings) for (const m of s.matchAll(VARIABLE)) if (m[1] !== PLUGIN_ROOT_VAR) names.add(m[1]!);
  return [...names].sort();
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null);
const record = (v: unknown): Record<string, string> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string") ? (v as Record<string, string>) : null;

function readServer(name: string, raw: unknown): PluginMcpServer | NotImported {
  const skip = (reason: string): NotImported => ({ component: "mcp-server", name, reason });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return skip("Its settings aren't readable");
  if (!allStorable(raw)) return skip("Its settings aren't readable");
  if (JSON.stringify(raw).includes(PLUGIN_ROOT_VAR)) return skip("It runs the plugin's own files");
  const s = raw as Record<string, unknown>;
  if (typeof s.url === "string") {
    if (s.type !== undefined && s.type !== "http" && s.type !== "sse" && s.type !== "streamable-http") return skip("Its type isn't supported");
    const headers = s.headers === undefined ? {} : record(s.headers);
    if (!headers) return skip("Its headers aren't readable");
    return {
      name,
      type: "http",
      url: s.url,
      transport: s.type === "sse" ? "sse" : "streamable-http",
      headers,
      settings: settingsOf([s.url, ...Object.values(headers)]),
    };
  }
  if (typeof s.command === "string") {
    const args = s.args === undefined ? [] : strings(s.args);
    const env = s.env === undefined ? {} : record(s.env);
    if (!args || !env) return skip("Its arguments or environment aren't readable");
    return { name, type: "stdio", command: s.command, args, env, settings: settingsOf([s.command, ...args, ...Object.values(env)]) };
  }
  return skip("Its type isn't supported");
}

/** The servers of a `.mcp.json`-shaped value: `{ mcpServers: { … } }` or the map itself. */
function serverMap(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const inner = v.mcpServers;
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) return inner as Record<string, unknown>;
  return v;
}

function readServers(root: string, manifest: Record<string, unknown>, notImported: Notes): PluginMcpServer[] {
  const maps: Record<string, unknown>[] = [];
  const fromFile = serverMap(readJson(root, ".mcp.json"));
  if (fromFile) maps.push(fromFile);
  const declared = manifest.mcpServers;
  const files = new Set<string>([".mcp.json"]);
  for (const item of typeof declared === "string" || Array.isArray(declared) ? [declared].flat() : [declared]) {
    if (typeof item === "string") {
      const rel = pluginPath(root, item);
      // Each file is read once, however often the manifest names it.
      if (rel === null || files.has(rel)) continue;
      files.add(rel);
      const map = rel && rel !== "." ? serverMap(readJson(root, rel)) : null;
      if (map) maps.push(map);
    } else if (item !== undefined) {
      const map = serverMap(item);
      if (map) maps.push(map);
    }
  }
  const servers: PluginMcpServer[] = [];
  const seen = new Set<string>();
  for (const map of maps) {
    for (const [name, raw] of Object.entries(map)) {
      spend(1);
      if (name.length > 100 || !storable(name) || seen.has(name)) continue;
      seen.add(name);
      if (seen.size > MAX_SERVERS) throw new PluginError(`The plugin offers more than ${MAX_SERVERS} MCP servers`);
      const server = readServer(name, raw);
      if ("component" in server) notImported.push(server);
      else servers.push(server);
    }
  }
  return servers;
}

/** `s` cut to `max` code points, never inside a surrogate pair. */
const cut = (s: string, max: number) => [...s].slice(0, max).join("");

function readAgents(root: string, notImported: Notes): PluginAgent[] {
  if (!isDir(join(root, "agents"))) return [];
  const agents: PluginAgent[] = [];
  for (const file of list(join(root, "agents")).map((d) => d.name).sort()) {
    if (!file.endsWith(".md")) continue;
    const bytes = readRegular(root, `agents/${file}`, MAX_FILE_BYTES);
    if (!bytes) {
      notImported.push({ component: "file", name: `agents/${file}`, reason: "Not a regular file, or larger than 2 MiB" });
      continue;
    }
    const text = bytes.toString("utf8");
    const parts = splitSkillMd(text);
    let meta: Record<string, unknown> = {};
    try {
      const parsed: unknown = parts ? parse(parts.frontmatter) : {};
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      // the file name and body still make an agent
    }
    const body = (parts ? parts.body : text).trim();
    if (body.length > MAX_AGENT_PROMPT || !storable(body)) {
      notImported.push({ component: "file", name: `agents/${file}`, reason: "Its prompt is longer than 100,000 characters" });
      continue;
    }
    const name = typeof meta.name === "string" && meta.name.trim() && storable(meta.name) ? cut(meta.name.trim(), 100) : file.slice(0, -3);
    const description = typeof meta.description === "string" && storable(meta.description) ? cut(meta.description, 1000) : "";
    if (agents.length >= MAX_AGENTS) throw new PluginError(`The plugin offers more than ${MAX_AGENTS} agents`);
    agents.push({ name, description, systemPrompt: body });
  }
  return agents;
}

/** What Dispand never imports, because it would run code the owner never approved. */
function listNotRun(root: string, manifest: Record<string, unknown>, notImported: Notes) {
  if (manifest.hooks !== undefined || readRegular(root, "hooks/hooks.json", MAX_JSON_BYTES) || isDir(join(root, "hooks"))) {
    notImported.push({ component: "hook", name: "hooks", reason: "Hooks run commands on the machine" });
  }
  if (isDir(join(root, "commands"))) {
    for (const file of list(join(root, "commands")).map((d) => d.name).sort()) {
      if (file.endsWith(".md")) notImported.push({ component: "command", name: file.slice(0, -3), reason: "Commands aren't imported" });
    }
  } else if (manifest.commands !== undefined) {
    notImported.push({ component: "command", name: "commands", reason: "Commands aren't imported" });
  }
  if (isDir(join(root, "bin"))) notImported.push({ component: "bin", name: "bin/", reason: "Runs the plugin's own programs" });
}

/**
 * What a plugin holds, read from its root folder (from `resolvePluginRoot`) without running
 * anything: its skills (`entry.skills`, else `skills/*`), MCP servers (`.mcp.json` and the
 * manifest's `mcpServers`), agents (`agents/*.md`), and what is never imported (hooks, commands,
 * `bin/`, a server that runs the plugin's own files, links and other files a skill can't hold).
 * Every file is `lstat`ed: links are never followed.
 */
export function readPlugin(root: string, entry: MarketplaceEntry, links: string[] = []): PluginContents {
  spent = { entries: 0, bytes: 0 };
  try {
    return readWithin(root, entry, links);
  } finally {
    spent = null;
  }
}

function readWithin(root: string, entry: MarketplaceEntry, links: string[]): PluginContents {
  const file = readJson(root, ".claude-plugin/plugin.json");
  const manifest = {
    ...(typeof file === "object" && file !== null && !Array.isArray(file) ? (file as Record<string, unknown>) : {}),
    ...entry.manifest,
  };
  const notImported = new Notes();
  // The checkout's links are gone from it (`fetchGit`): listed here, never read.
  notImported.push(...links.map((name): NotImported => ({ component: "file", name, reason: "A symbolic link" })));
  const skills = readSkills(root, entry, notImported);
  const mcpServers = readServers(root, manifest, notImported);
  const agents = readAgents(root, notImported);
  listNotRun(root, manifest, notImported);
  return { skills, mcpServers, agents, notImported: notImported.list() };
}
