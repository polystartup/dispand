import { ORPCError } from "@orpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { agents as agentsTable, agentSkills, agentTools, fields as fieldsTable, plugins as pluginsTable, skillPackages, skillFileUpstream, tables as tablesTable, tools as toolsTable, triggers as triggersTable } from "../db/schema.ts";
import { pluginNativeKey } from "../skills/native.ts";
import { message } from "../messages/index.ts";
import { lockConsults } from "../engine/consults.ts";
import { type InitialContext } from "../rpc/context.ts";
import { type Tx } from "../skills/procedures.ts";
import { checkChoices, type Element, inUse } from "./closure.ts";
import { forgetConflicts } from "./resolve.ts";
import { canonicalHash } from "../platform/approvals.ts";
import { owner, acted, Id, PluginRow, findPlugin } from "./common.ts";

/**
 * Locks every element row of the plugin, as their own writes lock them, before a removal works
 * out what is in use: an override, a row of its tables, or a new use of its skills or tools
 * (which share-locks them) waits for the removal instead of landing between the check and the
 * deletion. In the order the writes take them (the consult lock, triggers, agents, then their skills and tools).
 */
export async function lockElements(tx: Tx, ownerId: string, pluginId: string) {
  // The consult lock first, as an agent's edit and its deletion take it before the agent's row.
  await lockConsults(tx, ownerId);
  await tx.select({ id: tablesTable.id }).from(tablesTable).where(eq(tablesTable.pluginId, pluginId)).for("update");
  // Triggers before their agents, as a Job's start takes them.
  await tx.select({ id: triggersTable.id }).from(triggersTable).where(eq(triggersTable.pluginId, pluginId)).for("update");
  await tx.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.pluginId, pluginId)).for("update");
  await tx.select({ id: skillPackages.id }).from(skillPackages).where(eq(skillPackages.pluginId, pluginId)).for("update");
  await tx.select({ id: toolsTable.id }).from(toolsTable).where(eq(toolsTable.pluginId, pluginId)).for("update");
}

const removalReview = (elements: Element[]) => canonicalHash(elements);

/**
 * What removing the plugin would ask about: each of its elements with why (its owner changed
 * it, it holds rows, memory or a running Job, something that stays uses it) and the other
 * elements it needs if kept. `reviewed` binds the removal to this list.
 */
export const uninstallPreview = owner.input(Id).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("plugins.ownerSession"));
  const row = await findPlugin(context.db, context.ownerId, input.id);
  const elements = await inUse(context.db, context.ownerId, row.id);
  return { elements, reviewed: removalReview(elements), nativeName: `dispand-${row.id}`, sourceKey: pluginNativeKey(row) ?? null };
});

/** A name among the owner's own: `name`, else `<name> (<plugin>)`, then with 2, 3… after it, cut so the whole fits a name. */
function freeName(own: Set<string>, name: string, plugin: string): string {
  let free = name;
  for (let n = 1; own.has(free.toLowerCase()); n++) {
    const suffix = ` (${plugin})${n > 1 ? ` ${n}` : ""}`.slice(-60);
    free = `${name.slice(0, 100 - suffix.length)}${suffix}`;
  }
  own.add(free.toLowerCase());
  return free;
}

/**
 * Removes a plugin's elements that leave (all of them at an uninstall, the ones its new version
 * drops at an update), in the order agents, skills, tools, tables, then triggers: one kept
 * (`keep`) becomes its owner's own, with the values it has (a tool or a table under a free
 * name); any other goes, and what used it loses it. The choices were checked (`checkChoices`).
 */
export async function removeElements(tx: Tx, ownerId: string, engine: InitialContext["engine"], row: PluginRow, elements: Element[], choices: Record<string, "keep" | "delete">) {
  const of = (kind: Element["kind"], keep: boolean) => elements.filter((e) => e.kind === kind && (choices[e.key] === "keep") === keep).map((e) => e.id);

  // What leaves the plugin, kept or gone, has no conflict left: its own, and its agents' triggers'.
  const agentIds = elements.filter((e) => e.kind === "agent").map((e) => e.id);
  const agentTriggers = agentIds.length ? await tx.select({ id: triggersTable.id }).from(triggersTable).where(inArray(triggersTable.agentId, agentIds)) : [];
  await forgetConflicts(tx, [...elements.map((e) => e.id), ...agentTriggers.map((t) => t.id)]);
  // Agents first, so what still uses a skill or a tool afterwards is what stays.
  const out = await engine.deleteAgents(tx, ownerId, of("agent", false));
  for (const id of of("agent", true)) {
    await tx.update(agentsTable).set({ pluginId: null, pluginComponent: null, upstream: null, overridden: [] }).where(eq(agentsTable.id, id));
    await tx.update(triggersTable).set({ pluginId: null, pluginComponent: null, upstream: null, overridden: [] }).where(eq(triggersTable.agentId, id));
  }
  for (const id of of("skill", false)) {
    await tx.delete(agentSkills).where(eq(agentSkills.packageId, id));
    await tx.delete(skillPackages).where(eq(skillPackages.id, id));
  }
  for (const id of of("skill", true)) {
    await tx.update(skillPackages).set({ pluginId: null }).where(eq(skillPackages.id, id));
    await tx.delete(skillFileUpstream).where(eq(skillFileUpstream.packageId, id));
  }
  const names = async (table: typeof toolsTable | typeof tablesTable) =>
    new Set((await tx.select({ name: table.name }).from(table).where(and(eq(table.ownerId, ownerId), sql`${table.pluginId} is null`))).map((t) => t.name.toLowerCase()));
  for (const id of of("tool", false)) {
    await tx.delete(agentTools).where(eq(agentTools.toolId, id));
    const required = await tx.select({ id: skillPackages.id, tools: skillPackages.requiredToolIds }).from(skillPackages).where(and(eq(skillPackages.ownerId, ownerId), sql`${skillPackages.requiredToolIds} @> ${JSON.stringify([id])}::jsonb`)).for("update");
    for (const pkg of required) await tx.update(skillPackages).set({ requiredToolIds: pkg.tools.filter((toolId) => toolId !== id), updatedAt: sql`now()` }).where(eq(skillPackages.id, pkg.id));
    await tx.delete(toolsTable).where(eq(toolsTable.id, id));
  }
  const toolNames = await names(toolsTable);
  for (const id of of("tool", true)) {
    const [tool] = await tx.select({ name: toolsTable.name }).from(toolsTable).where(eq(toolsTable.id, id));
    await tx.update(toolsTable).set({ name: freeName(toolNames, tool!.name, row.name), pluginId: null, pluginComponent: null, upstream: null, overridden: [] }).where(eq(toolsTable.id, id));
  }
  // Every table to delete at once: they may name each other's rows, and no table that stays names theirs (`checkChoices`).
  const gone = of("table", false);
  if (gone.length) {
    await tx.delete(fieldsTable).where(and(inArray(fieldsTable.tableId, gone), sql`${fieldsTable.referencesTableId} is not null`));
    await tx.delete(tablesTable).where(inArray(tablesTable.id, gone));
  }
  const tableNames = await names(tablesTable);
  for (const id of of("table", true)) {
    const [table] = await tx.select({ name: tablesTable.name }).from(tablesTable).where(eq(tablesTable.id, id));
    await tx.update(tablesTable).set({ name: freeName(tableNames, table!.name, row.name), pluginId: null, pluginComponent: null, definition: null }).where(eq(tablesTable.id, id));
    await tx.update(fieldsTable).set({ pluginField: null }).where(eq(fieldsTable.tableId, id));
  }
  // A trigger dropped while its agent stays: kept as the owner's own, or gone.
  for (const id of of("trigger", true)) await tx.update(triggersTable).set({ pluginId: null, pluginComponent: null, upstream: null, overridden: [] }).where(eq(triggersTable.id, id));
  const triggersGone = of("trigger", false);
  if (triggersGone.length) await tx.delete(triggersTable).where(inArray(triggersTable.id, triggersGone));
  // What left is no longer the plugin's: its setup record forgets it, so a definition of that name can be set up again.
  const left = new Set(elements.map((e) => e.id));
  const [plugin] = await tx.select({ created: pluginsTable.created }).from(pluginsTable).where(eq(pluginsTable.id, row.id));
  if (plugin) {
    const { from = {}, ...kinds } = plugin.created;
    const created = {
      ...Object.fromEntries(Object.entries(kinds).map(([kind, ids]) => [kind, (ids ?? []).filter((id) => !left.has(id))])),
      from: Object.fromEntries(Object.entries(from).filter(([, id]) => !left.has(id))),
    };
    await tx.update(pluginsTable).set({ created }).where(eq(pluginsTable.id, row.id));
  }
  return out;
}

export const Choices = z.record(z.string().max(100), z.enum(["keep", "delete"])).refine((c) => Object.keys(c).length <= 1000, "Too many choices");

/**
 * Removes the plugin and its elements, in the order agents, skills, tools, tables. An element
 * kept (`keep`) becomes its owner's own, with the values it has; any other goes, and what used
 * it loses it. Only what `uninstallPreview` showed is applied (`reviewed`), and the choices are
 * checked as a whole first (`checkChoices`).
 */
export const uninstall = owner.input(Id.extend({ reviewed: z.string().length(64), choices: Choices })).handler(({ input, context }) => acted("uninstall", input.id, async () => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("plugins.ownerSession"));
  const out = await context.db.transaction(async (tx) => {
    const row = await findPlugin(tx, context.ownerId, input.id, true);
    await lockElements(tx, context.ownerId, row.id);
    const elements = await inUse(tx, context.ownerId, row.id);
    if (removalReview(elements) !== input.reviewed) throw new ORPCError("CONFLICT", message("plugins.uninstall.changed", { plugin: row.name }));
    checkChoices(elements, input.choices);
    const out = await removeElements(tx, context.ownerId, context.engine, row, elements, input.choices);
    await tx.delete(pluginsTable).where(eq(pluginsTable.id, row.id));
    return out;
  });
  context.engine.settled(out);
  await context.engine.narrowOwnerSessions(context.ownerId, context.db);
  // An update's Approval whose items all left with the plugin left the Inbox.
  context.engine.questionChanges.publish("changed", true);
}));
