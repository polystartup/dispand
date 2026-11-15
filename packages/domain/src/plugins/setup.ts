import { call, ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { Tx } from "../skills/procedures.ts";
import { agents as agentsTable, fields as fieldsTable, plugins, skillPackages, skills as skillsTable, tables as tablesTable, tools as toolsTable, triggers as triggersTable, type ProposalItem } from "../db/schema.ts";
import { agents } from "../agents/procedures.ts";
import { fields, tables } from "../data/tables.ts";
import { logError } from "../log.ts";
import { message, type MessageKey, type MessageValues, reasonOf, say, type Text } from "../messages/index.ts";
import { CREATES, parseWithRefs, recordCreated, resolveRefs, snapshotToolPermissions } from "../platform/proposals.ts";
import type { InitialContext } from "../rpc/context.ts";
import { emitLog, meter, recordError, tracer } from "../telemetry/index.ts";
import { catalogEntry } from "../tools/catalog.ts";
import { tools } from "../tools/procedures.ts";
import { pollProblem, toolPollProblem } from "../tools/pollable.ts";
import { INTERACTION } from "../triggers/model.ts";
import { triggers as triggerProcedures } from "../triggers/procedures.ts";
import type { AgentDefinition, PluginDefinitions, PrimitiveDefinition, TriggerDefinition } from "./definitions.ts";
import type { PluginComponents } from "./read-plugin.ts";
import { addServer } from "./servers.ts";

// Setting a workspace up from a plugin's definitions: `setupItems` turns the definitions picked
// into the items a proposal lists (`{ "$item": n }` where an id goes), and `runItemsAsOwner` makes
// them for the owner, through the same procedures. What each item makes is recorded in the
// plugin's `created`, and under its definition in `created.from`: a run stopped on the way is
// resumed from there, by id, never by a name.

const Name = z.string().trim().min(1).max(100);

/** What the owner picks to set up: definitions by name, each agent with the harness it runs on, and servers to add as tools (triggers come later). */
export const SetupPick = z.object({
  primitives: z.array(Name).max(100).optional(),
  agents: z
    .array(z.object({ name: Name, harnessId: z.string().max(64) }))
    .max(100)
    .optional(),
  triggers: z.array(Name).max(100).optional(),
  servers: z
    .array(z.object({ name: Name, runnerId: z.string().max(64).optional() }))
    .max(100)
    .optional(),
});
export type SetupPick = z.infer<typeof SetupPick>;

/** A definition that can't be made yet, and why. */
export type Waiting = { definition: string; reason: Text };

function refuse(key: MessageKey, values?: MessageValues): never {
  throw new ORPCError("BAD_REQUEST", message(key, values));
}

/** The procedures a setup's items call, by tool name, and each one's path for its span. */
const PROCEDURES = {
  tables_create: { procedure: tables.create, path: ["tables", "create"] },
  fields_create: { procedure: fields.create, path: ["fields", "create"] },
  tables_set_primitive: { procedure: tables.setPrimitive, path: ["tables", "setPrimitive"] },
  agents_create: { procedure: agents.create, path: ["agents", "create"] },
  triggers_create: { procedure: triggerProcedures.create, path: ["triggers", "create"] },
  plugins_add_server: { procedure: addServer, path: ["plugins", "addServer"] },
  tools_add_from_catalog: { procedure: tools.addFromCatalog, path: ["tools", "addFromCatalog"] },
} as const;
type SetupTool = keyof typeof PROCEDURES;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** An id or a reference to an item, as one comparable string. */
const canonicalRef = (ref: string | { $item: number }) => (typeof ref === "string" ? ref : `$item:${ref.$item}`);
type Ref = string | { $item: number };

/**
 * The items that set up the definitions picked, in order: every table first, then every field,
 * then what makes a table primitive, so a reference or a parent always names a table already
 * made. A definition this plugin made before is reused by its recorded id while that row exists,
 * whatever it is called now; a table or field that is gone is made again. A table name that isn't
 * one of the plugin's definitions names a table of the workspace. Agents come last, each a copy of
 * its definition: it has no link to the plugin, so an update of the plugin never rewrites it. Each
 * item is parsed with its procedure's input, as a proposal's is.
 */
export async function setupItems(db: Db | Tx, ownerId: string, pluginId: string, pick: SetupPick, fromInstall = false): Promise<{ items: ProposalItem[]; waiting: Waiting[] }> {
  const [plugin] = await db
    .select({ definitions: plugins.definitions, created: plugins.created, components: plugins.components })
    .from(plugins)
    .where(and(eq(plugins.id, pluginId), eq(plugins.ownerId, ownerId)));
  if (!plugin) throw new ORPCError("NOT_FOUND", message("plugins.notFound"));
  const { primitives } = plugin.definitions;
  const from = plugin.created.from ?? {};
  const waiting: Waiting[] = [];

  const picked: PrimitiveDefinition[] = [];
  for (const name of pick.primitives ?? []) {
    const definition = primitives.find((p) => same(p.name, name));
    if (!definition) refuse("plugins.setup.notTable", { name });
    if (!picked.includes(definition)) picked.push(definition);
  }

  // What this plugin made before, still there: its tables (picked or not) and the picked ones' fields.
  const recordedTables = primitives.flatMap((p) => from[`primitive:${p.name}`] ?? []);
  const tableRows = recordedTables.length
    ? await db
        .select({ id: tablesTable.id, primitive: tablesTable.primitive, parentFieldId: tablesTable.parentFieldId })
        .from(tablesTable)
        .where(and(inArray(tablesTable.id, recordedTables), eq(tablesTable.ownerId, ownerId)))
    : [];
  const recordedFields = picked.flatMap((p) => p.fields.flatMap((f) => from[`field:${p.name}.${f.name}`] ?? []));
  const fieldRows = recordedFields.length
    ? await db
        .select({ id: fieldsTable.id, tableId: fieldsTable.tableId })
        .from(fieldsTable)
        .where(and(inArray(fieldsTable.id, recordedFields), eq(fieldsTable.ownerId, ownerId)))
    : [];
  const existing = (p: PrimitiveDefinition) => tableRows.find((t) => t.id === from[`primitive:${p.name}`]);

  const items: ProposalItem[] = [];
  // Each plugin table this setup can name: made before, or by an item of this one.
  const tableOf = new Map<string, Ref>();
  for (const p of primitives) {
    const row = existing(p);
    if (row) tableOf.set(p.name.toLowerCase(), row.id);
    else if (picked.includes(p)) {
      tableOf.set(p.name.toLowerCase(), { $item: items.length });
      items.push({ tool: "tables_create", input: { name: p.name }, from: `primitive:${p.name}` });
    }
  }
  const pluginTable = (name: string, by: PrimitiveDefinition): Ref => tableOf.get(name.toLowerCase()) ?? refuse("plugins.setup.pickTable", { table: by.name, name });

  // Tables of the workspace a field names, by name: those that aren't the plugin's own.
  const outside = [...new Set(picked.flatMap((p) => p.fields.flatMap((f) => (f.references && !primitives.some((d) => same(d.name, f.references!)) ? [f.references.toLowerCase()] : []))))];
  const workspace = outside.length
    ? await db
        .select({ id: tablesTable.id, name: tablesTable.name })
        .from(tablesTable)
        // The owner's own tables: another plugin's table of that name isn't the workspace's.
        .where(and(eq(tablesTable.ownerId, ownerId), isNull(tablesTable.pluginId), inArray(sql`lower(${tablesTable.name})`, outside)))
    : [];

  for (const p of picked) {
    const table = tableOf.get(p.name.toLowerCase())!;
    for (const f of p.fields) {
      const key = `field:${p.name}.${f.name}`;
      // Kept while it is still a field of the table it was made in.
      if (typeof table === "string" && fieldRows.some((r) => r.id === from[key] && r.tableId === table)) continue;
      // Every table is made with its Name field.
      if (same(f.name, "Name")) {
        waiting.push({ definition: key, reason: say("plugins.setup.waiting.nameField") });
        continue;
      }
      let references: Ref | undefined;
      if (f.references !== undefined) {
        if (primitives.some((d) => same(d.name, f.references!))) {
          references = pluginTable(f.references, p);
        } else {
          references = workspace.find((t) => same(t.name, f.references!))?.id;
          if (!references) {
            waiting.push({ definition: key, reason: say("plugins.setup.waiting.noWorkspaceTable", { table: f.references }) });
            continue;
          }
        }
      }
      const input = { tableId: table, name: f.name, type: f.type, ...(f.choices ? { choices: f.choices } : {}), ...(references === undefined ? {} : { referencesTableId: references }) };
      items.push({ tool: "fields_create", input, from: key });
    }
  }

  for (const p of picked) {
    if (!p.primitive && !p.parent) continue;
    const row = existing(p);
    // A table made before keeps how the owner has it, unless it lacks what the definition sets.
    if (row && row.primitive === p.primitive && (!p.parent || row.parentFieldId !== null)) continue;
    let parent: { tableId: Ref; required: boolean } | undefined;
    if (p.parent) {
      const field = p.fields.find((f) => same(f.name, p.parent!.field))!;
      parent = { tableId: pluginTable(field.references!, p), required: p.parent.required };
    }
    items.push({ tool: "tables_set_primitive", input: { id: tableOf.get(p.name.toLowerCase())!, primitive: p.primitive, ...(parent ? { parent } : {}) } });
  }

  const agentItems = await agentSetup(db, ownerId, pluginId, plugin.definitions, plugin.components.mcpServers, from, pick, tableOf, items, fromInstall);
  items.push(...agentItems.items);
  waiting.push(...agentItems.waiting);

  // Parsed as each procedure takes it, references standing for ids, as a proposal's items are.
  for (const [i, item] of items.entries()) {
    const parsed = parseWithRefs(PROCEDURES[item.tool as SetupTool].procedure["~orpc"].inputSchema!, item.input);
    if ("error" in parsed) refuse("plugins.setup.item", { number: i + 1, tool: item.tool, reason: parsed.error });
    item.input = parsed.data;
    const prepared = await snapshotToolPermissions(db, ownerId, items.slice(0, i), item);
    if (typeof prepared === "string") refuse("plugins.setup.item", { number: i + 1, tool: item.tool, reason: prepared });
    items[i] = prepared;
  }
  return { items, waiting };
}

/**
 * The `agents_create` items of the agents picked, numbered from `first`: each with its definition's
 * prompt, description, bundles and self-learning, the harness picked, its tables (the plugin's,
 * made before or by this setup, else the workspace's of that name), the plugin's skill package when
 * it lists a skill installed in it, the tools already added for what it names, and the agents it
 * consults among those this plugin made or this setup makes. An agent made before is reused by its
 * recorded id. Each server of the plugin and catalog entry a new agent names, or the owner picked,
 * that isn't a tool yet is added by an item placed before the agents. What it names that isn't
 * there yet is listed in `waiting`: a missing table holds the agent back (its tables are what it
 * works on), a missing skill, tool or consult doesn't.
 */
async function agentSetup(
  db: Db | Tx,
  ownerId: string,
  pluginId: string,
  { agents: definitions, triggers: triggerDefinitions }: PluginDefinitions,
  servers: PluginComponents["mcpServers"],
  from: Record<string, string>,
  pick: SetupPick,
  tableOf: Map<string, Ref>,
  prior: ProposalItem[],
  // Run from the install, which shows no items: no server it didn't tick is added, and every tool given starts on Ask.
  fromInstall: boolean,
): Promise<{ items: ProposalItem[]; waiting: Waiting[] }> {
  const first = prior.length;
  const picked: { definition: AgentDefinition; harnessId: string }[] = [];
  for (const p of pick.agents ?? []) {
    const definition = definitions.find((d) => same(d.name, p.name));
    if (!definition) refuse("plugins.setup.notAgent", { name: p.name });
    if (!picked.some((a) => a.definition === definition)) picked.push({ definition, harnessId: p.harnessId });
  }
  for (const p of pick.servers ?? []) if (!servers.some((s) => s.name === p.name)) refuse("plugins.setup.notServer", { name: p.name });
  const triggers: TriggerDefinition[] = [];
  for (const name of pick.triggers ?? []) {
    const definition = triggerDefinitions.find((t) => same(t.name, name));
    if (!definition) refuse("plugins.setup.notTrigger", { name });
    if (!triggers.includes(definition)) triggers.push(definition);
  }
  if (!picked.length && !pick.servers?.length && !triggers.length) return { items: [], waiting: [] };

  // The agents this plugin made before, still there: they are reused, and may be consulted.
  const recorded = definitions.flatMap((d) => from[`agent:${d.name}`] ?? []);
  const agentRows = recorded.length
    ? await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(and(inArray(agentsTable.id, recorded), eq(agentsTable.ownerId, ownerId)))
    : [];
  const agentOf = new Map<string, Ref>();
  for (const d of definitions) {
    const id = from[`agent:${d.name}`];
    if (id && agentRows.some((r) => r.id === id)) agentOf.set(d.name.toLowerCase(), id);
  }

  // The plugin's skill package and the skills installed in it.
  const [pkg] = await db
    .select({ id: skillPackages.id })
    .from(skillPackages)
    .where(and(eq(skillPackages.pluginId, pluginId), eq(skillPackages.ownerId, ownerId)));
  const installed = pkg ? (await db.select({ name: skillsTable.name }).from(skillsTable).where(eq(skillsTable.packageId, pkg.id))).map((s) => s.name) : [];

  // The tables named that are neither the plugin's set up nor made now: the workspace's, by name.
  const named = [
    ...picked.flatMap((a) => (Array.isArray(a.definition.tables) ? a.definition.tables : [])),
    ...triggers.flatMap((t) => (t.config.kind === "primitive" && t.config.table !== INTERACTION ? [t.config.table] : [])),
  ];
  const outside = [...new Set(named.map((n) => n.toLowerCase()).filter((n) => !tableOf.has(n)))];
  const workspace = outside.length
    ? await db
        .select({ id: tablesTable.id, name: tablesTable.name })
        .from(tablesTable)
        // The owner's own tables: another plugin's table of that name isn't the workspace's.
        .where(and(eq(tablesTable.ownerId, ownerId), isNull(tablesTable.pluginId), inArray(sql`lower(${tablesTable.name})`, outside)))
    : [];
  const tableNamed = (name: string): Ref | undefined => tableOf.get(name.toLowerCase()) ?? workspace.find((t) => same(t.name, name))?.id;

  // An agent comes after the ones it consults, so it can name them; in a loop, the first one placed waits for its consult.
  const pending = picked.filter((a) => !agentOf.has(a.definition.name.toLowerCase()));
  const ordered: typeof pending = [];
  while (pending.length) {
    const ready = pending.find((a) => a.definition.consults.every((c) => !pending.some((o) => o !== a && same(o.definition.name, c.agent))));
    const next = ready ?? pending[0]!;
    ordered.push(next);
    pending.splice(pending.indexOf(next), 1);
  }

  const items: ProposalItem[] = [];
  const waiting: Waiting[] = [];

  // The tools the new agents name and the servers picked: added already (for the plugin's servers, or from the catalog entries named), else by an item here.
  const pollTool = (t: TriggerDefinition) => (t.config.kind === "poll" ? [t.config.server ?? `catalog:${t.config.catalog}`] : []);
  const toolNames = [...new Set([...(pick.servers ?? []).map((s) => s.name), ...ordered.flatMap((a) => a.definition.tools), ...triggers.flatMap(pollTool)])];
  const catalogIds = toolNames.filter((t) => t.startsWith("catalog:")).map((t) => t.slice("catalog:".length));
  const toolRows = await db
    .select({ id: toolsTable.id, pluginId: toolsTable.pluginId, component: toolsTable.pluginComponent, catalogId: toolsTable.catalogId })
    .from(toolsTable)
    .where(and(eq(toolsTable.ownerId, ownerId), catalogIds.length ? or(eq(toolsTable.pluginId, pluginId), inArray(toolsTable.catalogId, catalogIds)) : eq(toolsTable.pluginId, pluginId)))
    .orderBy(asc(toolsTable.createdAt));
  const toolOf = new Map<string, Ref>();
  for (const name of toolNames) {
    const id = name.startsWith("catalog:") ? name.slice("catalog:".length) : null;
    const row = id === null ? toolRows.find((t) => t.pluginId === pluginId && t.component === name) : toolRows.find((t) => t.catalogId === id);
    if (row) {
      toolOf.set(name, row.id);
      continue;
    }
    const definition = `tool:${name}`;
    if (id !== null) {
      const entry = catalogEntry(id);
      if (entry?.kind !== "http") {
        waiting.push({ definition, reason: entry ? say("plugins.setup.waiting.onMachine", { name: entry.name }) : say("plugins.setup.waiting.notInCatalog") });
        continue;
      }
      toolOf.set(name, { $item: first + items.length });
      items.push({ tool: "tools_add_from_catalog", input: { catalogId: id }, from: `catalog:${id}` });
      continue;
    }
    const server = servers.find((s) => s.name === name);
    if (!server) continue;
    const reason = fromInstall
      ? say("plugins.setup.waiting.notTicked")
      : server.type !== "http" ? say("plugins.setup.waiting.onRunner") : server.settings.length ? say("plugins.setup.waiting.needsSetting") : !server.transport ? say("plugins.setup.waiting.updateToAdd") : null;
    if (reason) {
      waiting.push({ definition, reason });
      continue;
    }
    toolOf.set(name, { $item: first + items.length });
    items.push({ tool: "plugins_add_server", input: { pluginId, server: name, url: server.url, transport: server.transport }, from: `server:${name}` });
  }

  for (const { definition: d, harnessId } of ordered) {
    const key = `agent:${d.name}`;
    // Written out even when the definition leaves it out (`agents.create` takes all then), so the owner reads the grant.
    let dataTables: Ref[] | "all" = "all";
    if (Array.isArray(d.tables)) {
      const missing = d.tables.filter((n) => tableNamed(n) === undefined);
      if (missing.length) {
        waiting.push({ definition: key, reason: say("plugins.setup.waiting.noTable", { table: missing[0]! }) });
        continue;
      }
      dataTables = d.tables.map((n) => tableNamed(n)!);
    }
    for (const s of d.skills.filter((s) => !installed.includes(s))) waiting.push({ definition: key, reason: say("plugins.setup.waiting.noSkill", { skill: s }) });
    const toolIds: Ref[] = [];
    for (const t of new Set(d.tools)) {
      const tool = toolOf.get(t);
      if (tool && !toolIds.some((id) => canonicalRef(id) === canonicalRef(tool))) toolIds.push(tool);
      else waiting.push({ definition: key, reason: say("plugins.setup.waiting.noTool", { tool: t }) });
    }
    const consults: { agentId: Ref; ask: boolean }[] = [];
    for (const c of d.consults) {
      const agent = agentOf.get(c.agent.toLowerCase());
      if (agent) consults.push({ agentId: agent, ask: c.ask });
      else waiting.push({ definition: key, reason: say("plugins.setup.waiting.noConsult", { agent: c.agent }) });
    }
    agentOf.set(d.name.toLowerCase(), { $item: first + items.length });
    const input = {
      name: d.name,
      description: d.description,
      harnessId,
      systemPrompt: d.systemPrompt,
      ...(d.bundles ? { bundles: d.bundles } : {}),
      ...(d.selfLearning ? { selfLearning: d.selfLearning } : {}),
      dataTables,
      skillPackageIds: pkg && d.skills.some((s) => installed.includes(s)) ? [pkg.id] : [],
      toolIds,
      ...(fromInstall && toolIds.length ? { toolPermissions: toolIds.map((toolId) => ({ toolId, unasked: [] })) } : {}),
      ...(consults.length ? { consults } : {}),
    };
    items.push({ tool: "agents_create", input, from: key });
  }

  // Triggers last, each on its agent: made before, or by an item above. A trigger made before is reused by its recorded id.
  const made = triggers.flatMap((t) => from[`trigger:${t.name}`] ?? []);
  const triggerRows = made.length
    ? await db
        .select({ id: triggersTable.id })
        .from(triggersTable)
        .where(and(inArray(triggersTable.id, made), eq(triggersTable.ownerId, ownerId)))
    : [];
  for (const t of triggers) {
    const key = `trigger:${t.name}`;
    if (triggerRows.some((r) => r.id === from[key])) continue;
    const wait = (reason: Text) => waiting.push({ definition: key, reason });
    const agentId = agentOf.get(t.agent.toLowerCase());
    if (!agentId) {
      wait(say("plugins.setup.waiting.noAgent", { agent: t.agent }));
      continue;
    }
    let config: Record<string, unknown>;
    if (t.config.kind === "primitive") {
      const { table, fields, ...rest } = t.config;
      const tableId = table === INTERACTION ? INTERACTION : tableNamed(table);
      if (tableId === undefined) {
        wait(say("plugins.setup.waiting.noTable", { table }));
        continue;
      }
      const fieldIds: Ref[] = [];
      const missing = await (async () => {
        if (!fields) return null;
        const rows = typeof tableId === "string" ? await db.select({ id: fieldsTable.id, name: fieldsTable.name }).from(fieldsTable).where(and(eq(fieldsTable.tableId, tableId), eq(fieldsTable.ownerId, ownerId))) : [];
        for (const name of fields) {
          const row = rows.find((r) => same(r.name, name));
          // A field this setup makes is named by its item.
          const item = prior.findIndex((i) => i.tool === "fields_create" && same((i.input as { name: string }).name, name) && canonicalRef((i.input as { tableId: Ref }).tableId) === canonicalRef(tableId));
          if (row) fieldIds.push(row.id);
          else if (item >= 0) fieldIds.push({ $item: item });
          else return name;
        }
        return null;
      })();
      if (missing !== null) {
        wait(say("plugins.setup.waiting.noField", { field: missing }));
        continue;
      }
      config = { ...rest, tableId, ...(fields ? { fields: fieldIds } : {}) };
    } else if (t.config.kind === "poll") {
      const { server, catalog, ...rest } = t.config;
      const name = server ?? `catalog:${catalog}`;
      const toolId = toolOf.get(name);
      if (toolId === undefined) {
        wait(say("plugins.setup.waiting.noPollTool", { tool: name }));
        continue;
      }
      // A server added by this setup lists its actions only once it is added (and signed in): its poll comes afterwards.
      if (typeof toolId !== "string" && server !== undefined) {
        wait(say("plugins.setup.waiting.addedBySetup", { tool: name }));
        continue;
      }
      // An agent the install makes asks before every action: a poll, which runs its action unasked, would be refused.
      if (fromInstall && typeof agentId !== "string") {
        wait(say("plugins.setup.waiting.pollUnasked", { action: t.config.action, agent: t.agent }));
        continue;
      }
      // What `triggers.create` would refuse, said now: the setup doesn't stop on it.
      if (typeof toolId === "string") {
        // An agent this setup makes will hold the tools its definition names.
        const problem =
          typeof agentId === "string"
            ? await pollProblem(db, ownerId, agentId, toolId, t.config.action)
            : await toolPollProblem(db, ownerId, toolId, t.config.action, () => definitions.some((d) => same(d.name, t.agent) && d.tools.includes(name)));
        if (problem) {
          wait({ text: problem });
          continue;
        }
      }
      config = { ...rest, toolId };
    } else config = t.config;
    const { name, instructions, concurrency, rateCap } = t;
    items.push({ tool: "triggers_create", input: { agentId, name, instructions, concurrency, rateCap, config }, from: key });
  }
  return { items, waiting };
}

/** How each item of a setup ended. */
export type ItemOutcome = { $item: number; tool: string; from?: string; outcome: "made" | "refused" | "not made"; id?: string; error?: Text };

const traces = tracer("plugins");
const counts = meter("plugins");

/** The id a create returned. */
const idOf = (output: unknown): string | null => {
  const id = (output as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
};

/**
 * Makes a setup's items in order, as the owner (their own context, through each item's
 * procedure), references replaced by what earlier items created. Stops at the first refusal:
 * nothing is undone, and the next setup resumes from what the plugin recorded.
 */
export function runItemsAsOwner(context: InitialContext & { ownerId: string }, pluginId: string, items: ProposalItem[]): Promise<{ outcomes: ItemOutcome[] }> {
  return traces.startActiveSpan("plugins.setup", { attributes: { "dispand.plugin.id": pluginId, "dispand.setup.items": items.length } }, async (span) => {
    let result = "done";
    try {
      const [plugin] = await context.db.select({ definitions: plugins.definitions }).from(plugins).where(eq(plugins.id, pluginId));
      /** What an item makes from a definition is the plugin's from its insert, under its name there. */
      const elementOf = (item: ProposalItem) => {
        if (!item.from || !/^(primitive|field|agent|trigger):/.test(item.from)) return undefined;
        const component = (item.input as { name: string }).name;
        const definition = item.from.startsWith("primitive:") ? plugin?.definitions.primitives.find((p) => p.name === component) : undefined;
        return { pluginId, component, ...(definition ? { definition } : {}) };
      };
      const made: ProposalItem[] = [];
      const outcomes: ItemOutcome[] = [];
      for (const [index, item] of items.entries()) {
        const at = { $item: index, tool: item.tool, ...(item.from ? { from: item.from } : {}) };
        if (result === "stopped") {
          outcomes.push({ ...at, outcome: "not made" });
          made.push(item);
          continue;
        }
        const input = resolveRefs(made, { ...(item.input as object), ...(item.toolPermissions ? { toolPermissions: item.toolPermissions } : {}) });
        let error: Text | null = input === null ? say("plugins.setup.noRef") : null;
        let output: unknown;
        if (input !== null) {
          const { procedure, path } = PROCEDURES[item.tool as SetupTool];
          try {
            const permissions = item.toolPermissions ? resolveRefs(made, item.toolPermissions) as { toolId: string; target: string; strictTarget?: string }[] : undefined;
            const pluginElement = elementOf(item);
            output = await call(procedure as never, input as never, { context: { ...context, approvedToolTargets: permissions, ...(pluginElement ? { pluginElement } : {}) } as never, path: [...path] });
          } catch (err) {
            if (err instanceof ORPCError) error = err.code === "NOT_FOUND" ? say("plugins.setup.notFound") : reasonOf(err);
            else {
              logError("plugin setup item failed", err, { ref: `${pluginId}:${item.tool}` });
              error = say("plugins.setup.failed");
            }
          }
        }
        if (error !== null) {
          result = "stopped";
          outcomes.push({ ...at, outcome: "refused", error });
          made.push(item);
          continue;
        }
        const kind = CREATES[item.tool];
        const id = kind ? idOf(output) : null;
        if (kind && id) await recordCreated(context.db, pluginId, kind, id, item.from);
        made.push(id ? { ...item, createdId: id } : item);
        outcomes.push({ ...at, outcome: "made", ...(id ? { id } : {}) });
      }
      const count = outcomes.filter((o) => o.outcome === "made").length;
      span.setAttribute("dispand.setup.made", count);
      if (result === "stopped") {
        recordError(span, "stopped");
        emitLog("plugins", "info", "plugin setup stopped", { "dispand.plugin.id": pluginId, "dispand.setup.items": items.length, "dispand.setup.made": count });
      }
      return { outcomes };
    } catch (err) {
      result = "failed";
      throw err;
    } finally {
      span.setAttribute("dispand.result", result);
      counts.counter("dispand.plugins.setups").add(1, { "dispand.result": result });
      span.end();
    }
  });
}
