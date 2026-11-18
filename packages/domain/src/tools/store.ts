import { ORPCError } from "@orpc/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type Holder } from "../agents/usage.ts";
import type { Db, Tx } from "../db/client.ts";
import { posix } from "node:path";
import { PluginServer } from "@dispand/runner-protocol";
import { agentTools, pluginFiles, plugins, runners, tools as toolsTable } from "../db/schema.ts";
import type { PluginComponents } from "../plugins/read-plugin.ts";
import { runnerTarget } from "../plugins/runner-servers.ts";
import { isLoopback } from "../harnesses/procedures.ts";
import { newId } from "../ids.ts";
import { logError } from "../log.ts";
import { message, plainText, stored, type MessageKey, type MessageValues } from "../messages/index.ts";
import { type RunnerHub, RunnerRequestFailed } from "../runners/hub.ts";
import { secretAad, type SecretBox } from "../secrets.ts";
import { catalogEntry, signInOf } from "./catalog.ts";
import { ToolError, type ToolAction, type ToolAuth, type ToolConnector, type ToolTarget, type ToolTransport } from "./mcp.ts";
import { oauthStore } from "./oauth-store.ts";
import type { InitialContext } from "../rpc/context.ts";
import { uniqueConstraint } from "../db/unique.ts";

export type Row = typeof toolsTable.$inferSelect;

/**
 * Where a tool's header `name` is sealed: its AAD names the row, the header and the origin of the
 * tool's `url`, so a header opens only while the tool calls the origin it was entered for. A secret
 * URL's template has the filled URL's origin (a setting goes only in its path or query).
 */
export const headerAad = (toolId: string, name: string, url: string) => secretAad("tools", toolId, `header:${name}`, originOf(url));
/** Where a tool's secret URL is sealed. */
export const urlAad = (toolId: string) => secretAad("tools", toolId, "url");

export const MAX_HEADERS = 20;

/** A URL's origin (scheme, host, port); empty for what isn't a URL. A template's `${VAR}` in the path or query doesn't change it. */
export const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

export const Name = z.string().trim().min(1).max(100);
export const Url = z.url({ protocol: /^https?$/ }).max(2000);
// RFC 9110 token; stored in lower case (header names are case-insensitive).
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
// No control characters but tab: a value is one header line.
export const oneLine = (v: string) => [...v].every((c) => c === "\t" || (c >= " " && c !== "\u007f"));
export const HeaderValue = z.string().trim().max(4000).refine(oneLine, "tools.headerOneLine" satisfies MessageKey);
/** Header name → value. On update, "" removes the header and an absent name keeps it. */
export const Headers = z
  .record(z.string().regex(HEADER_NAME), HeaderValue)
  .refine((h) => Object.keys(h).length <= MAX_HEADERS, "tools.headersMax" satisfies MessageKey);

/** The key of a holder's message when the tool stays on its runner. */
export const STAYS: Record<Holder["key"], MessageKey> = {
  "tools.holder.agent": "tools.holder.stays.agent",
  "tools.holder.skill": "tools.holder.stays.skill",
  "tools.holder.workflow": "tools.holder.stays.workflow",
  "tools.holder.run": "tools.holder.stays.run",
};

export function bad(key: MessageKey, values?: MessageValues): never {
  throw new ORPCError("BAD_REQUEST", message(key, values));
}

type PluginRef = { id: string; name: string };
/**
 * A plugin's stdio server on a runner, as its page shows it: the plugin's name, the launch
 * entry and the digest the runner must allow, and whether the command is one of the plugin's
 * files (else the runner's record covers the command line, not what it runs).
 */
type PluginServerView = { plugin: string; entry: NonNullable<PluginComponents["mcpServers"][number]["entry"]>; digest: string; commandIsFile: boolean };

/**
 * The owner's view: header names only, never their values (sealed or not). A secret URL shows
 * as its template, with `urlSet`.
 */
function toView(row: Row, plugin: PluginRef | null, pluginServer: PluginServerView | null = null) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    urlSet: row.urlSealed !== null,
    transport: row.transport,
    headerNames: Object.keys(row.headersSealed).sort(),
    overridden: row.overridden,
    auth: row.auth,
    // OAuth: connected, needs authorization, or re-authorize; and the client id the owner entered (its secret stays sealed).
    oauthStatus: row.auth === "oauth" ? (row.oauthStatus ?? "authorize") : null,
    enteredClientId: row.oauthClientId,
    // Whether it waits for its owner to sign in, and where in the app they do it.
    signIn: signInOf(row),
    signInPath: `/settings/tools?tool=${encodeURIComponent(row.id)}`,
    actions: row.actions,
    disabled: row.disabled,
    actionsError: row.actionsError,
    refreshedAt: row.refreshedAt,
    catalogId: row.catalogId,
    runnerId: row.runnerId,
    runnerTool: row.runnerTool,
    plugin,
    pluginServer,
    createdAt: row.createdAt,
  };
}
export type ToolView = ReturnType<typeof toView>;

/** The views of `rows`, with the plugin each came from. */
export async function views(db: Db, rows: Row[]): Promise<ToolView[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.pluginId ? [r.pluginId] : [])))];
  const found = ids.length ? await db.select({ id: plugins.id, name: plugins.name, digest: plugins.digest, components: plugins.components }).from(plugins).where(inArray(plugins.id, ids)) : [];
  return Promise.all(
    rows.map(async (r) => {
      const plugin = found.find((p) => p.id === r.pluginId);
      const entry = r.kind === "runner" && r.runnerTool === null ? plugin?.components.mcpServers.find((s) => s.type === "stdio" && s.name === r.pluginComponent)?.entry : undefined;
      const file = entry?.command.startsWith("./") ? await db.select({ path: pluginFiles.path }).from(pluginFiles).where(and(eq(pluginFiles.pluginId, plugin!.id), eq(pluginFiles.path, posix.normalize(entry.command)))) : [];
      // Only what its runner would be sent (`PluginServer`): its name and digest go into a command the owner copies.
      const server = plugin && PluginServer.safeParse({ tool: r.id, plugin: plugin.name, digest: plugin.digest, entry }).success ? { plugin: plugin.name, entry: entry!, digest: plugin.digest!, commandIsFile: file.length > 0 } : null;
      return toView(r, plugin ? { id: plugin.id, name: plugin.name } : null, server);
    }),
  );
}

export const view = async (db: Db, row: Row) => (await views(db, [row]))[0]!;

/** Lower-cased names; two spellings of one name are refused. */
export function normalize(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key in out) bad("tools.headerTwice", { header: key });
    out[key] = value;
  }
  return out;
}

/**
 * The rules the schema can't say alone: credentials go in headers, and headers, a secret URL or
 * an OAuth token only over https (or to this machine).
 */
export function checkTarget(url: string, hasSecrets: boolean) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) bad("tools.credentialsInUrl");
  if (hasSecrets && parsed.protocol === "http:" && !isLoopback(parsed)) bad("tools.headersHttps");
}

export async function find(db: Db, ownerId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(toolsTable)
    .where(and(eq(toolsTable.id, id), eq(toolsTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND", message("tools.notFound"));
  return row;
}

export function nameTaken(error: unknown, name: string): never {
  if (uniqueConstraint(error) !== null) throw new ORPCError("CONFLICT", message("tools.exists", { name }));
  throw error;
}

/** The tool's target with its headers opened. Server-only: they go to the tool's URL and nowhere else. */
export function toolTarget(row: Row, secrets: SecretBox): ToolTarget {
  if (row.url === null || row.transport === null) throw new Error(`tool ${row.id} isn't an HTTP tool`);
  const headers = Object.fromEntries(Object.entries(row.headersSealed).map(([name, sealed]) => [name, secrets.open(sealed, headerAad(row.id, name, row.url!))]));
  // A catalog entry's sign-in asks for its own scopes, not every one the server supports.
  const entry = row.auth === "oauth" ? catalogEntry(row.catalogId) : undefined;
  const request = entry?.kind === "http" && entry.oauth ? { oauthRequest: entry.oauth } : {};
  if (row.urlSealed === null) return { url: row.url, transport: row.transport, headers, ...request };
  const secret = JSON.parse(secrets.open(row.urlSealed, urlAad(row.id))) as { url: string; secrets: string[] };
  return { url: secret.url, transport: row.transport, headers, urlSecrets: secret.secrets, ...request };
}

/**
 * The target a listing or call connects to: with an OAuth tool's sealed state, which the
 * connector's provider reads and refreshes. A tool not connected fails here, before any request,
 * so a sign-in that stopped working is never tried again until its owner re-authorizes it.
 */
export function connectionTarget(db: Db, secrets: SecretBox, row: Row): ToolTarget {
  const target = toolTarget(row, secrets);
  // A catalog tool added before its key: never called without it (some servers answer keyless).
  if (row.auth !== "oauth" && row.pluginId === null && signInOf(row) === "needed") throw new ToolError("tools.fail.needsSignIn", { name: row.name });
  if (row.auth !== "oauth") return target;
  if (row.oauthStatus === "reauthorize") throw new ToolError("tools.fail.reauthorize");
  if (row.oauthStatus !== "connected") throw new ToolError("tools.fail.notConnected", { name: row.name });
  return { ...target, oauth: oauthStore(db, secrets, row) };
}

/**
 * Lists the tool's actions again and stores them, or the reason it failed (the last actions
 * stay). The reason is a `ToolError`'s short text, never the server's answer.
 */
export async function refreshActions(db: Db, secrets: SecretBox, connector: ToolConnector, row: Row): Promise<Row> {
  let values: Partial<Row>;
  try {
    values = { actions: await connector.listActions(connectionTarget(db, secrets, row)), actionsError: null, refreshedAt: new Date() };
  } catch (error) {
    if (!(error instanceof ToolError)) logError("tools.refresh failed", error, { ref: row.id });
    values = { actionsError: error instanceof ToolError ? error.stored : stored("tools.fail.listFailed") };
  }
  const [updated] = await db
    .update(toolsTable)
    .set(values)
    .where(and(eq(toolsTable.id, row.id), eq(toolsTable.ownerId, row.ownerId)))
    .returning();
  // Deleted meanwhile: what was listed belongs to nobody.
  if (!updated) throw new ORPCError("NOT_FOUND", message("tools.notFound"));
  return updated;
}

/**
 * Asks the tool's runner to list its actions, and stores them or the reason it failed (the last
 * actions stay). The reason is the runner's own words, or "runner offline".
 */
export async function refreshRunnerActions(db: Db, hub: Pick<RunnerHub, "request">, row: Row): Promise<Row> {
  let values: Partial<Row>;
  const target = await runnerTarget(db, row);
  if (typeof target === "object" && "error" in target) values = { actionsError: target.error };
  else {
    try {
      const reply = await hub.request(row.runnerId!, { type: "tool.discover", requestId: newId("req"), tool: target });
      values = reply.actions ? { actions: reply.actions, actionsError: null, refreshedAt: new Date() } : { actionsError: reply.error === undefined ? stored("tools.fail.runnerNoActions") : plainText(reply.error) };
    } catch (error) {
      if (!(error instanceof RunnerRequestFailed)) throw error;
      values = { actionsError: stored(error.message === "timed out" ? "tools.fail.runnerTimeout" : "tools.fail.runnerOffline") };
    }
  }
  const [updated] = await db
    .update(toolsTable)
    .set(values)
    .where(and(eq(toolsTable.id, row.id), eq(toolsTable.ownerId, row.ownerId)))
    .returning();
  if (!updated) throw new ORPCError("NOT_FOUND", message("tools.notFound"));
  return updated;
}

/** Lists the tool's actions again, however it is reached. */
export function refreshAny(context: Pick<InitialContext, "db" | "secrets" | "tools" | "hub">, row: Row): Promise<Row> {
  return row.kind === "runner" ? refreshRunnerActions(context.db, context.hub, row) : refreshActions(context.db, context.secrets, context.tools, row);
}

/**
 * Checks that `runnerTool` is an MCP server the owner's runner `runnerId` reported in its last
 * `hello`: a runner tool is only ever one the machine's own config names.
 */
export async function requireRunnerTool(db: Db | Tx, ownerId: string, runnerId: string, runnerTool: string | null) {
  const [runner] = await db
    .select({ tools: runners.tools })
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.ownerId, ownerId), isNull(runners.revokedAt)));
  if (!runner) throw new ORPCError("NOT_FOUND", message("tools.runnerNotFound"));
  if (runnerTool !== null && !runner.tools.includes(runnerTool)) {
    bad("tools.runnerNoServer", { runnerTool });
  }
}

export type ToolFields = {
  name: string;
  url: string;
  transport: ToolTransport;
  headers: Record<string, string>;
  /** OAuth: no headers; its owner connects it afterwards. Otherwise it follows from the headers. */
  oauth?: boolean;
  catalogId?: string;
  /** The actions a poll may read (a catalog entry's); absent: the ones the server calls read-only. */
  pollable?: string[];
  disabled?: string[];
  /** The actions it starts with (a catalog entry's), until its first listing. */
  actions?: ToolAction[];
  /** The URL to call when it holds secrets (named in `secrets`); `url` is then its template, shown in its place. */
  secretUrl?: { url: string; secrets: string[] };
  plugin?: { id: string; component: string };
};

export const authOf = (oauth: boolean, headers: Record<string, unknown>): ToolAuth => (oauth ? "oauth" : Object.keys(headers).length > 0 ? "headers" : "none");

/** A tool's OAuth columns cleared: a new server, or another way to sign in, starts over. */
export const NO_OAUTH = { oauthSealed: null, oauthStatus: null, oauthStateHash: null, oauthClientId: null } as const;

/**
 * Saves a new HTTP tool with its headers (and secret URL) sealed. The one way a tool row is
 * written; its actions are listed afterwards (`refreshActions`), outside any transaction.
 */
export async function insertTool(db: Db | Tx, secrets: SecretBox, ownerId: string, input: ToolFields): Promise<Row> {
  // Every path in (form, catalog, plugin) is held to the form's rules.
  if (!Name.safeParse(input.name).success) bad("tools.name");
  if (!Url.safeParse(input.secretUrl?.url ?? input.url).success || input.url.length > 2000) bad("tools.notUrl");
  if (!Headers.safeParse(input.headers).success) bad("tools.headersInvalid");
  const headers = normalize(input.headers);
  for (const [name, value] of Object.entries(headers)) if (!value) bad("tools.headerNoValue", { header: name });
  if (input.oauth && (Object.keys(headers).length > 0 || input.secretUrl)) bad("tools.oauthNoHeaders");
  checkTarget(input.secretUrl?.url ?? input.url, Object.keys(headers).length > 0 || input.secretUrl !== undefined || input.oauth === true);
  const id = newId("tool");
  const headersSealed = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, secrets.seal(value, headerAad(id, name, input.url))]));
  const [row] = await db
    .insert(toolsTable)
    .values({
      id,
      ownerId,
      name: input.name,
      kind: "http",
      url: input.url,
      urlSealed: input.secretUrl === undefined ? null : secrets.seal(JSON.stringify(input.secretUrl), urlAad(id)),
      transport: input.transport,
      headersSealed,
      auth: authOf(input.oauth === true, headers),
      oauthStatus: input.oauth ? "authorize" : null,
      catalogId: input.catalogId ?? null,
      pollable: input.pollable ?? null,
      disabled: input.disabled ?? [],
      actions: input.actions ?? [],
      pluginId: input.plugin?.id ?? null,
      pluginComponent: input.plugin?.component ?? null,
      upstream: input.plugin ? { name: input.name, url: input.url, transport: input.transport } : null,
    })
    .returning()
    .catch((e: unknown) => nameTaken(e, input.name));
  return row!;
}

/**
 * The tool now stands for another server: the actions its agents let run unasked were the old
 * server's, so every action asks again, whatever it is called there.
 */
export async function askAgain(db: Db | Tx, toolId: string) {
  await db.update(agentTools).set({ unasked: [] }).where(eq(agentTools.toolId, toolId));
}

/** The column of a tool's field a plugin sets. */
export const toolColumn = (field: string) => (field === "url" ? toolsTable.url : field === "transport" ? toolsTable.transport : toolsTable.name);

/** Points the tool at a new (plain) URL, under the same rules as `update`; its actions are listed again afterwards. */
export async function retarget(db: Db | Tx, row: Row, url: string, transport: ToolTransport): Promise<Row> {
  if (!Url.safeParse(url).success) bad("tools.notUrl");
  // As in `update`: another origin or transport starts without the headers.
  const headersSealed = originOf(url) !== originOf(row.url!) || transport !== row.transport ? {} : row.headersSealed;
  checkTarget(url, Object.keys(headersSealed).length > 0 || row.auth === "oauth");
  const [updated] = await db
    .update(toolsTable)
    .set({ url, urlSealed: null, transport, headersSealed, auth: authOf(row.auth === "oauth", headersSealed), permissionRevision: sql`${toolsTable.permissionRevision} + 1`, actions: [], refreshedAt: null, ...(row.auth === "oauth" ? { ...NO_OAUTH, oauthStatus: "authorize" as const } : {}) })
    .where(and(eq(toolsTable.id, row.id), eq(toolsTable.ownerId, row.ownerId)))
    .returning();
  if (!updated) throw new ORPCError("NOT_FOUND", message("tools.notFound"));
  await askAgain(db, updated.id);
  return updated;
}

export async function createTool(context: Pick<InitialContext, "db" | "secrets" | "tools"> & { ownerId: string }, input: ToolFields) {
  const row = await insertTool(context.db, context.secrets, context.ownerId, input);
  // A tool waiting for its sign-in (an OAuth tool, a catalog tool without its key) lists its actions once signed in.
  return view(context.db, row.auth === "oauth" || signInOf(row) === "needed" ? row : await refreshActions(context.db, context.secrets, context.tools, row));
}
