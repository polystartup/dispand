import { join, normalize, posix } from "node:path";
import { storable } from "@dispand/runner-protocol";
import { z } from "zod";
import { type Message, type MessageKey, say } from "../messages/index.ts";
import { isLoopback } from "../harnesses/procedures.ts";
import { Headers } from "../tools/store.ts";
import { FOLDER, readDefinitions, readExtension } from "./definitions.ts";
import { allStorable } from "./marketplace.ts";
import { inside, kindAt, list, MAX_JSON_BYTES, type NotImported, Notes, PluginError, readRegular, readSkillFolders, spend } from "./fs.ts";
import type { PluginContents, PluginMcpServer } from "./read-plugin.ts";

/**
 * The Agent Plugins layout (agent-plugins.org): a root `plugin.json`, skills in `skills/<name>/`,
 * MCP servers in a root `mcp.json`, read with the standard's loading rules. Its schemas are known
 * here by their ids and never fetched. No loader library implements these rules with this
 * reader's guarantees (links never followed, one budget per read), so they are written out here.
 */

/** The Agent Plugins versions Dispand reads: each `plugin.json` schema id with its `mcp.json` one. */
const VERSIONS: Record<string, { mcp: string }> = {
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json": { mcp: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" },
};
const MCP_SCHEMAS = new Set(Object.values(VERSIONS).map((v) => v.mcp));

/** The standard's plugin name: 1 to 64 of `a-z 0-9 - .`, alphanumeric at both ends, no `--` or `..`. */
export const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const MAX_SERVERS = 100;

/** The manifest's fields but `extensions` (reported and ignored when it isn't an object). Every violation is fatal. */
const Manifest = z.object({
  $schema: z.string(),
  name: z.string().min(1).max(64).regex(PLUGIN_NAME),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.strictObject({ name: z.string().optional(), email: z.string().optional(), url: z.string().optional() }).optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});
const MANIFEST_FIELDS = new Set([...Object.keys(Manifest.shape), "extensions"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (s: string, max: number) => [...s].slice(0, max).join("");

/** `plugin.json`, validated: the version's rules, or `PluginError` when the plugin must be rejected. */
function readManifest(root: string, notImported: Notes): { mcpSchema: string; version: string | null; description: string | undefined } {
  if (kindAt(root, "plugin.json") !== "file") throw new PluginError("pluginRead.manifest.notFile");
  const bytes = readRegular(root, "plugin.json", MAX_JSON_BYTES);
  if (!bytes) throw new PluginError("pluginRead.manifest.tooLarge");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PluginError("pluginRead.manifest.notJson");
  }
  if (!isObject(raw)) throw new PluginError("pluginRead.manifest.notObject");
  if (raw.$schema === undefined) throw new PluginError("pluginRead.manifest.noSchema");
  const rules = typeof raw.$schema === "string" ? VERSIONS[raw.$schema] : undefined;
  if (!rules) throw new PluginError("pluginRead.manifest.version");
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_FIELDS.has(key)) notImported.push({ component: "manifest", name: storable(key) ? cut(key, 100) : "…", reason: say("notImported.notManifestField") });
  }
  if (raw.extensions !== undefined && !isObject(raw.extensions)) {
    notImported.push({ component: "manifest", name: "extensions", reason: say("notImported.extensionNotObject") });
  }
  // `com.dispand` is the one namespace Dispand implements; every other is never read.
  const description = isObject(raw.extensions) ? readExtension(raw.extensions[FOLDER], notImported) : undefined;
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new PluginError("pluginRead.manifest.invalid", { field: typeof field === "string" ? field : "manifest" });
  }
  const { version } = parsed.data;
  return { mcpSchema: rules.mcp, version: version !== undefined && storable(version) ? cut(version, 100) : null, description };
}

/** The skills: the immediate folders of `skills/` holding a regular `SKILL.md`, no deeper. */
function readSkills(root: string, notImported: Notes): PluginContents["skills"] {
  const kind = kindAt(root, "skills");
  if (kind === "absent") return [];
  if (kind !== "dir") {
    notImported.push({ component: "skill", name: "skills", reason: say("notImported.skillsNotFolder") });
    return [];
  }
  const folders = list(join(root, "skills"))
    .filter((d) => d.isDirectory() && kindAt(root, `skills/${d.name}/SKILL.md`) === "file")
    .map((d) => `skills/${d.name}`)
    .sort();
  return readSkillFolders(root, folders, notImported);
}

const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const REMOTE_FIELDS = new Set(["type", "url", "headers"]);
const RESERVED_ENV = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);
const CWD = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;
/** Stand-ins for the folders `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` become on a runner: only containment is checked here. */
const ROOT_AT = "/plugin-root";
const DATA_AT = "/plugin-data";

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const stringRecord = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === "string");

/** Whether a stdio `command` is one executable token: a bare name, or a `./` path that stays inside the plugin. */
function isCommand(root: string, command: string): boolean {
  if (command.length === 0 || /[\s\\]/.test(command)) return false;
  if (!command.startsWith("./")) return !command.includes("/") && command !== "." && command !== "..";
  const rel = normalize(command);
  return rel !== "." && !rel.endsWith("/") && inside(root, join(root, rel));
}

/** Whether `cwd` has one of the standard's three forms and stays, once expanded, inside the folder it starts from. */
function isCwd(cwd: string): boolean {
  if (!CWD.test(cwd) || cwd.includes("\\")) return false;
  // The standard's expansion: one textual pass over both placeholders, nothing re-read.
  const expanded = cwd.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, name: string) => (name === "PLUGIN_ROOT" ? ROOT_AT : DATA_AT));
  const base = cwd.startsWith("${PLUGIN_DATA}") ? DATA_AT : ROOT_AT;
  return inside(base, posix.resolve(ROOT_AT, expanded));
}

/** Whether a remote entry's URL is absolute http(s), with no user information or fragment, and https unless it is loopback. */
function isRemoteUrl(url: string): boolean {
  if (url.includes("#") || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.username || parsed.password) return false;
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(parsed));
}

function readServer(root: string, name: string, raw: unknown): PluginMcpServer | NotImported {
  const skip = (reason: Message): NotImported => ({ component: "mcp-server", name, reason });
  if (!isObject(raw)) return skip(say("notImported.serverNotObject"));
  if (raw.type === undefined) return skip(say("notImported.serverNoType"));
  const fields = raw.type === "stdio" ? STDIO_FIELDS : raw.type === "streamable-http" || raw.type === "sse" ? REMOTE_FIELDS : null;
  if (!fields) return skip(say("notImported.serverTypeNotStdio"));
  const unknown = Object.keys(raw).find((key) => !fields.has(key));
  if (unknown !== undefined) return skip(storable(unknown) ? say("notImported.serverFieldNamed", { field: cut(unknown, 100) }) : say("notImported.serverField"));
  if (!allStorable(raw)) return skip(say("notImported.settings"));
  if (raw.type === "stdio") {
    if (typeof raw.command !== "string" || !isCommand(root, raw.command)) return skip(say("notImported.serverCommand"));
    if (raw.args !== undefined && !strings(raw.args)) return skip(say("notImported.serverArgs"));
    if (raw.env !== undefined && !stringRecord(raw.env)) return skip(say("notImported.serverEnv"));
    if (raw.env && Object.keys(raw.env).some((key) => RESERVED_ENV.has(key))) return skip(say("notImported.serverEnvReserved"));
    if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || !isCwd(raw.cwd))) return skip(say("notImported.serverCwd"));
    return {
      name,
      type: "stdio",
      command: raw.command,
      args: raw.args ?? [],
      env: raw.env ?? {},
      ...(raw.cwd !== undefined ? { cwd: raw.cwd } : {}),
      settings: [],
    };
  }
  if (typeof raw.url !== "string" || !isRemoteUrl(raw.url)) return skip(say("notImported.serverUrl"));
  const headers = raw.headers ?? {};
  if (!stringRecord(headers) || !Headers.safeParse(headers).success) return skip(say("notImported.serverHeaders"));
  const names = Object.keys(headers).map((h) => h.toLowerCase());
  if (new Set(names).size !== names.length) return skip(say("notImported.serverHeaderTwice"));
  // The standard expands nothing in a URL or a header, where Dispand's installer reads `${…}` as a setting.
  if ([raw.url, ...Object.values(headers)].some((s) => s.includes("${"))) return skip(say("notImported.serverUrlSetting"));
  return { name, type: "http", url: raw.url, transport: raw.type === "sse" ? "sse" : "streamable-http", headers, settings: [] };
}

/** `mcp.json`: checked whole (a failure disables MCP for the plugin), then entry by entry (a bad one is skipped alone). */
function readServers(root: string, mcpSchema: string, notImported: Notes): PluginMcpServer[] {
  const kind = kindAt(root, "mcp.json");
  if (kind === "absent") return [];
  const disable = (key: Extract<MessageKey, `notImported.mcpFile.${string}`>) => {
    notImported.push({ component: "mcp-server", name: "mcp.json", reason: say(key) });
    return [];
  };
  if (kind !== "file") return disable("notImported.mcpFile.notFile");
  const bytes = readRegular(root, "mcp.json", MAX_JSON_BYTES);
  if (!bytes) return disable("notImported.mcpFile.tooLarge");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return disable("notImported.mcpFile.notJson");
  }
  if (!isObject(raw)) return disable("notImported.mcpFile.notObject");
  if (typeof raw.$schema !== "string" || !MCP_SCHEMAS.has(raw.$schema)) return disable("notImported.mcpFile.schema");
  if (raw.$schema !== mcpSchema) return disable("notImported.mcpFile.otherVersion");
  if (!isObject(raw.mcpServers)) return disable("notImported.mcpFile.serversNotObject");
  if (Object.keys(raw).some((key) => key !== "$schema" && key !== "mcpServers")) return disable("notImported.mcpFile.field");
  const servers: PluginMcpServer[] = [];
  let count = 0;
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    spend(1);
    if (++count > MAX_SERVERS) throw new PluginError("pluginRead.tooManyServers", { max: MAX_SERVERS });
    if (name.length === 0 || name.length > 100 || !storable(name)) {
      notImported.push({ component: "mcp-server", name: storable(name) ? cut(name, 100) || "…" : "…", reason: say("notImported.serverName") });
      continue;
    }
    const server = readServer(root, name, entry);
    if ("component" in server) notImported.push(server);
    else servers.push(server);
  }
  return servers;
}

/**
 * A plugin in the Agent Plugins 1.0.0 layout, read from its root folder (from
 * `resolvePluginRoot`) without running anything, under `readPlugin`'s budget. A manifest that
 * isn't valid rejects the plugin (`PluginError`) before anything else is read; components come
 * only from `skills/`, `mcp.json` and the `com.dispand/` definitions, each failure isolated to its component or entry and listed
 * as not imported. Every file is `lstat`ed: links are never followed.
 */
export function readStandardPlugin(root: string, links: string[]): PluginContents {
  const notImported = new Notes();
  if (links.includes("plugin.json")) throw new PluginError("pluginRead.manifest.link");
  const { mcpSchema, version, description } = readManifest(root, notImported);
  // The checkout's links are gone from it (`fetchGit`): listed here, never read.
  notImported.push(...links.map((name): NotImported => ({ component: "file", name, reason: say("notImported.symlink") })));
  const skills = readSkills(root, notImported);
  const mcpServers = readServers(root, mcpSchema, notImported);
  const definitions = readDefinitions(root, { skills: skills.map((s) => s.name), servers: mcpServers.map((s) => s.name) }, notImported);
  return {
    layout: "standard",
    version,
    skills,
    mcpServers,
    agents: [],
    definitions: { ...(description !== undefined ? { description } : {}), ...definitions },
    notImported: notImported.list(),
  };
}
