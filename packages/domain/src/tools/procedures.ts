import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { strictPermissionsOf } from "../agents/tool-ask.ts";
import { toolHolder, type Holder } from "../agents/usage.ts";
import type { Db, Tx } from "../db/client.ts";
import { McpServerName } from "@dispand/runner-protocol";
import { posix } from "node:path";
import { PluginServer } from "@dispand/runner-protocol";
import { agentTools, pluginFiles, plugins, runners, tools as toolsTable } from "../db/schema.ts";
import type { PluginComponents } from "../plugins/read-plugin.ts";
import { runnerTarget } from "../plugins/runner-servers.ts";
import { isLoopback } from "../harnesses/procedures.ts";
import { newId } from "../ids.ts";
import { logError } from "../log.ts";
import { message, plainText, stored, type MessageKey, type MessageValues } from "../messages/index.ts";
import { authed, base } from "../rpc/context.ts";
import { type RunnerHub, RunnerRequestFailed } from "../runners/hub.ts";
import { secretAad, type SecretBox } from "../secrets.ts";
import { CATALOG, catalogEntry, declaredActions, defaultDisabled, fillHeaders, MissingSetting, runnerSnippet, searchCatalog, signInOf } from "./catalog.ts";
import { AUTHS, ToolError, TRANSPORTS, type ToolAction, type ToolAuth, type ToolConnector, type ToolTarget, type ToolTransport } from "./mcp.ts";
import { oauthStep, oauthStore } from "./oauth-store.ts";
import { pollableActions } from "./pollable.ts";
import type { InitialContext } from "../rpc/context.ts";
import { overriddenAfter, refuseOwnDelete } from "../plugins/overrides.ts";

const owner = base.use(authed);

type Row = typeof toolsTable.$inferSelect;

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
const originOf = (url: string) => {
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
const oneLine = (v: string) => [...v].every((c) => c === "\t" || (c >= " " && c !== "\u007f"));
export const HeaderValue = z.string().trim().max(4000).refine(oneLine, "tools.headerOneLine" satisfies MessageKey);
/** Header name → value. On update, "" removes the header and an absent name keeps it. */
export const Headers = z
  .record(z.string().regex(HEADER_NAME), HeaderValue)
  .refine((h) => Object.keys(h).length <= MAX_HEADERS, "tools.headersMax" satisfies MessageKey);

/** The key of a holder's message when the tool stays on its runner. */
const STAYS: Record<Holder["key"], MessageKey> = {
  "tools.holder.agent": "tools.holder.stays.agent",
  "tools.holder.skill": "tools.holder.stays.skill",
  "tools.holder.workflow": "tools.holder.stays.workflow",
  "tools.holder.run": "tools.holder.stays.run",
};

function bad(key: MessageKey, values?: MessageValues): never {
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
async function views(db: Db, rows: Row[]): Promise<ToolView[]> {
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

const view = async (db: Db, row: Row) => (await views(db, [row]))[0]!;
export { view as toolView };

/** Lower-cased names; two spellings of one name are refused. */
function normalize(headers: Record<string, string>): Record<string, string> {
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
function checkTarget(url: string, hasSecrets: boolean) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) bad("tools.credentialsInUrl");
  if (hasSecrets && parsed.protocol === "http:" && !isLoopback(parsed)) bad("tools.headersHttps");
}

async function find(db: Db, ownerId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(toolsTable)
    .where(and(eq(toolsTable.id, id), eq(toolsTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND", message("tools.notFound"));
  return row;
}

export function nameTaken(error: unknown, name: string): never {
  const e = error as { code?: string; cause?: { code?: string } };
  if (e.code === "23505" || e.cause?.code === "23505") throw new ORPCError("CONFLICT", message("tools.exists", { name }));
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
function refreshAny(context: Pick<InitialContext, "db" | "secrets" | "tools" | "hub">, row: Row): Promise<Row> {
  return row.kind === "runner" ? refreshRunnerActions(context.db, context.hub, row) : refreshActions(context.db, context.secrets, context.tools, row);
}

/**
 * Checks that `runnerTool` is an MCP server the owner's runner `runnerId` reported in its last
 * `hello`: a runner tool is only ever one the machine's own config names.
 */
async function requireRunnerTool(db: Db | Tx, ownerId: string, runnerId: string, runnerTool: string | null) {
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

const authOf = (oauth: boolean, headers: Record<string, unknown>): ToolAuth => (oauth ? "oauth" : Object.keys(headers).length > 0 ? "headers" : "none");

/** A tool's OAuth columns cleared: a new server, or another way to sign in, starts over. */
const NO_OAUTH = { oauthSealed: null, oauthStatus: null, oauthStateHash: null, oauthClientId: null } as const;

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
async function askAgain(db: Db | Tx, toolId: string) {
  await db.update(agentTools).set({ unasked: [] }).where(eq(agentTools.toolId, toolId));
}

/** The column of a tool's field a plugin sets. */
const toolColumn = (field: string) => (field === "url" ? toolsTable.url : field === "transport" ? toolsTable.transport : toolsTable.name);

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

const RunnerTool = z.object({
  kind: z.literal("runner"),
  name: Name,
  runnerId: z.string().max(100),
  runnerTool: McpServerName,
  /** The runner entry of the catalog it was set up from: its flags, the actions a poll may read and its poll preset. */
  catalogId: z
    .string()
    .max(64)
    .refine((id) => catalogEntry(id)?.kind === "runner", "tools.notRunnerEntry" satisfies MessageKey)
    .optional(),
});

/** Saves a runner tool, once its runner reports the server; its actions are then listed by the runner. */
async function createRunnerTool(context: Pick<InitialContext, "db" | "hub"> & { ownerId: string }, input: z.infer<typeof RunnerTool>) {
  await requireRunnerTool(context.db, context.ownerId, input.runnerId, input.runnerTool);
  const entry = catalogEntry(input.catalogId);
  const [row] = await context.db
    .insert(toolsTable)
    .values({
      id: newId("tool"),
      ownerId: context.ownerId,
      name: input.name,
      kind: "runner",
      runnerId: input.runnerId,
      runnerTool: input.runnerTool,
      catalogId: entry?.id ?? null,
      pollable: entry?.pollable ?? null,
      disabled: defaultDisabled(entry ?? {}),
    })
    .returning()
    .catch((e: unknown) => nameTaken(e, input.name));
  return view(context.db, await refreshRunnerActions(context.db, context.hub, row!));
}

const create = owner
  .input(
    z.union([RunnerTool, z.object({ kind: z.literal("http").optional(), name: Name, url: Url, transport: z.enum(TRANSPORTS), headers: Headers, auth: z.enum(AUTHS).optional() })]),
  )
  .handler(({ input, context }) => {
    if (input.kind === "runner") return createRunnerTool(context, input);
    const { name, url, transport, headers, auth } = input;
    return createTool(context, { name, url, transport, headers, oauth: auth === "oauth" });
  });

/**
 * Adds a tool by its address alone: a name, a URL without credentials, a transport. What an
 * agent may propose (a person approves the address before anything is fetched from it); the
 * owner enters the server's headers afterwards, on the tool's page.
 */
const add = owner
  .input(
    z.strictObject({
      name: Name,
      url: Url.refine((u) => {
        const parsed = URL.parse(u);
        return parsed !== null && parsed.username === "" && parsed.password === "";
      }, "tools.urlCredentials" satisfies MessageKey),
      transport: z.enum(TRANSPORTS),
    }),
  )
  .handler(({ input, context }) => createTool(context, { ...input, headers: {} }));

/** The catalog's entries, searched by name and description. Templates and setting names only: no value. */
const catalog = owner.input(z.object({ query: z.string().max(100).optional() })).handler(({ input }) => searchCatalog(input.query));

type HttpEntry = Extract<(typeof CATALOG)[number], { kind: "http" }>;

/** A tool's fields from an HTTP entry: its address, the actions it declares, and what polls may read. */
const fromEntry = (entry: HttpEntry, name: string | undefined) => ({
  name: name ?? entry.name,
  url: entry.url,
  transport: entry.transport,
  headers: {},
  catalogId: entry.id,
  pollable: entry.pollable,
  disabled: defaultDisabled(entry),
  actions: declaredActions(entry),
});

/**
 * Installs a catalog entry: an HTTP entry becomes a tool with its headers filled from `settings`
 * (and sealed); a runner entry only gives the snippet to add to the runner's config, with
 * placeholders, since its keys stay on the owner's machine.
 */
const installFromCatalog = owner
  .input(
    z.object({
      catalogId: z.string().max(64),
      name: Name.optional(),
      settings: z.record(z.string().max(64), HeaderValue).refine((s) => Object.keys(s).length <= MAX_HEADERS, "tools.settingsMax" satisfies MessageKey),
    }),
  )
  .handler(async ({ input, context }): Promise<{ tool: ToolView } | { runnerSnippet: string }> => {
    const entry = CATALOG.find((e) => e.id === input.catalogId);
    if (!entry) throw new ORPCError("NOT_FOUND", message("tools.notInCatalog"));
    if (entry.kind === "runner") return { runnerSnippet: runnerSnippet(entry) };
    // An OAuth entry is connected afterwards, on the tool's page, with the owner's own client.
    if (entry.oauth) return { tool: await createTool(context, { ...fromEntry(entry, input.name), oauth: true }) };
    let headers: Record<string, string>;
    try {
      headers = fillHeaders(entry, input.settings);
    } catch (error) {
      if (error instanceof MissingSetting) bad("tools.settingMissing", { label: error.label });
      throw error;
    }
    const tool = await createTool(context, { ...fromEntry(entry, input.name), headers });
    return { tool };
  });

/**
 * Adds a catalog entry's tool with no credential: what an agent may propose. An HTTP entry is
 * added with the actions its entry declares, so their flags and poll triggers can be set before
 * its owner signs in on the tool's page (`signInPath`): enters its settings, or connects it. A
 * runner entry is refused when proposed, with the snippet its owner adds on their machine.
 */
const addFromCatalog = owner
  .input(
    z.strictObject({
      catalogId: z
        .string()
        .max(64)
        .superRefine((id, ctx) => {
          const entry = catalogEntry(id);
          if (!entry) ctx.addIssue({ code: "custom", message: "tools.catalogNotListed" satisfies MessageKey });
          else if (entry.kind === "runner") {
            ctx.addIssue({
              code: "custom",
              message: "tools.catalogOnMachine" satisfies MessageKey,
              params: { name: entry.name, snippet: runnerSnippet(entry) },
            });
          }
        }),
      name: Name.optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const entry = catalogEntry(input.catalogId) as HttpEntry;
    return createTool(context, { ...fromEntry(entry, input.name), headers: {}, oauth: entry.oauth !== undefined });
  });

/**
 * Fills a catalog tool's settings (its key), sealed in its headers as its entry says, then
 * lists its actions: the first listing that succeeds replaces the ones it was added with.
 */
const fillSettings = owner
  .input(z.object({ id: z.string(), settings: z.record(z.string().max(64), HeaderValue).refine((s) => Object.keys(s).length <= MAX_HEADERS, "tools.settingsMax" satisfies MessageKey) }))
  .handler(async ({ input, context }) => {
    const current = await find(context.db, context.ownerId, input.id);
    const entry = catalogEntry(current.catalogId);
    if (current.kind !== "http" || entry?.kind !== "http" || entry.settings.length === 0 || current.auth === "oauth") bad("tools.noSettings");
    // Still at its entry's address (a tool pointed elsewhere loses its entry), and only there.
    if (current.url !== entry.url || current.transport !== entry.transport || current.urlSealed !== null) bad("tools.addressChanged");
    let headers: Record<string, string>;
    try {
      headers = fillHeaders(entry, input.settings);
    } catch (error) {
      if (error instanceof MissingSetting) bad("tools.settingMissing", { label: error.label });
      throw error;
    }
    checkTarget(entry.url, true);
    const headersSealed = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, context.secrets.seal(value, headerAad(current.id, name, entry.url))]));
    const [row] = await context.db
      .update(toolsTable)
      .set({ headersSealed, auth: authOf(false, headersSealed) })
      // Only while it still calls the address checked above: a change meanwhile saves nothing.
      .where(
        and(
          eq(toolsTable.id, current.id),
          eq(toolsTable.ownerId, context.ownerId),
          eq(toolsTable.url, entry.url),
          isNull(toolsTable.urlSealed),
          eq(toolsTable.transport, entry.transport),
          eq(toolsTable.catalogId, entry.id),
          ne(toolsTable.auth, "oauth"),
        ),
      )
      .returning();
    if (!row) throw new ORPCError("CONFLICT", message("tools.changed"));
    return view(context.db, await refreshActions(context.db, context.secrets, context.tools, row));
  });

/**
 * Renames a runner tool, or points it at another runner or server name, which that runner must
 * report. While an agent or a skill uses it, it stays on its runner: the agent's harness runs there.
 */
async function updateRunnerTool(context: Pick<InitialContext, "db" | "hub" | "engine"> & { ownerId: string }, current: Row, input: { name?: string; runnerId?: string; runnerTool?: string }) {
  const runnerId = input.runnerId ?? current.runnerId;
  const runnerTool = input.runnerTool ?? current.runnerTool;
  const moved = runnerId !== current.runnerId || runnerTool !== current.runnerTool;
  if (moved) {
    // A plugin's stdio server (no `runnerTool`) runs on any of the owner's runners that allows it.
    if (runnerId === null || (runnerTool === null && current.pluginComponent === null)) bad("tools.pickRunner");
    await requireRunnerTool(context.db, context.ownerId, runnerId, runnerTool);
    if (runnerId !== current.runnerId) {
      const holder = await toolHolder(context.db, context.ownerId, current.id);
      if (holder) throw new ORPCError("CONFLICT", message(STAYS[holder.key], holder.values));
    }
  }
  const [row] = await context.db
    .update(toolsTable)
    .set({ name: input.name ?? current.name, runnerId, runnerTool, ...(moved ? { actions: [], refreshedAt: null, catalogId: null, permissionRevision: sql`${toolsTable.permissionRevision} + 1` } : {}) })
    .where(and(eq(toolsTable.id, current.id), eq(toolsTable.ownerId, context.ownerId)))
    .returning()
    .catch((e: unknown) => nameTaken(e, input.name ?? current.name));
  if (!row) throw new ORPCError("NOT_FOUND", message("tools.notFound"));
  if (moved) {
    await askAgain(context.db, row.id);
    await context.engine.narrowOwnerSessions(context.ownerId, context.db);
  }
  return view(context.db, moved ? await refreshRunnerActions(context.db, context.hub, row) : row);
}

const update = owner
  .input(
    z.object({
      id: z.string(),
      name: Name.optional(),
      url: Url.optional(),
      transport: z.enum(TRANSPORTS).optional(),
      headers: Headers.optional(),
      auth: z.enum(AUTHS).optional(),
      runnerId: z.string().max(100).optional(),
      runnerTool: McpServerName.optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const current = await find(context.db, context.ownerId, input.id);
    if (current.kind === "runner") {
      if (input.url !== undefined || input.transport !== undefined || input.headers !== undefined || input.auth !== undefined) {
        bad("tools.runnerNoUrl");
      }
      return updateRunnerTool(context, current, input);
    }
    if (input.runnerId !== undefined || input.runnerTool !== undefined) bad("tools.httpNoRunner");
    const url = input.url ?? current.url!;
    const transport = input.transport ?? current.transport!;
    // Headers are for the server they were entered for: at another origin, or over another
    // transport, the tool starts without them, and only those given with the change are kept.
    const elsewhere = originOf(url) !== originOf(current.url!) || transport !== current.transport;
    const oauth = (input.auth ?? current.auth) === "oauth";
    // An OAuth tool sends no header (they would reach its authorization server too); "none" drops them.
    const headersSealed = elsewhere || oauth || input.auth === "none" ? {} : { ...current.headersSealed };
    for (const [name, value] of Object.entries(normalize(input.headers ?? {}))) {
      if (value && (oauth || input.auth === "none")) bad("tools.oauthOrNoneNoHeaders");
      if (value) headersSealed[name] = context.secrets.seal(value, headerAad(current.id, name, url));
      else delete headersSealed[name];
    }
    if (Object.keys(headersSealed).length > MAX_HEADERS) bad("tools.headersMax");
    // A new URL replaces the secret one; the same template keeps it.
    const urlSealed = url === current.url ? current.urlSealed : null;
    if (oauth && urlSealed !== null) bad("tools.oauthNoSecretUrl");
    checkTarget(urlSealed === null ? url : toolTarget(current, context.secrets).url, Object.keys(headersSealed).length > 0 || urlSealed !== null || oauth);
    const moved = url !== current.url || transport !== current.transport;
    // A sign-in is for the server it was made with: another server, or another way, starts over.
    const oauthColumns = !oauth ? NO_OAUTH : current.auth !== "oauth" || moved ? { ...NO_OAUTH, oauthStatus: "authorize" as const } : {};
    const [row] = await context.db
      .update(toolsTable)
      .set({
        name: input.name ?? current.name,
        url,
        urlSealed,
        transport,
        // A plugin's tool: what now differs from the plugin's values is the owner's override.
        overridden: overriddenAfter("tool", current, { name: input.name ?? current.name, url, transport }),
        headersSealed,
        auth: authOf(oauth, headersSealed),
        ...oauthColumns,
        // Another server's actions don't describe this one, nor does the catalog entry it came from.
        ...(moved ? { actions: [], refreshedAt: null, catalogId: null, permissionRevision: sql`${toolsTable.permissionRevision} + 1` } : {}),
      })
      // A write that holds only while a field is as it was read (a Stem decision): compared in the write itself.
      .where(and(eq(toolsTable.id, current.id), eq(toolsTable.ownerId, context.ownerId), ...(context.expectField ? [eq(toolColumn(context.expectField.field), context.expectField.value as string)] : [])))
      .returning()
      .catch((e: unknown) => nameTaken(e, input.name ?? current.name));
    if (!row) throw context.expectField ? new ORPCError("CONFLICT", message("triggers.fieldChanged")) : new ORPCError("NOT_FOUND", message("tools.notFound"));
    if (moved) {
      await askAgain(context.db, row.id);
      await context.engine.narrowOwnerSessions(context.ownerId, context.db);
    }
    const changed = moved || (input.headers !== undefined && Object.keys(input.headers).length > 0) || row.auth !== current.auth;
    // An OAuth tool lists its actions once connected.
    const listable = row.auth !== "oauth" || row.oauthStatus === "connected";
    return view(context.db, changed && listable ? await refreshActions(context.db, context.secrets, context.tools, row) : row);
  });

/**
 * Starts an OAuth tool's sign-in (Connect, Re-authorize) and gives the URL to send the owner to.
 * `client` is the client id (and secret) the authorization server gave the owner, for one that
 * supports neither client metadata documents nor registration; null removes it. The flow's
 * `state` and verifier stay sealed here, for the callback.
 */
const authorize = owner
  .input(
    z.object({
      id: z.string(),
      client: z
        .object({ clientId: z.string().trim().min(1).max(500).refine(oneLine, "tools.oneLine" satisfies MessageKey), clientSecret: z.string().trim().max(2000).refine(oneLine, "tools.oneLine" satisfies MessageKey).optional() })
        .nullable()
        .optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const row = await find(context.db, context.ownerId, input.id);
    if (row.kind !== "http" || row.auth !== "oauth") bad("tools.notOauth");
    const store = oauthStore(context.db, context.secrets, row);
    if (input.client !== undefined) {
      const client = input.client;
      await store.change((state) => {
        // Another client: what was had with the last one (its client information, its tokens) goes.
        state.issuers = {};
        delete state.current;
        if (client) state.entered = { client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) };
        else delete state.entered;
      });
    }
    return oauthStep("authorize", row.id, async () => {
      let started;
      try {
        started = await context.tools.authorize({ ...toolTarget(row, context.secrets), oauth: store });
      } catch (error) {
        if (error instanceof ToolError) throw new ORPCError("BAD_REQUEST", message(error.say.key, error.say.values));
        throw error;
      }
      if (!started) bad("tools.noSignIn", { host: new URL(row.url!).host });
      const pending = started.pending;
      await store.change((state) => {
        state.pending = pending;
      });
      return { url: started.url.href };
    });
  });

const refresh = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  const row = await refreshAny(context, await find(context.db, context.ownerId, input.id));
  // Under strict permissions a new listing (or a failed one) can end grants: running sessions lose them too.
  if (await strictPermissionsOf(context.db, context.ownerId)) await context.engine.narrowOwnerSessions(context.ownerId, context.db);
  return view(context.db, row);
});

// Agents, skill packages and Tool steps hold a tool: `toolHolder`.
const remove = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  await context.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: toolsTable.id, pluginId: toolsTable.pluginId })
      .from(toolsTable)
      .where(and(eq(toolsTable.id, input.id), eq(toolsTable.ownerId, context.ownerId)))
      .for("update");
    if (!row) throw new ORPCError("NOT_FOUND", message("tools.notFound"));
    await refuseOwnDelete(tx, row.pluginId);
    const holder = await toolHolder(tx, context.ownerId, row.id);
    if (holder) throw new ORPCError("CONFLICT", message(holder.key, holder.values));
    await tx.delete(toolsTable).where(eq(toolsTable.id, row.id));
  });
});

const list = owner.handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(toolsTable)
    .where(eq(toolsTable.ownerId, context.ownerId))
    .orderBy(asc(toolsTable.createdAt), asc(toolsTable.id));
  return views(context.db, rows);
});

const get = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => view(context.db, await find(context.db, context.ownerId, input.id)));

/** Each action of a tool with whether a poll may read it, and why not. */
const pollable = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  const actions = await pollableActions(context.db, context.ownerId, input.id);
  if (!actions) throw new ORPCError("NOT_FOUND", message("tools.notFound"));
  return actions;
});

/** Sets the actions polls may read (the owner's choice; an action an agent asks before using stays unpolled). */
const setPollable = owner.input(z.object({ id: z.string(), actions: z.array(z.string().max(200)).max(200) })).handler(async ({ input, context }) => {
  const row = await find(context.db, context.ownerId, input.id);
  const known = new Set(row.actions.map((a) => a.name));
  const unknown = input.actions.find((a) => !known.has(a));
  if (unknown !== undefined) throw new ORPCError("BAD_REQUEST", message("tools.noAction", { action: unknown.slice(0, 100) }));
  await context.db.update(toolsTable).set({ pollable: [...new Set(input.actions)] }).where(eq(toolsTable.id, row.id));
  // Found above, so it lists the actions.
  return (await pollableActions(context.db, context.ownerId, row.id))!;
});

/** Global availability is an owner's choice, independent of each agent's saved permissions. */
const setActionEnabled = owner.input(z.object({ toolId: z.string(), action: z.string(), enabled: z.boolean() })).handler(async ({ input, context }) => {
  const row = await context.db.transaction(async (tx) => {
    const [tool] = await tx.select().from(toolsTable).where(and(eq(toolsTable.id, input.toolId), eq(toolsTable.ownerId, context.ownerId))).for("update");
    if (!tool?.actions.some((a) => a.name === input.action)) throw new ORPCError("NOT_FOUND", message("tools.notFound"));
    if (tool.disabled.includes(input.action) === !input.enabled) return tool;
    const disabled = tool.disabled.filter((name) => name !== input.action);
    if (!input.enabled) disabled.push(input.action);
    const [updated] = await tx.update(toolsTable).set({ disabled, permissionRevision: sql`${toolsTable.permissionRevision} + 1` }).where(eq(toolsTable.id, tool.id)).returning();
    return updated!;
  });
  if (!input.enabled) await context.engine.narrowOwnerSessions(context.ownerId, context.db);
  return view(context.db, row);
});

export const tools = { create, add, update, delete: remove, list, get, refresh, authorize, catalog, installFromCatalog, addFromCatalog, fillSettings, pollable, setPollable, setActionEnabled };
