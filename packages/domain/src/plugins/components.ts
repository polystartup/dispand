import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { skillPackages } from "../db/schema.ts";
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

/** The server's name as its tool's: a plugin's tools share no name with the owner's own. */
export const toolName = (server: string): string => cut(server.trim() || "server", 100);


/** Retained workspace skills keep their names and agent links when a plugin is reinstalled. */
export async function skillPackageName(tx: Tx, ownerId: string, base: string): Promise<string> {
  const taken = new Set((await tx.select({ name: skillPackages.name }).from(skillPackages).where(eq(skillPackages.ownerId, ownerId))).map((p) => p.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) {
    const suffix = `-${n}`;
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  return name;
}
