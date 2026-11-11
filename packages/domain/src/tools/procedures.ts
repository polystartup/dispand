import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { toolHolder } from "../agents/usage.ts";
import type { Db, Tx } from "../db/client.ts";
import { McpServerName } from "@dispand/runner-protocol";
import { agentTools, plugins, runners, tools as toolsTable } from "../db/schema.ts";
import { isLoopback } from "../harnesses/procedures.ts";
import { newId } from "../ids.ts";
import { logError } from "../log.ts";
import { authed, base } from "../rpc/context.ts";
import { type RunnerHub, RunnerRequestFailed } from "../runners/hub.ts";
import { secretAad, type SecretBox } from "../secrets.ts";
import { CATALOG, fillHeaders, MissingSetting, runnerSnippet, searchCatalog } from "./catalog.ts";
import { ToolError, TRANSPORTS, type ToolConnector, type ToolTarget, type ToolTransport } from "./mcp.ts";
import type { InitialContext } from "../rpc/context.ts";

const owner = base.use(authed);

type Row = typeof toolsTable.$inferSelect;

/** Where a tool's header `name` is sealed: its AAD names the row and the header. */
export const headerAad = (toolId: string, name: string) => secretAad("tools", toolId, `header:${name}`);
/** Where a tool's secret URL is sealed. */
export const urlAad = (toolId: string) => secretAad("tools", toolId, "url");

export const MAX_HEADERS = 20;

export const Name = z.string().trim().min(1).max(100);
export const Url = z.url({ protocol: /^https?$/ }).max(2000);
// RFC 9110 token; stored in lower case (header names are case-insensitive).
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
// No control characters but tab: a value is one header line.
const oneLine = (v: string) => [...v].every((c) => c === "\t" || (c >= " " && c !== "\u007f"));
export const HeaderValue = z.string().trim().max(4000).refine(oneLine, "A header value is one line of text");
/** Header name → value. On update, "" removes the header and an absent name keeps it. */
export const Headers = z
  .record(z.string().regex(HEADER_NAME, "Not a valid header name"), HeaderValue)
  .refine((h) => Object.keys(h).length <= MAX_HEADERS, `At most ${MAX_HEADERS} headers`);

function bad(message: string): never {
  throw new ORPCError("BAD_REQUEST", { message });
}

type PluginRef = { id: string; name: string };

/**
 * The owner's view: header names only, never their values (sealed or not). A secret URL shows
 * as its template, with `urlSet`.
 */
function toView(row: Row, plugin: PluginRef | null) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    urlSet: row.urlSealed !== null,
    transport: row.transport,
    headerNames: Object.keys(row.headersSealed).sort(),
    actions: row.actions,
    actionsError: row.actionsError,
    refreshedAt: row.refreshedAt,
    catalogId: row.catalogId,
    runnerId: row.runnerId,
    runnerTool: row.runnerTool,
    plugin,
    createdAt: row.createdAt,
  };
}
export type ToolView = ReturnType<typeof toView>;

/** The views of `rows`, with the plugin each came from. */
async function views(db: Db, rows: Row[]): Promise<ToolView[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.pluginId ? [r.pluginId] : [])))];
  const found = ids.length ? await db.select({ id: plugins.id, name: plugins.name }).from(plugins).where(inArray(plugins.id, ids)) : [];
  return rows.map((r) => toView(r, found.find((p) => p.id === r.pluginId) ?? null));
}

const view = async (db: Db, row: Row) => (await views(db, [row]))[0]!;

/** Lower-cased names; two spellings of one name are refused. */
function normalize(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key in out) bad(`The header ${key} is given twice`);
    out[key] = value;
  }
  return out;
}

/**
 * The rules the schema can't say alone: credentials go in headers, and headers (or a secret URL)
 * only over https (or to this machine).
 */
function checkTarget(url: string, hasSecrets: boolean) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) bad("Put credentials in a header, not in the URL");
  if (hasSecrets && parsed.protocol === "http:" && !isLoopback(parsed)) bad("Headers are only sent to an https:// URL");
}

async function find(db: Db, ownerId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(toolsTable)
    .where(and(eq(toolsTable.id, id), eq(toolsTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

function nameTaken(error: unknown, name: string): never {
  const e = error as { code?: string; cause?: { code?: string } };
  if (e.code === "23505" || e.cause?.code === "23505") throw new ORPCError("CONFLICT", { message: `A tool is already called “${name}”` });
  throw error;
}

/** The tool's target with its headers opened. Server-only: they go to the tool's URL and nowhere else. */
export function toolTarget(row: Row, secrets: SecretBox): ToolTarget {
  if (row.url === null || row.transport === null) throw new Error(`tool ${row.id} isn't an HTTP tool`);
  const headers = Object.fromEntries(Object.entries(row.headersSealed).map(([name, sealed]) => [name, secrets.open(sealed, headerAad(row.id, name))]));
  if (row.urlSealed === null) return { url: row.url, transport: row.transport, headers };
  const secret = JSON.parse(secrets.open(row.urlSealed, urlAad(row.id))) as { url: string; secrets: string[] };
  return { url: secret.url, transport: row.transport, headers, urlSecrets: secret.secrets };
}

/**
 * Lists the tool's actions again and stores them, or the reason it failed (the last actions
 * stay). The reason is a `ToolError`'s short text, never the server's answer.
 */
export async function refreshActions(db: Db, secrets: SecretBox, connector: ToolConnector, row: Row): Promise<Row> {
  let values: Partial<Row>;
  try {
    values = { actions: await connector.listActions(toolTarget(row, secrets)), actionsError: null, refreshedAt: new Date() };
  } catch (error) {
    if (!(error instanceof ToolError)) logError("tools.refresh failed", error, { ref: row.id });
    values = { actionsError: error instanceof ToolError ? error.message : "Couldn't list the tool's actions" };
  }
  const [updated] = await db
    .update(toolsTable)
    .set(values)
    .where(and(eq(toolsTable.id, row.id), eq(toolsTable.ownerId, row.ownerId)))
    .returning();
  // Deleted meanwhile: what was listed belongs to nobody.
  if (!updated) throw new ORPCError("NOT_FOUND");
  return updated;
}

/**
 * Asks the tool's runner to list its actions, and stores them or the reason it failed (the last
 * actions stay). The reason is the runner's own words, or "runner offline".
 */
export async function refreshRunnerActions(db: Db, hub: Pick<RunnerHub, "request">, row: Row): Promise<Row> {
  let values: Partial<Row>;
  if (row.runnerId === null || row.runnerTool === null) values = { actionsError: "Not on a runner yet" };
  else {
    try {
      const reply = await hub.request(row.runnerId, { type: "tool.discover", requestId: newId("req"), tool: row.runnerTool });
      values = reply.actions ? { actions: reply.actions, actionsError: null, refreshedAt: new Date() } : { actionsError: reply.error ?? "The runner listed no actions" };
    } catch (error) {
      if (!(error instanceof RunnerRequestFailed)) throw error;
      values = { actionsError: error.message === "timed out" ? "The runner didn't answer in time" : "runner offline" };
    }
  }
  const [updated] = await db
    .update(toolsTable)
    .set(values)
    .where(and(eq(toolsTable.id, row.id), eq(toolsTable.ownerId, row.ownerId)))
    .returning();
  if (!updated) throw new ORPCError("NOT_FOUND");
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
async function requireRunnerTool(db: Db | Tx, ownerId: string, runnerId: string, runnerTool: string) {
  const [runner] = await db
    .select({ tools: runners.tools })
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.ownerId, ownerId), isNull(runners.revokedAt)));
  if (!runner) throw new ORPCError("NOT_FOUND", { message: "Runner not found" });
  if (!runner.tools.includes(runnerTool)) {
    bad(`The runner doesn't report an MCP server named ${runnerTool}: add it to the runner's config.json, then restart the runner`);
  }
}

export type ToolFields = {
  name: string;
  url: string;
  transport: ToolTransport;
  headers: Record<string, string>;
  catalogId?: string;
  /** The URL to call when it holds secrets (named in `secrets`); `url` is then its template, shown in its place. */
  secretUrl?: { url: string; secrets: string[] };
  plugin?: { id: string; component: string };
};

/**
 * Saves a new HTTP tool with its headers (and secret URL) sealed. The one way a tool row is
 * written; its actions are listed afterwards (`refreshActions`), outside any transaction.
 */
export async function insertTool(db: Db | Tx, secrets: SecretBox, ownerId: string, input: ToolFields): Promise<Row> {
  // Every path in (form, catalog, plugin) is held to the form's rules.
  if (!Name.safeParse(input.name).success) bad("A tool needs a name of 1 to 100 characters");
  if (!Url.safeParse(input.secretUrl?.url ?? input.url).success || input.url.length > 2000) bad("Not an http(s) URL");
  if (!Headers.safeParse(input.headers).success) bad("The headers aren't valid");
  const headers = normalize(input.headers);
  for (const [name, value] of Object.entries(headers)) if (!value) bad(`The header ${name} has no value`);
  checkTarget(input.secretUrl?.url ?? input.url, Object.keys(headers).length > 0 || input.secretUrl !== undefined);
  const id = newId("tool");
  const headersSealed = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, secrets.seal(value, headerAad(id, name))]));
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
      catalogId: input.catalogId ?? null,
      pluginId: input.plugin?.id ?? null,
      pluginComponent: input.plugin?.component ?? null,
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

/** Points the tool at a new (plain) URL, under the same rules as `update`; its actions are listed again afterwards. */
export async function retarget(db: Db | Tx, row: Row, url: string, transport: ToolTransport): Promise<Row> {
  if (!Url.safeParse(url).success) bad("Not an http(s) URL");
  checkTarget(url, Object.keys(row.headersSealed).length > 0);
  const [updated] = await db
    .update(toolsTable)
    .set({ url, urlSealed: null, transport, actions: [], refreshedAt: null })
    .where(and(eq(toolsTable.id, row.id), eq(toolsTable.ownerId, row.ownerId)))
    .returning();
  if (!updated) throw new ORPCError("NOT_FOUND");
  await askAgain(db, updated.id);
  return updated;
}

async function createTool(context: Pick<InitialContext, "db" | "secrets" | "tools"> & { ownerId: string }, input: ToolFields) {
  const row = await insertTool(context.db, context.secrets, context.ownerId, input);
  return view(context.db, await refreshActions(context.db, context.secrets, context.tools, row));
}

const RunnerTool = z.object({ kind: z.literal("runner"), name: Name, runnerId: z.string().max(100), runnerTool: McpServerName });

/** Saves a runner tool, once its runner reports the server; its actions are then listed by the runner. */
async function createRunnerTool(context: Pick<InitialContext, "db" | "hub"> & { ownerId: string }, input: z.infer<typeof RunnerTool>) {
  await requireRunnerTool(context.db, context.ownerId, input.runnerId, input.runnerTool);
  const [row] = await context.db
    .insert(toolsTable)
    .values({ id: newId("tool"), ownerId: context.ownerId, name: input.name, kind: "runner", runnerId: input.runnerId, runnerTool: input.runnerTool })
    .returning()
    .catch((e: unknown) => nameTaken(e, input.name));
  return view(context.db, await refreshRunnerActions(context.db, context.hub, row!));
}

const create = owner
  .input(z.union([RunnerTool, z.object({ kind: z.literal("http").optional(), name: Name, url: Url, transport: z.enum(TRANSPORTS), headers: Headers })]))
  .handler(({ input, context }) => {
    if (input.kind === "runner") return createRunnerTool(context, input);
    const { name, url, transport, headers } = input;
    return createTool(context, { name, url, transport, headers });
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
      }, "The URL can't carry credentials"),
      transport: z.enum(TRANSPORTS),
    }),
  )
  .handler(({ input, context }) => createTool(context, { ...input, headers: {} }));

/** The catalog's entries, searched by name and description. Templates and setting names only: no value. */
const catalog = owner.input(z.object({ query: z.string().max(100).optional() })).handler(({ input }) => searchCatalog(input.query));

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
      settings: z.record(z.string().max(64), HeaderValue).refine((s) => Object.keys(s).length <= MAX_HEADERS, `At most ${MAX_HEADERS} settings`),
    }),
  )
  .handler(async ({ input, context }): Promise<{ tool: ToolView } | { runnerSnippet: string }> => {
    const entry = CATALOG.find((e) => e.id === input.catalogId);
    if (!entry) throw new ORPCError("NOT_FOUND", { message: "Not in the catalog" });
    if (entry.kind === "runner") return { runnerSnippet: runnerSnippet(entry) };
    let headers: Record<string, string>;
    try {
      headers = fillHeaders(entry, input.settings);
    } catch (error) {
      if (error instanceof MissingSetting) bad(error.message);
      throw error;
    }
    const tool = await createTool(context, { name: input.name ?? entry.name, url: entry.url, transport: entry.transport, headers, catalogId: entry.id });
    return { tool };
  });

/**
 * Renames a runner tool, or points it at another runner or server name, which that runner must
 * report. While an agent or a skill uses it, it stays on its runner: the agent's harness runs there.
 */
async function updateRunnerTool(context: Pick<InitialContext, "db" | "hub"> & { ownerId: string }, current: Row, input: { name?: string; runnerId?: string; runnerTool?: string }) {
  const runnerId = input.runnerId ?? current.runnerId;
  const runnerTool = input.runnerTool ?? current.runnerTool;
  const moved = runnerId !== current.runnerId || runnerTool !== current.runnerTool;
  if (moved) {
    if (runnerId === null || runnerTool === null) bad("Pick the runner and its MCP server");
    await requireRunnerTool(context.db, context.ownerId, runnerId, runnerTool);
    if (runnerId !== current.runnerId) {
      const holder = await toolHolder(context.db, context.ownerId, current.id);
      if (holder) throw new ORPCError("CONFLICT", { message: `${holder}: it stays on its runner` });
    }
  }
  const [row] = await context.db
    .update(toolsTable)
    .set({ name: input.name ?? current.name, runnerId, runnerTool, ...(moved ? { actions: [], refreshedAt: null } : {}) })
    .where(and(eq(toolsTable.id, current.id), eq(toolsTable.ownerId, context.ownerId)))
    .returning()
    .catch((e: unknown) => nameTaken(e, input.name ?? current.name));
  if (!row) throw new ORPCError("NOT_FOUND");
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
      runnerId: z.string().max(100).optional(),
      runnerTool: McpServerName.optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const current = await find(context.db, context.ownerId, input.id);
    if (current.kind === "runner") {
      if (input.url !== undefined || input.transport !== undefined || input.headers !== undefined) {
        bad("A runner tool has no URL or headers: its runner's config.json says how to start it");
      }
      return updateRunnerTool(context, current, input);
    }
    if (input.runnerId !== undefined || input.runnerTool !== undefined) bad("An HTTP tool doesn't run on a runner");
    const headersSealed = { ...current.headersSealed };
    for (const [name, value] of Object.entries(normalize(input.headers ?? {}))) {
      if (value) headersSealed[name] = context.secrets.seal(value, headerAad(current.id, name));
      else delete headersSealed[name];
    }
    if (Object.keys(headersSealed).length > MAX_HEADERS) bad(`At most ${MAX_HEADERS} headers`);
    const url = input.url ?? current.url!;
    const transport = input.transport ?? current.transport!;
    // A new URL replaces the secret one; the same template keeps it.
    const urlSealed = url === current.url ? current.urlSealed : null;
    checkTarget(urlSealed === null ? url : toolTarget(current, context.secrets).url, Object.keys(headersSealed).length > 0 || urlSealed !== null);
    const moved = url !== current.url || transport !== current.transport;
    const [row] = await context.db
      .update(toolsTable)
      .set({
        name: input.name ?? current.name,
        url,
        urlSealed,
        transport,
        headersSealed,
        // Another server's actions don't describe this one.
        ...(moved ? { actions: [], refreshedAt: null } : {}),
      })
      .where(and(eq(toolsTable.id, current.id), eq(toolsTable.ownerId, context.ownerId)))
      .returning()
      .catch((e: unknown) => nameTaken(e, input.name ?? current.name));
    if (!row) throw new ORPCError("NOT_FOUND");
    if (moved) await askAgain(context.db, row.id);
    const changed = moved || (input.headers !== undefined && Object.keys(input.headers).length > 0);
    return view(context.db, changed ? await refreshActions(context.db, context.secrets, context.tools, row) : row);
  });

const refresh = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  return view(context.db, await refreshAny(context, await find(context.db, context.ownerId, input.id)));
});

// Agents, skill packages and Tool steps hold a tool: `toolHolder`.
const remove = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  await context.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: toolsTable.id, plugin: plugins.name })
      .from(toolsTable)
      .leftJoin(plugins, eq(plugins.id, toolsTable.pluginId))
      .where(and(eq(toolsTable.id, input.id), eq(toolsTable.ownerId, context.ownerId)))
      .for("update", { of: toolsTable });
    if (!row) throw new ORPCError("NOT_FOUND");
    // A plugin's tool goes with its plugin.
    if (row.plugin !== null) throw new ORPCError("FORBIDDEN", { message: `Remove the plugin ${row.plugin} instead` });
    const holder = await toolHolder(tx, context.ownerId, row.id);
    if (holder) throw new ORPCError("CONFLICT", { message: holder });
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

export const tools = { create, add, update, delete: remove, list, get, refresh, catalog, installFromCatalog };
