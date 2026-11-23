import { ORPCError } from "@orpc/server";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db, Tx } from "../db/client.ts";
import {
  agentConsults,
  agents,
  agentSkills,
  agentTools,
  fields,
  eventFires,
  memories,
  pollItems,
  rows,
  runs,
  skillPackages,
  tables,
  tools,
  triggers,
  widgets,
} from "../db/schema.ts";
import { tableInUse } from "../data/tables.ts";
import { message, type Message, type MessageKey, type MessageValues, say } from "../messages/index.ts";
import { filesOverridden } from "../skills/runner-access.ts";
import { agentInUse } from "../workflows/procedures.ts";

// What an uninstall asks about. A plugin's element goes with its plugin unless one of three
// things is true: its owner changed it, it holds something a deletion would destroy or stop, or
// something that stays refers to it. What stays is every element that isn't the plugin's, and
// every element of the plugin its owner keeps: so each element also says which others it needs.

/**
 * Every foreign key to an element's table, and what an uninstall does about it: `part` of the
 * element itself, its `history` (kept or gone with it, never asked about), `content` a deletion
 * would destroy (a reason to ask), or a reference something else `needs` it by. A test holds the
 * schema to this list. The ids held in JSON, which no foreign key shows, are followed below too:
 * `agents.data_tables`, `skill_packages.required_tool_ids`, a trigger's `config.toolId` and
 * `config.tableId`, and a workflow's agent, tool and table steps.
 */
export const REFERENCES: Record<string, "part" | "history" | "content" | "needs"> = {
  "agent_consults.agent_id": "part",
  "agent_consults.consulted_id": "needs",
  // A permission remembered for a package's tool: the agent's, gone with any of the three, which `agent_skills` and `required_tool_ids` already tie.
  "agent_skill_tool_permissions.agent_id": "part",
  "agent_skill_tool_permissions.skill_package_id": "part",
  "agent_skill_tool_permissions.tool_id": "part",
  "agent_skills.agent_id": "part",
  "agent_skills.package_id": "needs",
  "agent_tools.agent_id": "part",
  "agent_tools.tool_id": "needs",
  "attachments.table_id": "content",
  "event_fires.trigger_id": "history",
  "fields.references_table_id": "needs",
  "fields.table_id": "part",
  "memories.agent_id": "content",
  "memories.table_id": "content",
  "poll_items.trigger_id": "history",
  // A consult asked of the agent: its record, set to null with it.
  "questions.addressee_agent_id": "history",
  "polls.trigger_id": "history",
  "rows.table_id": "content",
  "runs.agent_id": "history",
  "runs.trigger_id": "history",
  "skill_file_upstream.package_id": "part",
  "skill_files.package_id": "part",
  "skills.package_id": "part",
  // A table's parent is one of its own reference fields: `fields.references_table_id` covers it.
  "tables.parent_field_id": "part",
  "trigger_fires.trigger_id": "history",
  "triggers.agent_id": "part",
  "widgets.table_id": "needs",
  "widgets.trigger_id": "needs",
};

export type ElementKind = "agent" | "skill" | "tool" | "table" | "trigger";

/** An agent that stays, as the same update leaves it: the values it writes over the ones it has now. */
export type After = { dataTables?: unknown; toolIds?: unknown; skillPackageIds?: unknown; consults?: unknown };

/** One of a plugin's elements, as an uninstall sees it. */
export type Element = {
  /** `<kind>:<id>`: what a choice names. */
  key: string;
  kind: ElementKind;
  id: string;
  name: string;
  /** Why it is asked about; empty, it goes with the plugin unless something kept needs it. */
  reasons: Message[];
  /** The plugin's other elements it uses: kept, it needs a stated choice for each. */
  needs: string[];
  /** Why it can only be kept (a workflow uses it), or null. */
  keepOnly: Message | null;
};

const key = (kind: ElementKind, id: string) => `${kind}:${id}`;

/**
 * A plugin's elements that leave, each with why their removal asks about it and what it needs.
 * An uninstall: all of them (`leaving` left out). An update: the ones its new version drops,
 * `leaving` their keys; the plugin's other elements then stay, as the owner's do, and a dropped
 * trigger whose agent stays is an element of its own.
 */
export async function inUse(db: Db | Tx, ownerId: string, pluginId: string, leaving?: Set<string>, after: Map<string, After> = new Map()): Promise<Element[]> {
  const mine = (t: { pluginId: AnyPgColumn; ownerId: AnyPgColumn }) => and(eq(t.pluginId, pluginId), eq(t.ownerId, ownerId));
  const goes = (kind: ElementKind) => (r: { id: string }) => !leaving || leaving.has(key(kind, r.id));
  const [agentRows, skillRows, toolRows, tableRows, triggerRows] = await Promise.all([
    db.select().from(agents).where(mine(agents)).then((rows) => rows.filter(goes("agent"))),
    db.select().from(skillPackages).where(mine(skillPackages)).then((rows) => rows.filter(goes("skill"))),
    db.select().from(tools).where(mine(tools)).then((rows) => rows.filter(goes("tool"))),
    db.select().from(tables).where(mine(tables)).then((rows) => rows.filter(goes("table"))),
    leaving ? db.select().from(triggers).where(mine(triggers)).then((rows) => rows.filter(goes("trigger"))) : Promise.resolve([]),
  ]);
  const ids = { agent: new Set(agentRows.map((r) => r.id)), skill: new Set(skillRows.map((r) => r.id)), tool: new Set(toolRows.map((r) => r.id)), table: new Set(tableRows.map((r) => r.id)) };
  const elements: Element[] = [];

  // What stays whatever is chosen: every agent that isn't leaving (the owner's own, other plugins', and this one's the update keeps).
  const others = (await db.select({ id: agents.id, name: agents.name, dataTables: agents.dataTables }).from(agents).where(eq(agents.ownerId, ownerId))).filter((a) => !ids.agent.has(a.id));
  const otherIds = others.map((a) => a.id);
  /** The staying agents among `rows` that use something, corrected by what the update writes over `field`. */
  const usersAfter = <F extends keyof After>(rows: { agentId: string }[], field: F, uses: (value: NonNullable<After[F]>) => boolean) => [
    ...rows.filter((r) => after.get(r.agentId)?.[field] === undefined),
    ...others.filter((a) => after.get(a.id)?.[field] !== undefined && uses(after.get(a.id)![field]!)).map((a) => ({ agentId: a.id })),
  ];
  const listed = (value: unknown, id: string) => Array.isArray(value) && value.some((v) => v === id || (typeof v === "object" && v !== null && (v as { agentId?: unknown }).agentId === id));
  const nameOf = new Map(others.map((a) => [a.id, a.name]));
  const allTriggers = await db.select().from(triggers).where(eq(triggers.ownerId, ownerId));
  const widgetRows = await db.select({ triggerId: widgets.triggerId, tableId: widgets.tableId }).from(widgets).where(eq(widgets.ownerId, ownerId));
  const pollTool = (t: (typeof allTriggers)[number]) => (t.config.kind === "poll" ? t.config.toolId : null);
  const watched = (t: (typeof allTriggers)[number]) => (t.config.kind === "primitive" ? t.config.tableId : null);
  /** A trigger that stays: on an agent that stays, and not itself leaving. */
  const staying = allTriggers.filter((t) => !ids.agent.has(t.agentId) && !triggerRows.some((r) => r.id === t.id));

  for (const a of agentRows) {
    const reasons: Message[] = [];
    let keepOnly: Message | null = null;
    if (a.overridden.length) reasons.push(say("plugins.reason.changed"));
    const own = allTriggers.filter((t) => t.agentId === a.id);
    for (const t of own.filter((t) => t.pluginId === pluginId && t.overridden.length)) reasons.push(say("plugins.reason.changedTrigger", { name: t.name }));
    for (const t of own.filter((t) => t.pluginId !== pluginId)) reasons.push(say("plugins.reason.ownTrigger", { name: t.name }));
    for (const t of own.filter((t) => widgetRows.some((w) => w.triggerId === t.id))) reasons.push(say("plugins.reason.dashboardTrigger", { name: t.name }));
    const [job] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.agentId, a.id), inArray(runs.status, ["running", "waiting"]))).limit(1);
    if (job) reasons.push(say("plugins.reason.job"));
    const [memory] = await db.select({ n: count() }).from(memories).where(eq(memories.agentId, a.id));
    if (memory!.n) reasons.push(say("plugins.reason.memory"));
    const consulting = otherIds.length ? await db.select({ agentId: agentConsults.agentId }).from(agentConsults).where(and(eq(agentConsults.consultedId, a.id), inArray(agentConsults.agentId, otherIds))) : [];
    for (const c of usersAfter(consulting, "consults", (v) => listed(v, a.id))) reasons.push(say("plugins.reason.consulted", { agent: nameOf.get(c.agentId)! }));
    if (await agentInUse(db, ownerId, a.id)) {
      keepOnly = say("plugins.reason.workflowAgent");
      reasons.push(keepOnly);
    }
    const skillsUsed = await db.select({ id: agentSkills.packageId }).from(agentSkills).where(eq(agentSkills.agentId, a.id));
    const toolsUsed = await db.select({ id: agentTools.toolId }).from(agentTools).where(eq(agentTools.agentId, a.id));
    const consulted = await db.select({ id: agentConsults.consultedId }).from(agentConsults).where(eq(agentConsults.agentId, a.id));
    const needs = [
      ...skillsUsed.filter((s) => ids.skill.has(s.id)).map((s) => key("skill", s.id)),
      ...[...toolsUsed.map((t) => t.id), ...own.flatMap((t) => pollTool(t) ?? [])].filter((id) => ids.tool.has(id)).map((id) => key("tool", id)),
      ...[...(a.dataTables === "all" ? [] : a.dataTables), ...own.flatMap((t) => watched(t) ?? [])].filter((id) => ids.table.has(id)).map((id) => key("table", id)),
      ...consulted.filter((c) => ids.agent.has(c.id)).map((c) => key("agent", c.id)),
    ];
    elements.push({ key: key("agent", a.id), kind: "agent", id: a.id, name: a.name, reasons, needs: [...new Set(needs)], keepOnly });
  }

  for (const s of skillRows) {
    const reasons: Message[] = [];
    if (await filesOverridden(db as Db, s.id)) reasons.push(say("plugins.reason.changedFiles"));
    const users = otherIds.length ? await db.select({ agentId: agentSkills.agentId }).from(agentSkills).where(and(eq(agentSkills.packageId, s.id), inArray(agentSkills.agentId, otherIds))) : [];
    for (const u of usersAfter(users, "skillPackageIds", (v) => listed(v, s.id))) reasons.push(say("plugins.reason.agentUses", { agent: nameOf.get(u.agentId)! }));
    elements.push({ key: key("skill", s.id), kind: "skill", id: s.id, name: s.name, reasons, needs: s.requiredToolIds.filter((id) => ids.tool.has(id)).map((id) => key("tool", id)), keepOnly: null });
  }

  const otherSkills = (await db.select({ id: skillPackages.id, name: skillPackages.name, requiredToolIds: skillPackages.requiredToolIds }).from(skillPackages).where(eq(skillPackages.ownerId, ownerId))).filter((p) => !ids.skill.has(p.id));
  for (const t of toolRows) {
    const reasons: Message[] = [];
    let keepOnly: Message | null = null;
    if (t.overridden.length) reasons.push(say("plugins.reason.changed"));
    const users = otherIds.length ? await db.select({ agentId: agentTools.agentId }).from(agentTools).where(and(eq(agentTools.toolId, t.id), inArray(agentTools.agentId, otherIds))) : [];
    for (const u of usersAfter(users, "toolIds", (v) => listed(v, t.id))) reasons.push(say("plugins.reason.agentUses", { agent: nameOf.get(u.agentId)! }));
    for (const s of otherSkills.filter((s) => s.requiredToolIds.includes(t.id))) reasons.push(say("plugins.reason.skillRequires", { skill: s.name }));
    for (const tr of staying.filter((tr) => pollTool(tr) === t.id)) reasons.push(say("plugins.reason.triggerPolls", { trigger: tr.name }));
    // A Tool step of a workflow's current version, or of the version a run still going is on (as `toolHolder` reads it).
    const [workflow] = await db
      .execute(
        sql`select 1 from workflow_versions v join workflows w on w.id = v.workflow_id
            where w.owner_id = ${ownerId} and v.def -> 'steps' @> ${JSON.stringify([{ type: "tool", toolId: t.id }])}::jsonb
              and (v.version = w.current_version or exists (select 1 from runs r where r.workflow_id = w.id and r.version = v.version and r.status in ('running', 'waiting')))
            limit 1`,
      )
      .then((r) => (r as unknown as { rows: unknown[] }).rows);
    if (workflow) {
      keepOnly = say("plugins.reason.workflowTool");
      reasons.push(keepOnly);
    }
    elements.push({ key: key("tool", t.id), kind: "tool", id: t.id, name: t.name, reasons, needs: [], keepOnly });
  }

  const tableIds = [...ids.table];
  const referring = tableIds.length
    ? await db.select({ to: fields.referencesTableId, from: fields.tableId, field: fields.name, table: tables.name }).from(fields).innerJoin(tables, eq(tables.id, fields.tableId)).where(inArray(fields.referencesTableId, tableIds))
    : [];
  for (const t of tableRows) {
    const reasons: Message[] = [];
    let keepOnly: Message | null = null;
    const [n] = await db.select({ n: count() }).from(rows).where(eq(rows.tableId, t.id));
    if (n!.n) reasons.push(say("plugins.reason.rows", { count: n!.n }));
    const [memory] = await db.select({ n: count() }).from(memories).where(eq(memories.tableId, t.id));
    if (memory!.n) reasons.push(say("plugins.reason.memory"));
    if (t.pluginComponent !== null && t.name !== t.pluginComponent) reasons.push(say("plugins.reason.renamed"));
    const own = await db.select({ name: fields.name, type: fields.type, choices: fields.choices, pluginField: fields.pluginField, position: fields.position }).from(fields).where(eq(fields.tableId, t.id));
    // Its structure against the definition it was made from: a field of the owner's, one of the plugin's gone or changed.
    const defined = t.definition?.fields.filter((f) => f.name.toLowerCase() !== "name") ?? [];
    const labels = (choices: readonly (string | { label: string })[] | undefined) => (choices ?? []).map((c) => (typeof c === "string" ? c : c.label)).join("\n");
    const sameChoices = (a: Parameters<typeof labels>[0], b: Parameters<typeof labels>[0]) => labels(a) === labels(b);
    const changed =
      own.some((f) => (f.position === 0 ? f.name !== "Name" : !defined.some((d) => d.name === f.pluginField && d.name === f.name && d.type === f.type && sameChoices(f.choices, d.choices)))) ||
      own.filter((f) => f.pluginField !== null).length !== defined.length ||
      (t.definition !== null && t.definition.primitive !== t.primitive);
    if (changed) reasons.push(say("plugins.reason.changedFields"));
    // As for any table: one whose rows a field of a table that stays names can't go before that field.
    for (const r of referring.filter((r) => r.to === t.id && !ids.table.has(r.from))) {
      reasons.push(say("plugins.reason.fieldNames", { field: r.field, table: r.table }));
      keepOnly = say("plugins.reason.fieldNamesFirst", { field: r.field, table: r.table });
    }
    const tablesOf = (a: (typeof others)[number]) => (after.get(a.id)?.dataTables ?? a.dataTables) as unknown;
    for (const a of others.filter((a) => listed(tablesOf(a), t.id))) reasons.push(say("plugins.reason.agentWorks", { agent: a.name }));
    for (const tr of staying.filter((tr) => watched(tr) === t.id)) reasons.push(say("plugins.reason.triggerWatches", { trigger: tr.name }));
    if (widgetRows.some((w) => w.tableId === t.id)) reasons.push(say("plugins.reason.dashboardShows"));
    if (await tableInUse(db, ownerId, t.id)) {
      keepOnly = say("plugins.reason.workflowTable");
      reasons.push(keepOnly);
    }
    const needs = referring.filter((r) => r.from === t.id && r.to !== t.id && r.to !== null && ids.table.has(r.to)).map((r) => key("table", r.to!));
    elements.push({ key: key("table", t.id), kind: "table", id: t.id, name: t.name, reasons, needs: [...new Set(needs)], keepOnly });
  }
  // A trigger the update drops while its agent stays: asked about under the same three rules.
  for (const t of triggerRows) {
    const reasons: Message[] = [];
    if (t.overridden.length) reasons.push(say("plugins.reason.changed"));
    const [job] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.triggerId, t.id), inArray(runs.status, ["running", "waiting"]))).limit(1);
    if (job) reasons.push(say("plugins.reason.triggerJob"));
    const [held] = await db.select({ n: count() }).from(eventFires).where(and(eq(eventFires.triggerId, t.id), eq(eventFires.status, "deferred")));
    const [items] = await db.select({ n: count() }).from(pollItems).where(and(eq(pollItems.triggerId, t.id), eq(pollItems.status, "deferred")));
    if (held!.n + items!.n) reasons.push(say("plugins.reason.held", { count: held!.n + items!.n }));
    if (widgetRows.some((w) => w.triggerId === t.id)) reasons.push(say("plugins.reason.dashboardStarts"));
    const needs = [pollTool(t), watched(t)].flatMap((id) => (id && ids.tool.has(id) ? [key("tool", id)] : id && ids.table.has(id) ? [key("table", id)] : []));
    elements.push({ key: key("trigger", t.id), kind: "trigger", id: t.id, name: t.name, reasons, needs, keepOnly: null });
  }
  return elements;
}

/**
 * Refuses a set of choices that can't be applied: every element asked about has a choice, one
 * that can only be kept isn't deleted, and what a kept element needs has a stated choice too, so
 * nothing a kept element uses is removed without its owner having said so.
 */
export function checkChoices(elements: Element[], choices: Record<string, "keep" | "delete">): void {
  const refuse = (key: MessageKey, values?: MessageValues): never => {
    throw new ORPCError("BAD_REQUEST", message(key, values));
  };
  const byKey = new Map(elements.map((e) => [e.key, e]));
  if (Object.keys(choices).some((k) => !byKey.has(k))) refuse("plugins.uninstall.notElement");
  for (const e of elements) {
    if (e.reasons.length && choices[e.key] === undefined) refuse("plugins.uninstall.needChoice", { name: e.name });
    if (e.keepOnly && choices[e.key] !== "keep") refuse(e.keepOnly.key, e.keepOnly.values);
  }
  for (const e of elements.filter((e) => choices[e.key] === "keep")) {
    const missing = e.needs.find((n) => choices[n] === undefined);
    if (missing) refuse("plugins.uninstall.needNeeded", { needed: byKey.get(missing)!.name, name: e.name });
    // A table whose field names another table's rows can't outlive it.
    const gone = e.kind === "table" ? e.needs.find((n) => choices[n] === "delete") : undefined;
    if (gone) refuse("plugins.uninstall.keepBoth", { name: e.name, other: byKey.get(gone)!.name });
  }
}
