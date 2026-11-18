import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db } from "../db/client.ts";
import { agents as agentsTable, agentSkills, agentTools, fields as fieldsTable, harnesses, marketplaces as marketplacesTable, plugins as pluginsTable, pluginConflicts, skillPackages, skills as skillsTable, tables as tablesTable, tools as toolsTable, triggers as triggersTable, CREATED_KINDS } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { message,  } from "../messages/index.ts";
import { MAX_DESCRIPTION } from "../skills/package.ts";
import { resetFile, store, storeUpstream } from "../skills/procedures.ts";
import { HeaderValue, insertTool, refreshActions } from "../tools/store.ts";
import { hasPlaceholder, httpTool, skillPackageName, toolName } from "./components.ts";
import { type UpdatableKind } from "./update.ts";
import { ELEMENT_FIELDS } from "./overrides.ts";
import { itemsView } from "../platform/proposals.ts";
import { runItemsAsOwner, SetupPick, setupItems } from "./setup.ts";
import { addServer } from "./servers.ts";
import { writeFields } from "./write-field.ts";
import { answerConflict, approvalOf, conflictView, elementTable, fieldNow, ownerChoice, type Refused } from "./resolve.ts";
import { findAssistant } from "../agents/builtin.ts";
import { componentsOf, type PluginContents } from "./read-plugin.ts";
import { storePluginFiles } from "./runner-servers.ts";
import { uniqueConstraint } from "../db/unique.ts";
import { canonicalHash } from "../platform/approvals.ts";
import { owner, acted, asBadRequest, chosenSkills, PluginRow } from "./common.ts";
import { readEntry, packageName, EntryRef, findMarketplace, findEntry, discover } from "./marketplace-procedures.ts";
import { uninstallPreview, uninstall } from "./uninstall-procedures.ts";
import { tableChangesOf, applyTableChange, updatePreview, update, handToStem } from "./update-procedures.ts";

/**
 * What the owner reviewed of a plugin at that commit: its MCP servers as read (the marketplace's
 * manifest merged in) and its definitions, which say what its agents may do. An install of
 * servers, or one that sets definitions up, must match it.
 */
function reviewToken(sha: string, contents: PluginContents): string {
  return createHash("sha256").update(JSON.stringify([sha, contents.mcpServers, contents.definitions])).digest("hex");
}

const preview = owner.input(EntryRef).handler(async ({ input, context }) => {
  const market = await findMarketplace(context.db, context.ownerId, input.marketplaceId);
  const { contents, sha, nativeRoot } = await readEntry(market, findEntry(market, input.entryName), !!context.gitFileUrls).catch(asBadRequest);
  return { ...componentsOf(contents), definitions: contents.definitions, notImported: contents.notImported, reviewed: reviewToken(sha, contents), nativeAvailable: nativeRoot !== undefined && market.kind !== "skill-repo" };
});

/** One MCP server's settings: `${VAR}` name → value. */
const ServerSettings = z.record(z.string().max(100), HeaderValue).refine((s) => Object.keys(s).length <= 50, "At most 50 settings per MCP server");

const InstallInput = EntryRef.extend({
  /** Register the source for an owner-approved native install without importing components. */
  nativeInstall: z.boolean().default(false),
  skills: z.array(z.string().max(64)).max(200).default([]),
  mcpServers: z.array(z.string().max(100)).max(100).default([]),
  agents: z.array(z.string().max(100)).max(100).default([]),
  /** The harness the plugin's agents run on; required when `agents` isn't empty. */
  harnessId: z.string().max(64).optional(),
  /** `preview`'s `reviewed`: the install makes what the owner saw at that commit, else `CONFLICT`. */
  reviewed: z.string().max(64).optional(),
  /** The definitions to set up once installed, as `setUp` takes them; needs `reviewed`. */
  setup: SetupPick.optional(),
  /** MCP server name → its settings. */
  settings: z
    .record(z.string().max(100), ServerSettings)
    .refine((s) => Object.keys(s).length <= 100, "At most 100 MCP servers")
    .default({}),
});

const unique = (names: string[]) => [...new Set(names)];

/**
 * Installs the components the owner ticked: skills as one read-only package, HTTP MCP servers as
 * HTTP tools (settings sealed), agents on the chosen harness with the plugin's imported skills and
 * tools. Everything is stored in one transaction; the tools' actions are listed afterwards.
 */
export const install = owner
  .input(InstallInput)
  .handler(({ input, context }) => acted("install", undefined, async () => {
    const picked = { skills: unique(input.skills), mcpServers: unique(input.mcpServers), agents: unique(input.agents) };
    const setupPicked = !!input.setup && Object.values(input.setup).some((v) => Array.isArray(v) && v.length > 0);
    const nothingPicked = !picked.skills.length && !picked.mcpServers.length && !picked.agents.length && !setupPicked;
    const { harnessId } = input;
    // From a Job's approved item: bound to the commit shown, skills and the setup only. A server
    // (its address, its settings), an agent file (its tools' default grants) and a native install are the owner's to give.
    if (context.job && (input.nativeInstall || Object.keys(input.settings).length || picked.mcpServers.length || picked.agents.length)) {
      throw new ORPCError("FORBIDDEN", message("plugins.install.proposed"));
    }
    if (picked.agents.length && !harnessId) throw new ORPCError("BAD_REQUEST", message("plugins.install.pickHarness"));
    if (picked.agents.length && harnessId) {
      const [harness] = await context.db
        .select({ id: harnesses.id })
        .from(harnesses)
        .where(and(eq(harnesses.id, harnessId), eq(harnesses.ownerId, context.ownerId)));
      if (!harness) throw new ORPCError("NOT_FOUND", message("plugins.install.harnessNotFound"));
    }
    const market = await findMarketplace(context.db, context.ownerId, input.marketplaceId);
    const entry = findEntry(market, input.entryName);
    const { contents, files, url, sha, nativeRoot } = await readEntry(market, entry, !!context.gitFileUrls).catch(asBadRequest);
    // A plugin with definitions is worth installing for them alone: they are registered, and set up later.
    const { agents: agentDefs, primitives, triggers } = contents.definitions;
    if (nothingPicked && !input.nativeInstall && !agentDefs.length && !primitives.length && !triggers.length) {
      throw new ORPCError("BAD_REQUEST", message("plugins.install.pickSomething"));
    }
    // Whatever it picks: its skills' files and its agents' instructions are what the owner saw too.
    if (reviewToken(sha, contents) !== input.reviewed) {
      throw new ORPCError("CONFLICT", message("plugins.install.changed", { plugin: entry.name }));
    }
    const chosen = picked.skills.length ? chosenSkills(contents, picked.skills) : null;
    const pluginId = newId("plugin");
    const servers = picked.mcpServers.map((serverName) => {
      const server = contents.mcpServers.find((s) => s.name === serverName);
      if (!server) throw new ORPCError("BAD_REQUEST", message("plugins.install.noServer", { name: serverName }));
      // Runner tools (stdio servers) come with the runner's MCP servers.
      if (server.type !== "http") throw new ORPCError("BAD_REQUEST", message("plugins.install.serverOnMachine", { name: serverName }));
      return { name: server.name, fields: httpTool(server, input.settings[server.name] ?? {}, pluginId) };
    });
    const agents = picked.agents.map((agentName) => {
      const agent = contents.agents.find((a) => a.name === agentName);
      if (!agent) throw new ORPCError("BAD_REQUEST", message("plugins.install.noAgent", { name: agentName }));
      return agent;
    });
    const name = packageName(entry.name);
    const description = (entry.description ?? "").slice(0, MAX_DESCRIPTION);
    let created: { tools: (typeof toolsTable.$inferSelect)[]; agentIds: string[] };
    try {
      created = await context.db.transaction(async (tx) => {
        await tx.insert(pluginsTable).values({
          id: pluginId,
          ownerId: context.ownerId,
          name: entry.name,
          description,
          marketplaceId: market.id,
          entryName: entry.name,
          url,
          sha,
          nativeRoot: nativeRoot ?? null,
          layout: contents.layout,
          components: componentsOf(contents),
          definitions: contents.definitions,
          notImported: contents.notImported,
        });
        await tx.update(pluginsTable).set({ digest: await storePluginFiles(tx, pluginId, files) }).where(eq(pluginsTable.id, pluginId));
        const packageId = chosen ? newId("skillpkg") : null;
        if (chosen && packageId) {
          await tx.insert(skillPackages).values({ id: packageId, ownerId: context.ownerId, name: await skillPackageName(tx, context.ownerId, name), description, pluginId });
          await store(tx, packageId, chosen.files, chosen.skills);
          await storeUpstream(tx, packageId, chosen.files);
        }
        const tools = [];
        for (const server of servers) {
          tools.push(await insertTool(tx, context.secrets, context.ownerId, { ...server.fields, name: toolName(server.name) }));
        }
        const agentIds: string[] = [];
        for (const agent of agents) {
          const id = newId("agent");
          // The agent file's `tools` and `model` aren't read: the harness decides them.
          await tx.insert(agentsTable).values({
            id,
            ownerId: context.ownerId,
            name: agent.name,
            harnessId: harnessId!,
            systemPrompt: agent.systemPrompt,
            pluginId,
            pluginComponent: agent.name,
            // The plugin's values of every field it gives an agent: a later change of one is the owner's override.
            upstream: { name: agent.name, description: "", systemPrompt: agent.systemPrompt, bundles: [], dataTables: "all", selfLearning: [], skillPackageIds: packageId ? [packageId] : [], toolIds: tools.map((t) => t.id), consults: [] },
          });
          if (packageId) await tx.insert(agentSkills).values({ agentId: id, packageId });
          if (tools.length) await tx.insert(agentTools).values(tools.map((t) => ({ agentId: id, toolId: t.id })));
          agentIds.push(id);
        }
        // What the setup would make, checked before anything is kept: a pick it can't make refuses the install.
        if (setupPicked) await setupItems(tx, context.ownerId, pluginId, input.setup!, true);
        return { tools, agentIds };
      });
    } catch (err) {
      const broken = uniqueConstraint(err);
      if (broken === "skill_packages_owner_name") throw new ORPCError("CONFLICT", message("plugins.install.skillTaken", { name }));
      if (broken !== null) throw new ORPCError("CONFLICT", message("plugins.install.installed", { plugin: entry.name }));
      throw err;
    }
    for (const tool of created.tools) await refreshActions(context.db, context.secrets, context.tools, tool);
    const made = { pluginId, toolIds: created.tools.map((t) => t.id), agentIds: created.agentIds };
    if (!setupPicked) return { ...made, setup: undefined };
    // Set up as `setUp` does, from the definitions the token covers: an item refused leaves the plugin installed, and Set up goes on from there.
    const items = await setupItems(context.db, context.ownerId, pluginId, input.setup!, true);
    // From a Job, under its context: its approved item is the owner's approval, and each item's procedure checks it as it does a call of the owner.
    const { outcomes } = await runItemsAsOwner(context, pluginId, items.items);
    return { ...made, setup: { outcomes, waiting: items.waiting } };
 }));

type Named = { id: string; name: string };

type CreatedKind = (typeof CREATED_KINDS)[number];

/**
 * For each plugin, what it lists as created as it is now, by kind: a row deleted since is left
 * out, and a field or trigger reads with its table or agent.
 */
async function createdNames(db: Db, ownerId: string, rows: PluginRow[]) {
  const all = (kind: CreatedKind) => [...new Set(rows.flatMap((r) => r.created[kind] ?? []))];
  const load = async (ids: string[], query: (ids: string[]) => Promise<Named[]>) => new Map((ids.length ? await query(ids) : []).map((r) => [r.id, r]));
  const found = {
    table: await load(all("table"), (ids) =>
      db.select({ id: tablesTable.id, name: tablesTable.name }).from(tablesTable).where(and(inArray(tablesTable.id, ids), eq(tablesTable.ownerId, ownerId))),
    ),
    field: await load(all("field"), (ids) =>
      db
        .select({ id: fieldsTable.id, name: sql<string>`${tablesTable.name} || '.' || ${fieldsTable.name}` })
        .from(fieldsTable)
        .innerJoin(tablesTable, eq(tablesTable.id, fieldsTable.tableId))
        .where(and(inArray(fieldsTable.id, ids), eq(fieldsTable.ownerId, ownerId))),
    ),
    agent: await load(all("agent"), (ids) =>
      db.select({ id: agentsTable.id, name: agentsTable.name }).from(agentsTable).where(and(inArray(agentsTable.id, ids), eq(agentsTable.ownerId, ownerId))),
    ),
    trigger: await load(all("trigger"), (ids) =>
      db
        .select({ id: triggersTable.id, name: sql<string>`${agentsTable.name} || ': ' || ${triggersTable.name}` })
        .from(triggersTable)
        .innerJoin(agentsTable, eq(agentsTable.id, triggersTable.agentId))
        .where(and(inArray(triggersTable.id, ids), eq(triggersTable.ownerId, ownerId))),
    ),
    tool: await load(all("tool"), (ids) =>
      db.select({ id: toolsTable.id, name: toolsTable.name }).from(toolsTable).where(and(inArray(toolsTable.id, ids), eq(toolsTable.ownerId, ownerId))),
    ),
  };
  return new Map(
    rows.map((r) => [r.id, Object.fromEntries(CREATED_KINDS.map((kind) => [kind, (r.created[kind] ?? []).flatMap((id) => found[kind].get(id) ?? [])])) as Record<CreatedKind, Named[]>]),
  );
}

/** The kind a definition's key in `created.from` makes. */
const MADE: Record<"primitive" | "agent" | "trigger", CreatedKind> = { primitive: "table", agent: "agent", trigger: "trigger" };

/** A plugin's definitions, each with whether what was set up from it is still there. */
function definitionsView(row: PluginRow, named: Record<CreatedKind, Named[]>) {
  const setUp = (key: "primitive" | "agent" | "trigger", name: string) => {
    const id = row.created.from?.[`${key}:${name}`];
    return id !== undefined && named[MADE[key]].some((n) => n.id === id);
  };
  const { agents, primitives, triggers } = row.definitions;
  return {
    agents: agents.map((d) => ({ name: d.name, description: d.description, harness: d.harness ?? null, selfLearning: d.selfLearning ?? [], setUp: setUp("agent", d.name) })),
    primitives: primitives.map((d) => ({ name: d.name, setUp: setUp("primitive", d.name) })),
    triggers: triggers.map((d) => ({ name: d.name, agent: d.agent, setUp: setUp("trigger", d.name) })),
  };
}

/** `a` and then those of `b` it doesn't hold, by id. */
export const merged = (a: Named[], b: Named[]) => [...a, ...b.filter((n) => !a.some((m) => m.id === n.id))];

export const list = owner.handler(async ({ context }) => {
  const rows = await context.db.select().from(pluginsTable).where(eq(pluginsTable.ownerId, context.ownerId)).orderBy(asc(pluginsTable.name));
  const ids = rows.map((r) => r.id);
  const packages = ids.length ? await context.db.select().from(skillPackages).where(inArray(skillPackages.pluginId, ids)) : [];
  const skillRows = packages.length
    ? await context.db
        .select()
        .from(skillsTable)
        .where(
          inArray(
            skillsTable.packageId,
            packages.map((p) => p.id),
          ),
        )
        .orderBy(asc(skillsTable.name))
    : [];
  const markets = await context.db.select().from(marketplacesTable).where(eq(marketplacesTable.ownerId, context.ownerId));
  const toolRows = ids.length
    ? await context.db
        .select({ id: toolsTable.id, name: toolsTable.name, pluginId: toolsTable.pluginId, component: toolsTable.pluginComponent })
        .from(toolsTable)
        .where(inArray(toolsTable.pluginId, ids))
        .orderBy(asc(toolsTable.name))
    : [];
  const agentRows = ids.length
    ? await context.db
        .select({ id: agentsTable.id, name: agentsTable.name, pluginId: agentsTable.pluginId, component: agentsTable.pluginComponent })
        .from(agentsTable)
        .where(inArray(agentsTable.pluginId, ids))
        .orderBy(asc(agentsTable.name))
    : [];
  const created = await createdNames(context.db, context.ownerId, rows);
  return rows.map((r) => {
    const named = created.get(r.id)!;
    if (r.source === "generated") {
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        source: r.source,
        marketplace: null,
        url: null,
        sha: null,
        updatedAt: r.updatedAt,
        skills: [],
        tools: named.tool,
        agents: named.agent,
        tables: named.table,
        fields: named.field,
        triggers: named.trigger,
        definitions: definitionsView(r, named),
        available: { skills: [], mcpServers: [], agents: [] },
        notImported: [],
      };
    }
    const pkg = packages.find((p) => p.pluginId === r.id);
    const imported = skillRows.filter((s) => s.packageId === pkg?.id).map((s) => ({ name: s.name, description: s.description }));
    const tools = toolRows.filter((t) => t.pluginId === r.id);
    const agents = agentRows.filter((a) => a.pluginId === r.id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      marketplace: markets.find((m) => m.id === r.marketplaceId)?.name ?? "",
      url: r.url,
      sha: r.sha,
      updatedAt: r.updatedAt,
      skills: imported,
      // Only what is linked to it: a catalog tool its setup added has no plugin_id and is not its own.
      tools: tools.map(({ id, name }) => ({ id, name })),
      agents: merged(
        agents.map(({ id, name }) => ({ id, name })),
        named.agent,
      ),
      tables: named.table,
      fields: named.field,
      triggers: named.trigger,
      definitions: definitionsView(r, named),
      // What the plugin offers that wasn't imported (or was added upstream since).
      available: {
        skills: r.components.skills.filter((s) => !imported.some((i) => i.name === s.name)),
        mcpServers: r.components.mcpServers.filter((s) => !tools.some((t) => t.component === s.name)),
        agents: r.components.agents.filter((a) => !agents.some((i) => i.component === a.name)),
      },
      notImported: r.notImported,
    };
  });
});

const SetupInput = z.object({ id: z.string(), pick: SetupPick });

const setupReview = (items: unknown) => canonicalHash(items);

/** The items `setUp` would make now, in words as a proposal shows them, and what can't be made yet. */
const setupPreview = owner.input(SetupInput).handler(async ({ input, context }) => {
  const setup = await setupItems(context.db, context.ownerId, input.id, input.pick);
  return { ...(await itemsView(context.db, context.ownerId, setup.items)), waiting: setup.waiting, reviewed: setupReview(setup.items) };
});

/**
 * Sets up the definitions picked: the same items an approved proposal would make, made by the
 * owner, who is the person approving. Stops at the first refusal; the next run resumes.
 */
const setUp = owner.input(SetupInput.extend({ reviewed: z.string().length(64) })).handler(async ({ input, context }) => {
  const setup = await setupItems(context.db, context.ownerId, input.id, input.pick);
  if (setupReview(setup.items) !== input.reviewed) throw new ORPCError("CONFLICT", message("plugins.setup.changed"));
  const { outcomes } = await runItemsAsOwner(context, input.id, setup.items);
  return { outcomes, waiting: setup.waiting };
});

/**
 * Puts a field of a plugin's agent or tool back to the plugin's value, through the element's own
 * update, so every check of an ordinary change applies (a tool sent back to another origin loses its headers).
 */
const resetOverride = owner.input(z.object({ kind: z.enum(["agent", "tool", "trigger", "skill"]), id: z.string().max(64), field: z.string().max(600) })).handler(async ({ input, context }) => {
  const { kind, id, field } = input;
  if (kind === "skill") {
    // A skill's fields are its files: `file:<path>`.
    if (!field.startsWith("file:")) throw new ORPCError("BAD_REQUEST", message("plugins.override.notField"));
    await context.db.transaction((tx) => resetFile(tx, context.ownerId, id, field.slice("file:".length)));
    await context.engine.narrowOwnerSessions(context.ownerId, context.db);
    return { overridden: [] };
  }
  if (!(ELEMENT_FIELDS[kind].overridable as readonly string[]).includes(field)) throw new ORPCError("BAD_REQUEST", message("plugins.override.notField"));
  const table = kind === "agent" ? agentsTable : kind === "tool" ? toolsTable : triggersTable;
  const [row] = await context.db
    .select({ upstream: table.upstream })
    .from(table)
    .where(and(eq(table.id, id), eq(table.ownerId, context.ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND", message("plugins.override.notFound"));
  if (!row.upstream || !(field in row.upstream)) throw new ORPCError("BAD_REQUEST", message("plugins.override.noValue"));
  const value = { [field]: row.upstream[field] };
  // The setting that filled it was sealed with the address the override replaced.
  if (kind === "tool" && field === "url" && hasPlaceholder(String(value.url))) {
    throw new ORPCError("BAD_REQUEST", message("plugins.override.needsSetting"));
  }
  return writeFields(context, kind, id, value);
});

const ElementRef = z.object({ kind: z.enum(["agent", "tool", "trigger", "skill_file"]), id: z.string().max(64) });

/** The conflicts of one of a plugin's elements: with Stem, waiting for the owner's Approval, or theirs again. */
export const conflicts = owner.input(ElementRef).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("plugins.ownerSession"));
  const rows = await context.db
    .select()
    .from(pluginConflicts)
    .where(and(eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.kind, input.kind), eq(pluginConflicts.elementId, input.id)))
    .orderBy(asc(pluginConflicts.field));
  // The values as they are now, which the owner decides on: a choice carries their token. Stem's
  // merged value is answered in the Inbox, where the page links (`approvalId`, once its Job ended).
  return Promise.all(rows.map(async (r) => ({ ...(await conflictView(context.db, r)), approvalId: r.status === "approval" ? await approvalOf(context.db, r.runId) : null })));
});

/**
 * The owner's choice on a conflict: on Stem's merged value, accept or decline it; on one that is
 * theirs again, keep their value, take the plugin's, or hand it to Stem once more.
 */
const resolveConflict = owner.input(z.object({ id: z.string().max(64), choice: z.enum(["accept", "decline", "mine", "plugin", "stem"]), reviewed: z.string().length(64) })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("plugins.ownerSession"));
  // Decided on the values the page showed: one that changed since (another update, an edit) is shown again.
  const [row] = await context.db.select().from(pluginConflicts).where(and(eq(pluginConflicts.id, input.id), eq(pluginConflicts.ownerId, context.ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND", message("plugins.override.conflictNotFound"));
  if ((await conflictView(context.db, row)).reviewed !== input.reviewed) throw new ORPCError("CONFLICT", message("plugins.override.conflictChanged"));
  const actor = { type: "user" as const, userId: context.ownerId };
  // A table's changes that went stale or were refused: said in the answer, not made.
  const report = { refused: [] as Refused[], stale: [] as string[] };
  if (input.choice === "accept" || input.choice === "decline") {
    if ((await answerConflict(context, actor, input.id, input.choice === "accept", row.merged, report)) === "gone") throw new ORPCError("NOT_FOUND", message("plugins.override.conflictNotFound"));
  } else if (input.choice === "mine" || input.choice === "plugin") {
    await ownerChoice(context, actor, input.id, input.choice);
  } else {
    const [c] = await context.db.select().from(pluginConflicts).where(and(eq(pluginConflicts.id, input.id), eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.status, "open")));
    if (!c) throw new ORPCError("NOT_FOUND", message("plugins.override.conflictNotFound"));
    const now = await fieldNow(context.db, c);
    const assistant = await findAssistant(context.db, context.ownerId);
    if (!now) throw new ORPCError("BAD_REQUEST", message("plugins.override.notPlugins"));
    if (!assistant) throw new ORPCError("BAD_REQUEST", message("plugins.update.assistantFirst"));
    const table = elementTable(c.kind);
    const [element] = await context.db.select({ name: table.name }).from(table).where(eq(table.id, c.elementId));
    // Handed off again against the values as they are now.
    await handToStem(context, c.pluginId, assistant.agentId, [{ key: `${c.kind}:${c.elementId}:${c.field}`, kind: c.kind === "skill_file" ? "skill" : (c.kind as UpdatableKind), id: c.elementId, name: element?.name ?? c.kind, field: c.field, old: c.old, mine: now.value, next: now.plugin }]);
  }
  await context.engine.narrowOwnerSessions(context.ownerId, context.db);
  return { ok: true, ...(report.refused.length ? { refused: report.refused } : {}), ...(report.stale.length ? { stale: report.stale } : {}) };
});

export const plugins = { discover, preview, install, list, uninstallPreview, uninstall, update, setupPreview, setUp, resetOverride, addServer, updatePreview, conflicts, resolveConflict, tableChanges: tableChangesOf, applyTableChange };
