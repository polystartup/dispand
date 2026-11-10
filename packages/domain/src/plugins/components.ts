import { ORPCError } from "@orpc/server";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { agents, agentSkills, agentTools, skillPackages, tools } from "../db/schema.ts";
import { Headers, Url, type ToolFields } from "../tools/procedures.ts";
import type { PluginMcpServer } from "./read-plugin.ts";

/**
 * What a value filling a URL placeholder may hold: characters a URL's path and query keep as
 * they are (RFC 3986 unreserved), so the server sees it spelled exactly so and `redact` finds it
 * in what comes back.
 */
export const URL_SECRET = /^[A-Za-z0-9._~-]+$/;

/**
 * Whether every placeholder of a URL template lands in its path or query, never its scheme,
 * user, host, port or fragment, as the URL parser the request goes through reads it: each
 * placeholder becomes a marker URLs keep as it is, and the parsed URL must hold each in its path
 * or query only.
 */
export function placeholdersInPathOrQuery(template: string): boolean {
  const markers: string[] = [];
  const marked = template.replace(PLACEHOLDER, () => {
    const marker = `dispandsetting${markers.length}x`;
    markers.push(marker);
    return marker;
  });
  if (!URL.canParse(marked)) return false;
  const url = new URL(marked);
  const kept = url.pathname + url.search;
  const rest = url.protocol + url.username + url.password + url.host + url.hash;
  return markers.every((m) => kept.includes(m) && !rest.includes(m));
}

/** `${VAR}` and `${VAR:-default}`, as Claude Code expands them in `.mcp.json`. */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export const hasPlaceholder = (text: string) => text.search(PLACEHOLDER) !== -1;

function bad(message: string): never {
  throw new ORPCError("BAD_REQUEST", { message });
}

/**
 * `text` with its placeholders filled from the owner's settings, else their defaults (public,
 * from the plugin); each setting used is added to `used`. Values never reach an error.
 */
function fill(text: string, values: Record<string, string>, server: string, used: string[] = []): string {
  return text.replace(PLACEHOLDER, (_, name: string, fallback: string | undefined) => {
    const value = values[name];
    if (value) {
      used.push(value);
      return value;
    }
    if (fallback === undefined) bad(`The MCP server ${server} needs ${name}`);
    return fallback;
  });
}

/** `s` cut to `max` code points. */
const cut = (s: string, max: number) => [...s].slice(0, max).join("");

/**
 * The HTTP tool a plugin's HTTP server becomes, its placeholders filled from `values`. A
 * placeholder in the URL makes the whole URL a secret: the tool shows its template and calls
 * the filled one, sealed. The headers are sealed when the tool is saved (`insertTool`).
 */
export function httpTool(server: Extract<PluginMcpServer, { type: "http" }>, values: Record<string, string>, pluginId: string): Omit<ToolFields, "name"> {
  // The form's limit first: everything after reads the whole URL.
  if (server.url.length > 2000) bad(`The MCP server ${server.name}'s URL is longer than 2,000 characters`);
  const secret = hasPlaceholder(server.url);
  // Only a path or query is kept as it is written: a host is lower-cased (and may be encoded).
  if (secret && !placeholdersInPathOrQuery(server.url)) bad(`The MCP server ${server.name}'s URL needs a setting in its host: not supported`);
  const urlSecrets: string[] = [];
  const url = fill(server.url, values, server.name, urlSecrets);
  if (!urlSecrets.every((v) => URL_SECRET.test(v))) bad(`A setting of the MCP server ${server.name}'s URL may hold only letters, digits and . _ ~ -`);
  if (!Url.safeParse(url).success) bad(`The MCP server ${server.name}'s URL isn't an http(s) URL`);
  const headers = Headers.safeParse(Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [name, fill(value, values, server.name)])));
  if (!headers.success) bad(`The MCP server ${server.name}'s headers aren't valid`);
  return {
    url: secret ? server.url : url,
    ...(secret ? { secretUrl: { url, secrets: urlSecrets } } : {}),
    transport: server.transport,
    headers: headers.data,
    plugin: { id: pluginId, component: server.name },
  };
}

/** The server's name for its tool, or `<plugin>-<server>` when the owner already has a tool called so. */
export async function toolName(tx: Tx, ownerId: string, server: string, plugin: string): Promise<string> {
  const base = server.trim() || "server";
  const candidates = [cut(base, 100), cut(`${plugin}-${base}`, 100)];
  const taken = await tx
    .select({ name: tools.name })
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), inArray(sql`lower(${tools.name})`, candidates.map((c) => c.toLowerCase()))));
  const free = candidates.find((c) => !taken.some((t) => t.name.toLowerCase() === c.toLowerCase()));
  // Both taken: the insert says which name is.
  return free ?? candidates[1]!;
}

/** The agent's name, or `<name> (<plugin>)` when the owner already has an agent called so. */
export async function agentName(tx: Tx, ownerId: string, name: string, plugin: string): Promise<string> {
  const [taken] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.name, name)))
    .limit(1);
  return taken ? cut(`${name} (${plugin})`, 100) : name;
}

/**
 * Why the plugin can't go: something outside it uses one of its components (an agent its skills
 * or tools, a skill package that requires one of its tools). Its own agents go with it. A
 * workflow using its agents is checked by the caller (`agentInUse`).
 */
export async function pluginHolder(tx: Tx, ownerId: string, plugin: { id: string; name: string }): Promise<string | undefined> {
  const outside = or(isNull(agents.pluginId), ne(agents.pluginId, plugin.id));
  const [skillUser] = await tx
    .select({ name: agents.name })
    .from(agentSkills)
    .innerJoin(agents, eq(agents.id, agentSkills.agentId))
    .innerJoin(skillPackages, eq(skillPackages.id, agentSkills.packageId))
    .where(and(eq(skillPackages.pluginId, plugin.id), outside))
    .limit(1);
  if (skillUser) return `The agent “${skillUser.name}” uses ${plugin.name}'s skills: remove them from it first`;
  const [toolUser] = await tx
    .select({ agent: agents.name, tool: tools.name })
    .from(agentTools)
    .innerJoin(agents, eq(agents.id, agentTools.agentId))
    .innerJoin(tools, eq(tools.id, agentTools.toolId))
    .where(and(eq(tools.pluginId, plugin.id), outside))
    .limit(1);
  if (toolUser) return `The agent “${toolUser.agent}” uses ${plugin.name}'s tool “${toolUser.tool}”: remove it from the agent first`;
  const own = await tx.select({ id: tools.id, name: tools.name }).from(tools).where(eq(tools.pluginId, plugin.id));
  for (const tool of own) {
    const [pkg] = await tx
      .select({ name: skillPackages.name })
      .from(skillPackages)
      .where(
        and(
          eq(skillPackages.ownerId, ownerId),
          or(isNull(skillPackages.pluginId), ne(skillPackages.pluginId, plugin.id)),
          sql`${skillPackages.requiredToolIds} @> ${JSON.stringify([tool.id])}::jsonb`,
        ),
      )
      .limit(1);
    if (pkg) return `The skill “${pkg.name}” requires ${plugin.name}'s tool “${tool.name}”: remove it from the skill first`;
  }
  return undefined;
}
