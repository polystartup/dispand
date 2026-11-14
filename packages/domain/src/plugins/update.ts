import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db, Tx } from "../db/client.ts";
import { agentConsults, agents, agentSkills, agentTools, fields, skillPackages, skills, tables, tools, triggers } from "../db/schema.ts";
import { INTERACTION, TriggerConfig } from "../triggers/model.ts";
import { hasPlaceholder } from "./components.ts";
import { ELEMENT_FIELDS, type Overrides, sameValue, type Upstream } from "./overrides.ts";
import type { PluginContents } from "./read-plugin.ts";

// What an update of a plugin does to one element, and what of it its owner must see first. A
// field its owner left alone follows the plugin; how that reads depends on its class. A change
// that lets an agent do more, or with less asking, or moves where a tool's calls go, is
// `widening`: listed, and applied only once confirmed. Text that steers an agent is `wording`:
// confirmed too, on one line. Anything else is `silent`.

export type UpdatableKind = "agent" | "tool" | "trigger";
export type ChangeClass = "widening" | "wording" | "silent";

/** Each field's class when it changes; a `widening` field that only narrows is silent (`classify`). A test holds every overridable field to one. */
export const FIELD_CLASS: Record<UpdatableKind, Record<string, ChangeClass>> = {
  agent: { name: "wording", description: "wording", systemPrompt: "wording", bundles: "widening", dataTables: "widening", selfLearning: "widening", skillPackageIds: "widening", toolIds: "widening", consults: "widening" },
  tool: { name: "wording", url: "widening", transport: "widening" },
  trigger: { name: "silent", instructions: "wording", config: "widening", concurrency: "widening", rateCap: "widening" },
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const gains = (before: unknown, after: unknown) => list(after).some((entry) => !list(before).includes(entry));

/** Whether a change of a `widening` field gives more: an entry gained, every table, a consult that stops asking, another address, more Jobs. */
function widens(kind: UpdatableKind, field: string, before: unknown, after: unknown): boolean {
  if (kind === "agent" && field === "dataTables") return after === "all" ? before !== "all" : before !== "all" && gains(before, after);
  if (kind === "agent" && field === "consults") {
    const was = new Map(list(before).map((c) => [(c as { agentId: string }).agentId, (c as { ask: boolean }).ask]));
    return list(after).some((c) => {
      const { agentId, ask } = c as { agentId: string; ask: boolean };
      return !was.has(agentId) || (was.get(agentId) === true && !ask);
    });
  }
  if (kind === "agent") return gains(before, after);
  if (kind === "trigger" && field === "concurrency") return after === "parallel";
  if (kind === "trigger" && field === "rateCap") return Number(after) > Number(before);
  // A tool's address or transport, a trigger's config: any change is somewhere or something else.
  return true;
}

/** How a change of one field reads on the update's screen. */
export function classify(kind: UpdatableKind, field: string, before: unknown, after: unknown): ChangeClass {
  const of = FIELD_CLASS[kind][field] ?? "widening";
  if (of !== "widening") return of;
  if (widens(kind, field, before, after)) return "widening";
  // A skill taken off an agent takes what it told the agent with it.
  return kind === "agent" && field === "skillPackageIds" ? "wording" : "silent";
}

type At = { key: string; kind: UpdatableKind; id: string; name: string; field: string };
export type UpdateChange = At & { class: ChangeClass; before: unknown; after: unknown };
export type UpdateConflict = At & { old: unknown; mine: unknown; next: unknown };

/**
 * One element's part of an update to `next` (the plugin's new values of its fields): `changes`
 * are the fields its owner left alone, `conflicts` the ones they overrode that the plugin
 * changed, `set` what the update writes and `upstream` what is kept underneath from then on. A
 * field in `take` is one in conflict whose plugin value the owner takes: it follows, as theirs no more.
 */
export function planElement(kind: UpdatableKind, element: { id: string; name: string }, overrides: Overrides, current: Record<string, unknown>, next: Upstream, take: string[] = []) {
  const old = overrides.upstream ?? {};
  const changes: UpdateChange[] = [];
  const conflicts: UpdateConflict[] = [];
  const set: Record<string, unknown> = {};
  for (const field of ELEMENT_FIELDS[kind].overridable) {
    if (!(field in next) || sameValue(kind, field, old[field], next[field])) continue;
    const at = { key: `${kind}:${element.id}:${field}`, kind, id: element.id, name: element.name, field };
    if (overrides.overridden.includes(field) && !take.includes(field)) {
      conflicts.push({ ...at, old: old[field], mine: current[field], next: next[field] });
      continue;
    }
    set[field] = next[field];
    // A field taken back from an override is shown as the conflict it was, not as a change of its own.
    if (!overrides.overridden.includes(field)) changes.push({ ...at, class: classify(kind, field, current[field], next[field]), before: current[field], after: next[field] });
  }
  return { changes, conflicts, set, upstream: { ...old, ...next } };
}

type Plan = ReturnType<typeof planElement>;
export type ElementPlan = { kind: UpdatableKind; id: string; name: string; plan: Plan; current: Record<string, unknown> };

const lower = (s: string) => s.toLowerCase();

/**
 * The plan of every agent, tool and trigger of a plugin for an update to `contents`. A
 * definition's names are resolved to ids as a setup resolves them, by what the plugin's elements
 * are called in it; a name that finds nothing is left out, as a setup makes an agent without it.
 * `take`: the keys of the conflicts whose plugin value the owner takes.
 */
export async function elementPlans(db: Db | Tx, ownerId: string, plugin: { id: string; layout: string }, contents: PluginContents, take: string[]): Promise<ElementPlan[]> {
  const mine = (t: { pluginId: AnyPgColumn; ownerId: AnyPgColumn }) => and(eq(t.pluginId, plugin.id), eq(t.ownerId, ownerId));
  const [agentRows, toolRows, tableRows, triggerRows, [pkg]] = await Promise.all([
    db.select().from(agents).where(mine(agents)),
    db.select().from(tools).where(mine(tools)),
    db.select({ id: tables.id, component: tables.pluginComponent }).from(tables).where(mine(tables)),
    db.select().from(triggers).where(mine(triggers)),
    db.select({ id: skillPackages.id }).from(skillPackages).where(mine(skillPackages)),
  ]);
  const taken = (kind: UpdatableKind, id: string) => take.filter((k) => k.startsWith(`${kind}:${id}:`)).map((k) => k.slice(`${kind}:${id}:`.length));
  const plans: ElementPlan[] = [];

  for (const tool of toolRows) {
    const server = contents.mcpServers.find((s) => s.name === tool.pluginComponent);
    // A URL holding the owner's settings stays as they filled it.
    if (server?.type !== "http" || tool.url === null || tool.urlSealed !== null || hasPlaceholder(server.url) || !URL.canParse(server.url)) continue;
    const current = { name: tool.name, url: tool.url, transport: tool.transport };
    plans.push({ kind: "tool", id: tool.id, name: tool.name, current, plan: planElement("tool", tool, tool, current, { url: server.url, transport: server.transport }, taken("tool", tool.id)) });
  }

  // What a definition's names stand for, now.
  const local = await db.select({ id: tables.id, name: tables.name }).from(tables).where(and(eq(tables.ownerId, ownerId), isNull(tables.pluginId)));
  const tableNamed = (name: string) => tableRows.find((t) => t.component !== null && lower(t.component) === lower(name))?.id ?? local.find((t) => lower(t.name) === lower(name))?.id;
  const catalog = await db.select({ id: tools.id, catalogId: tools.catalogId }).from(tools).where(and(eq(tools.ownerId, ownerId), isNotNull(tools.catalogId))).orderBy(asc(tools.createdAt));
  const toolNamed = (name: string) => (name.startsWith("catalog:") ? catalog.find((t) => t.catalogId === name.slice("catalog:".length))?.id : toolRows.find((t) => t.pluginComponent === name)?.id);
  const agentNamed = (name: string) => agentRows.find((a) => a.pluginComponent !== null && lower(a.pluginComponent) === lower(name))?.id;
  const installed = pkg ? (await db.select({ name: skills.name }).from(skills).where(eq(skills.packageId, pkg.id))).map((s) => s.name) : [];
  const found = <T>(values: (T | undefined)[]) => values.filter((v): v is T => v !== undefined);

  for (const agent of agentRows) {
    const [skillIds, toolIds, consults] = await Promise.all([
      db.select({ id: agentSkills.packageId }).from(agentSkills).where(eq(agentSkills.agentId, agent.id)),
      db.select({ id: agentTools.toolId }).from(agentTools).where(eq(agentTools.agentId, agent.id)),
      db.select({ agentId: agentConsults.consultedId, ask: agentConsults.ask }).from(agentConsults).where(eq(agentConsults.agentId, agent.id)),
    ]);
    const current = {
      name: agent.name,
      description: agent.description,
      harnessId: agent.harnessId,
      systemPrompt: agent.systemPrompt,
      ...(agent.model === null ? {} : { model: agent.model }),
      bundles: agent.bundles,
      dataTables: agent.dataTables,
      selfLearning: agent.selfLearning,
      skillPackageIds: skillIds.map((s) => s.id),
      toolIds: toolIds.map((t) => t.id),
      consults,
    };
    const imported = contents.agents.find((a) => a.name === agent.pluginComponent);
    const d = contents.definitions.agents.find((a) => agent.pluginComponent !== null && lower(a.name) === lower(agent.pluginComponent));
    const next: Upstream | null = d
      ? {
          name: d.name,
          description: d.description,
          systemPrompt: d.systemPrompt,
          bundles: d.bundles ?? [],
          selfLearning: d.selfLearning ?? [],
          dataTables: Array.isArray(d.tables) ? found(d.tables.map(tableNamed)) : "all",
          skillPackageIds: pkg && d.skills.some((s) => installed.includes(s)) ? [pkg.id] : [],
          toolIds: found(d.tools.map(toolNamed)),
          consults: d.consults.flatMap((c) => {
            const agentId = agentNamed(c.agent);
            return agentId ? [{ agentId, ask: c.ask }] : [];
          }),
        }
      : imported
        ? { systemPrompt: imported.systemPrompt }
        : null;
    if (next) plans.push({ kind: "agent", id: agent.id, name: agent.name, current, plan: planElement("agent", agent, agent, current, next, taken("agent", agent.id)) });
  }

  for (const trigger of triggerRows) {
    const d = contents.definitions.triggers.find((t) => trigger.pluginComponent !== null && lower(t.name) === lower(trigger.pluginComponent));
    // A definition that names another agent now is another trigger: this one is dropped, not moved.
    if (!d || agentNamed(d.agent) !== trigger.agentId) continue;
    const next: Upstream = { name: d.name, instructions: d.instructions ?? "", concurrency: d.concurrency ?? "parallel", rateCap: d.rateCap ?? 60 };
    let config: unknown = d.config;
    if (d.config.kind === "primitive") {
      const { table, fields: names, ...rest } = d.config;
      const tableId = table === INTERACTION ? INTERACTION : tableNamed(table);
      const rows = tableId && names ? await db.select({ id: fields.id, name: fields.name }).from(fields).where(eq(fields.tableId, tableId)) : [];
      const ids = found((names ?? []).map((n) => rows.find((r) => lower(r.name) === lower(n))?.id));
      config = tableId && ids.length === (names ?? []).length ? { ...rest, tableId, ...(names ? { fields: ids } : {}) } : undefined;
    } else if (d.config.kind === "poll") {
      const { server, catalog: entry, ...rest } = d.config;
      const toolId = toolNamed(server ?? `catalog:${entry}`);
      config = toolId ? { ...rest, toolId } : undefined;
    }
    // As `triggers.create` stored it: with its defaults. What can't be resolved now leaves the config as it is.
    const parsed = config === undefined ? undefined : TriggerConfig.safeParse(config);
    if (parsed?.success) next.config = parsed.data;
    const current = { name: trigger.name, instructions: trigger.instructions, concurrency: trigger.concurrency, rateCap: trigger.rateCap, config: trigger.config };
    plans.push({ kind: "trigger", id: trigger.id, name: trigger.name, current, plan: planElement("trigger", trigger, trigger, current, next, taken("trigger", trigger.id)) });
  }
  return plans;
}
