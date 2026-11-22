import { ORPCError } from "@orpc/server";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { strictPermissionsOf } from "../agents/tool-ask.ts";
import { requireLegacyWorkspace } from "../workspace/access.ts";
import { toolHolder } from "../agents/usage.ts";
import { McpServerName } from "@dispand/runner-protocol";
import { tools as toolsTable } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { message, type MessageKey } from "../messages/index.ts";
import { authed, base } from "../rpc/context.ts";
import { CATALOG, catalogEntry, declaredActions, defaultDisabled, fillHeaders, MissingSetting, runnerSnippet, searchCatalog } from "./catalog.ts";
import { AUTHS, ToolError, TRANSPORTS } from "./mcp.ts";
import { oauthStep, oauthStore } from "./oauth-store.ts";
import { pollableActions } from "./pollable.ts";
import type { InitialContext } from "../rpc/context.ts";
import { overriddenAfter, refuseOwnDelete } from "../plugins/overrides.ts";
import { Row, headerAad, MAX_HEADERS, originOf, Name, Url, oneLine, HeaderValue, Headers, STAYS, bad, ToolView, views, view, normalize, checkTarget, find, nameTaken, toolTarget, refreshActions, refreshRunnerActions, refreshAny, requireRunnerTool, authOf, NO_OAUTH, askAgain, toolColumn, createTool } from "./store.ts";

const owner = base.use(authed);

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
  if (await strictPermissionsOf(context.db, await requireLegacyWorkspace(context))) await context.engine.narrowOwnerSessions(context.ownerId, context.db);
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
