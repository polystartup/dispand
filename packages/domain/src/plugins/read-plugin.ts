import { join } from "node:path";
import { storable } from "@dispand/runner-protocol";
import { parse } from "yaml";
import { MAX_FILE_BYTES, splitSkillMd } from "../skills/package.ts";
import { isDir, kindAt, list, MAX_JSON_BYTES, type NotImported, Notes, PluginError, type PluginSkill, pluginPath, readJson, readRegular, readSkillFolders, resolvePluginRoot, spend, withBudget } from "./fs.ts";
import { allStorable, type MarketplaceEntry } from "./marketplace.ts";
import { readStandardPlugin } from "./standard.ts";

export { type NotImported, PluginError, resolvePluginRoot };

export type PluginMcpServer =
  | { name: string; type: "http"; url: string; transport: "streamable-http" | "sse"; headers: Record<string, string>; settings: string[] }
  | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string; settings: string[] };

export type PluginAgent = { name: string; description: string; systemPrompt: string };

export type PluginContents = {
  /** `standard`: Agent Plugins (a root `plugin.json`, `standard.ts`); `claude`: the Claude plugin layout. */
  layout: "claude" | "standard";
  /** The manifest's `version`, when it has one. */
  version: string | null;
  /** One entry per skill that can be imported, with its files (`<skill>/<path>`). */
  skills: PluginSkill[];
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

const MAX_AGENT_PROMPT = 100_000;
/** MCP servers and agents one plugin may offer. */
const MAX_SERVERS = 100;
const MAX_AGENTS = 100;
const PLUGIN_ROOT_VAR = "CLAUDE_PLUGIN_ROOT";
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

function readSkills(root: string, entry: MarketplaceEntry, notImported: Notes): PluginContents["skills"] {
  let folders: string[];
  if (entry.skills) folders = entry.skills;
  else if (isDir(join(root, "skills"))) {
    folders = list(join(root, "skills"))
      .filter((d) => d.isDirectory())
      .map((d) => `skills/${d.name}`)
      .sort();
  } else folders = [];
  return readSkillFolders(root, folders, notImported);
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
  // A root `plugin.json` (or a link there, which the standard reader refuses) makes a standard
  // plugin, whatever `.claude-plugin/` holds: it is the manifest with a version the reader checks.
  const standard = kindAt(root, "plugin.json") !== "absent" || links.includes("plugin.json");
  return withBudget(() => (standard ? readStandardPlugin(root, links) : readWithin(root, entry, links)));
}

function readWithin(root: string, entry: MarketplaceEntry, links: string[]): PluginContents {
  const file = readJson(root, ".claude-plugin/plugin.json");
  const manifest: Record<string, unknown> = {
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
  const version = typeof manifest.version === "string" && storable(manifest.version) ? cut(manifest.version, 100) : null;
  return { layout: "claude", version, skills, mcpServers, agents, notImported: notImported.list() };
}
