import { and, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db, Tx } from "../db/client.ts";
import {
  agentConsults,
  agents,
  agentSkills,
  agentTools,
  fields,
  memories,
  rows,
  runs,
  skillPackages,
  tables,
  tools,
  triggers,
  widgets,
} from "../db/schema.ts";
import { tableInUse } from "../data/tables.ts";
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

export type ElementKind = "agent" | "skill" | "tool" | "table";

/** One of a plugin's elements, as an uninstall sees it. */
export type Element = {
  /** `<kind>:<id>`: what a choice names. */
  key: string;
  kind: ElementKind;
  id: string;
  name: string;
  /** Why it is asked about; empty, it goes with the plugin unless something kept needs it. */
  reasons: string[];
  /** The plugin's other elements it uses: kept, it needs a stated choice for each. */
  needs: string[];
  /** Why it can only be kept (a workflow uses it), or null. */
  keepOnly: string | null;
};

const key = (kind: ElementKind, id: string) => `${kind}:${id}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A plugin's elements, each with why an uninstall asks about it and what it needs. */
export async function inUse(db: Db | Tx, ownerId: string, pluginId: string): Promise<Element[]> {
  const mine = (t: { pluginId: AnyPgColumn; ownerId: AnyPgColumn }) => and(eq(t.pluginId, pluginId), eq(t.ownerId, ownerId));
  const [agentRows, skillRows, toolRows, tableRows] = await Promise.all([
    db.select().from(agents).where(mine(agents)),
    db.select().from(skillPackages).where(mine(skillPackages)),
    db.select().from(tools).where(mine(tools)),
    db.select().from(tables).where(mine(tables)),
  ]);
  const ids = { agent: new Set(agentRows.map((r) => r.id)), skill: new Set(skillRows.map((r) => r.id)), tool: new Set(toolRows.map((r) => r.id)), table: new Set(tableRows.map((r) => r.id)) };
  const elements: Element[] = [];

  // What stays whatever is chosen: the owner's own agents and triggers, and the other plugins'.
  const others = await db.select({ id: agents.id, name: agents.name, dataTables: agents.dataTables }).from(agents).where(and(eq(agents.ownerId, ownerId), or(isNull(agents.pluginId), ne(agents.pluginId, pluginId))));
  const otherIds = others.map((a) => a.id);
  const nameOf = new Map(others.map((a) => [a.id, a.name]));
  const allTriggers = await db.select().from(triggers).where(eq(triggers.ownerId, ownerId));
  const widgetRows = await db.select({ triggerId: widgets.triggerId, tableId: widgets.tableId }).from(widgets).where(eq(widgets.ownerId, ownerId));
  const pollTool = (t: (typeof allTriggers)[number]) => (t.config.kind === "poll" ? t.config.toolId : null);
  const watched = (t: (typeof allTriggers)[number]) => (t.config.kind === "primitive" ? t.config.tableId : null);
  /** A trigger that stays: on an agent that isn't the plugin's. */
  const staying = allTriggers.filter((t) => !ids.agent.has(t.agentId));

  for (const a of agentRows) {
    const reasons: string[] = [];
    let keepOnly: string | null = null;
    if (a.overridden.length) reasons.push("You changed it");
    const own = allTriggers.filter((t) => t.agentId === a.id);
    for (const t of own.filter((t) => t.pluginId === pluginId && t.overridden.length)) reasons.push(`You changed its trigger “${t.name}”`);
    for (const t of own.filter((t) => t.pluginId !== pluginId)) reasons.push(`It has a trigger of yours, “${t.name}”`);
    for (const t of own.filter((t) => widgetRows.some((w) => w.triggerId === t.id))) reasons.push(`A dashboard starts its trigger “${t.name}”`);
    const [job] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.agentId, a.id), inArray(runs.status, ["running", "waiting"]))).limit(1);
    if (job) reasons.push("It has a Job running or waiting");
    const [memory] = await db.select({ n: count() }).from(memories).where(eq(memories.agentId, a.id));
    if (memory!.n) reasons.push("It has memory entries");
    const consulting = otherIds.length ? await db.select({ agentId: agentConsults.agentId }).from(agentConsults).where(and(eq(agentConsults.consultedId, a.id), inArray(agentConsults.agentId, otherIds))) : [];
    for (const c of consulting) reasons.push(`The agent “${nameOf.get(c.agentId)}” may consult it`);
    if (await agentInUse(db, ownerId, a.id)) {
      keepOnly = "A workflow uses this agent";
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
    const reasons: string[] = [];
    if (await filesOverridden(db as Db, s.id)) reasons.push("You changed its files");
    const users = otherIds.length ? await db.select({ agentId: agentSkills.agentId }).from(agentSkills).where(and(eq(agentSkills.packageId, s.id), inArray(agentSkills.agentId, otherIds))) : [];
    for (const u of users) reasons.push(`The agent “${nameOf.get(u.agentId)}” uses it`);
    elements.push({ key: key("skill", s.id), kind: "skill", id: s.id, name: s.name, reasons, needs: s.requiredToolIds.filter((id) => ids.tool.has(id)).map((id) => key("tool", id)), keepOnly: null });
  }

  const otherSkills = await db.select({ id: skillPackages.id, name: skillPackages.name, requiredToolIds: skillPackages.requiredToolIds }).from(skillPackages).where(and(eq(skillPackages.ownerId, ownerId), or(isNull(skillPackages.pluginId), ne(skillPackages.pluginId, pluginId))));
  for (const t of toolRows) {
    const reasons: string[] = [];
    let keepOnly: string | null = null;
    if (t.overridden.length) reasons.push("You changed it");
    const users = otherIds.length ? await db.select({ agentId: agentTools.agentId }).from(agentTools).where(and(eq(agentTools.toolId, t.id), inArray(agentTools.agentId, otherIds))) : [];
    for (const u of users) reasons.push(`The agent “${nameOf.get(u.agentId)}” uses it`);
    for (const s of otherSkills.filter((s) => s.requiredToolIds.includes(t.id))) reasons.push(`The skill “${s.name}” requires it`);
    for (const tr of staying.filter((tr) => pollTool(tr) === t.id)) reasons.push(`The trigger “${tr.name}” polls it`);
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
      keepOnly = "A workflow uses this tool";
      reasons.push(keepOnly);
    }
    elements.push({ key: key("tool", t.id), kind: "tool", id: t.id, name: t.name, reasons, needs: [], keepOnly });
  }

  const tableIds = [...ids.table];
  const referring = tableIds.length
    ? await db.select({ to: fields.referencesTableId, from: fields.tableId, field: fields.name, table: tables.name }).from(fields).innerJoin(tables, eq(tables.id, fields.tableId)).where(inArray(fields.referencesTableId, tableIds))
    : [];
  for (const t of tableRows) {
    const reasons: string[] = [];
    let keepOnly: string | null = null;
    const [n] = await db.select({ n: count() }).from(rows).where(eq(rows.tableId, t.id));
    if (n!.n) reasons.push(`It has ${plural(n!.n, "row")}`);
    const [memory] = await db.select({ n: count() }).from(memories).where(eq(memories.tableId, t.id));
    if (memory!.n) reasons.push("It has memory entries");
    if (t.pluginComponent !== null && t.name !== t.pluginComponent) reasons.push("You renamed it");
    const own = await db.select({ name: fields.name, type: fields.type, choices: fields.choices, pluginField: fields.pluginField, position: fields.position }).from(fields).where(eq(fields.tableId, t.id));
    // Its structure against the definition it was made from: a field of the owner's, one of the plugin's gone or changed.
    const defined = t.definition?.fields.filter((f) => f.name.toLowerCase() !== "name") ?? [];
    const labels = (choices: readonly (string | { label: string })[] | undefined) => (choices ?? []).map((c) => (typeof c === "string" ? c : c.label)).join("\n");
    const sameChoices = (a: Parameters<typeof labels>[0], b: Parameters<typeof labels>[0]) => labels(a) === labels(b);
    const changed =
      own.some((f) => (f.position === 0 ? f.name !== "Name" : !defined.some((d) => d.name === f.pluginField && d.name === f.name && d.type === f.type && sameChoices(f.choices, d.choices)))) ||
      own.filter((f) => f.pluginField !== null).length !== defined.length ||
      (t.definition !== null && t.definition.primitive !== t.primitive);
    if (changed) reasons.push("You changed its fields");
    // As for any table: one whose rows a field of a table that stays names can't go before that field.
    for (const r of referring.filter((r) => r.to === t.id && !ids.table.has(r.from))) {
      reasons.push(`The field “${r.field}” of your table “${r.table}” names its rows`);
      keepOnly = `The field “${r.field}” of your table “${r.table}” names its rows: delete that field first to delete this table`;
    }
    for (const a of others.filter((a) => a.dataTables !== "all" && a.dataTables.includes(t.id))) reasons.push(`The agent “${a.name}” works on it`);
    for (const tr of staying.filter((tr) => watched(tr) === t.id)) reasons.push(`The trigger “${tr.name}” watches it`);
    if (widgetRows.some((w) => w.tableId === t.id)) reasons.push("A dashboard shows it");
    if (await tableInUse(db, ownerId, t.id)) {
      keepOnly = "A workflow uses this table";
      reasons.push(keepOnly);
    }
    const needs = referring.filter((r) => r.from === t.id && r.to !== t.id && r.to !== null && ids.table.has(r.to)).map((r) => key("table", r.to!));
    elements.push({ key: key("table", t.id), kind: "table", id: t.id, name: t.name, reasons, needs: [...new Set(needs)], keepOnly });
  }
  return elements;
}

/**
 * Why a set of choices can't be applied, or null: every element asked about has a choice, one
 * that can only be kept isn't deleted, and what a kept element needs has a stated choice too, so
 * nothing a kept element uses is removed without its owner having said so.
 */
export function checkChoices(elements: Element[], choices: Record<string, "keep" | "delete">): string | null {
  const byKey = new Map(elements.map((e) => [e.key, e]));
  if (Object.keys(choices).some((k) => !byKey.has(k))) return "Not an element of this plugin";
  for (const e of elements) {
    if (e.reasons.length && choices[e.key] === undefined) return `Choose what becomes of ${e.name}`;
    if (e.keepOnly && choices[e.key] !== "keep") return e.keepOnly;
  }
  for (const e of elements.filter((e) => choices[e.key] === "keep")) {
    const missing = e.needs.find((n) => choices[n] === undefined);
    if (missing) return `Choose what becomes of ${byKey.get(missing)!.name}, which ${e.name} needs`;
    // A table whose field names another table's rows can't outlive it.
    const gone = e.kind === "table" ? e.needs.find((n) => choices[n] === "delete") : undefined;
    if (gone) return `${e.name} names the rows of ${byKey.get(gone)!.name}: keep both, or delete both`;
  }
  return null;
}
