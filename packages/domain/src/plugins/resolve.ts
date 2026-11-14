import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents as agentsTable, pluginConflicts, tools as toolsTable, triggers as triggersTable } from "../db/schema.ts";
import type { AuditActor } from "../audit/model.ts";
import { recordAudit } from "../audit/record.ts";
import type { InitialContext } from "../rpc/context.ts";
import type { Tx } from "../skills/procedures.ts";
import { type ElementKind, sameValue } from "./overrides.ts";
import { agentValues } from "./update.ts";
import { writeFields } from "./write-field.ts";

// "Let Stem deal with it": an update's conflicts the owner handed to Stem, one field each, and
// how Stem's decisions apply. A decision applies only while the field is still the owner's value
// it was handed off with and the plugin's value still the one it was handed off against: else
// the conflict is the owner's again (`open`). Within what the owner already had or the update
// showed, it applies at once; anything else waits for the owner's Approval.

type Context = InitialContext & { ownerId: string };
export type Decision = { kind: "reset" } | { kind: "merge"; value: unknown };
/** How a decision ended: made, waiting for the owner's Approval, the owner's again, or about nothing any more. */
export type DecisionOutcome = "applied" | "approval" | "reopened" | "gone";
type Conflict = typeof pluginConflicts.$inferSelect;

/** The field's value in effect and the plugin's, on the conflict's element; null when the element is gone or no longer the plugin's. */
async function fieldNow(db: Db | Tx, c: Conflict): Promise<{ value: unknown; plugin: unknown } | null> {
  if (c.kind === "agent") {
    const [agent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, c.elementId), eq(agentsTable.ownerId, c.ownerId), eq(agentsTable.pluginId, c.pluginId)));
    if (!agent?.upstream) return null;
    return { value: (await agentValues(db, agent))[c.field as keyof Awaited<ReturnType<typeof agentValues>>], plugin: agent.upstream[c.field] };
  }
  const table = c.kind === "tool" ? toolsTable : triggersTable;
  const [row] = await db.select().from(table).where(and(eq(table.id, c.elementId), eq(table.ownerId, c.ownerId), eq(table.pluginId, c.pluginId)));
  if (!row?.upstream) return null;
  return { value: (row as Record<string, unknown>)[c.field], plugin: row.upstream[c.field] };
}

/** Whether a merged value stays within the two the owner had and was shown: one of them, or a list of their entries. */
function within(kind: ElementKind, field: string, value: unknown, mine: unknown, next: unknown): boolean {
  if (sameValue(kind, field, value, mine) || sameValue(kind, field, value, next)) return true;
  if (!Array.isArray(value) || !Array.isArray(mine) || !Array.isArray(next)) return false;
  return value.every((v) => [...mine, ...next].some((e) => sameValue(kind, field, [v], [e])));
}

async function audit(context: Context, actor: AuditActor, c: Conflict, decision: string, jobId: string | null) {
  // Ids, the field's name and the decision's kind: never a value.
  await recordAudit(context.db, { ownerId: context.ownerId, actor, jobId, action: "plugin.decided", resource: { type: "plugin", id: c.pluginId }, details: { elementKind: c.kind, elementId: c.elementId, field: c.field, decision } });
}

/** Whether the conflict still stands as it was handed off: the field is the owner's value, the plugin's value the one shown. */
async function fresh(db: Db | Tx, c: Conflict): Promise<{ plugin: unknown } | "gone" | "stale"> {
  const now = await fieldNow(db, c);
  if (!now) return "gone";
  const kind = c.kind;
  return sameValue(kind, c.field, now.value, c.mine) && sameValue(kind, c.field, now.plugin, c.next) ? { plugin: now.plugin } : "stale";
}

/** Writes the decided value; a tool the agent gains by it starts with every action on Ask, as a tool an update gives does. */
async function apply(context: Context, c: Conflict, value: unknown) {
  let extra = {};
  if (c.kind === "agent" && c.field === "toolIds" && Array.isArray(value)) {
    const [agent] = await context.db.select().from(agentsTable).where(eq(agentsTable.id, c.elementId));
    const had = agent ? (await agentValues(context.db, agent)).toolIds : [];
    const gained = (value as string[]).filter((id) => !had.includes(id));
    if (gained.length) extra = { toolPermissions: gained.map((toolId) => ({ toolId, unasked: [] })) };
  }
  await writeFields(context, c.kind, c.elementId, { [c.field]: value, ...extra });
}

/**
 * Applies Stem's decision on one conflict it holds: a reset takes the plugin's value; a merge
 * within the two values applies; any other merge waits for the owner's Approval (`merged`). A
 * conflict that changed since it was handed off applies nothing and is the owner's again.
 */
export async function decide(context: Context, actor: AuditActor, conflictId: string, decision: Decision): Promise<DecisionOutcome> {
  const [c] = await context.db.select().from(pluginConflicts).where(and(eq(pluginConflicts.id, conflictId), eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.status, "stem")));
  if (!c) return "gone";
  const state = await fresh(context.db, c);
  if (state === "gone") {
    await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
    return "gone";
  }
  if (state === "stale") {
    await context.db.update(pluginConflicts).set({ status: "open", merged: null }).where(eq(pluginConflicts.id, c.id));
    await audit(context, actor, c, "reopened", c.runId);
    return "reopened";
  }
  const value = decision.kind === "reset" ? state.plugin : decision.value;
  if (decision.kind === "merge" && !within(c.kind, c.field, value, c.mine, c.next)) {
    await context.db.update(pluginConflicts).set({ status: "approval", merged: value }).where(eq(pluginConflicts.id, c.id));
    await audit(context, actor, c, "approval", c.runId);
    return "approval";
  }
  // shortcut: the check above and this write aren't one transaction (the element's update runs its own, with a session lookup that can't nest), so an owner's save landing in the milliseconds between them is overwritten; make each element update take an expected value, checked under its row lock, if that ever shows up.
  await apply(context, c, value);
  await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
  await audit(context, actor, c, decision.kind, c.runId);
  return "applied";
}

/**
 * The owner's answer to the Approval of a Stem Job's merged values: each still standing applies
 * on a yes; on a no each stays as the owner has it ("Keep mine"). One that changed meanwhile is
 * the owner's again either way.
 */
export async function answerApproval(context: Context, actor: AuditActor, runId: string, approved: boolean): Promise<{ applied: number; reopened: number }> {
  const waiting = await context.db.select().from(pluginConflicts).where(and(eq(pluginConflicts.runId, runId), eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.status, "approval")));
  let applied = 0;
  let reopened = 0;
  for (const c of waiting) {
    const state = await fresh(context.db, c);
    if (state === "stale") {
      await context.db.update(pluginConflicts).set({ status: "open", merged: null }).where(eq(pluginConflicts.id, c.id));
      await audit(context, actor, c, "reopened", runId);
      reopened++;
      continue;
    }
    if (approved && state !== "gone") {
      await apply(context, c, c.merged);
      applied++;
    }
    await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
    if (state !== "gone") await audit(context, actor, c, approved ? "approved" : "declined", runId);
  }
  return { applied, reopened };
}

/** An update that changes the plugin's value of these fields: their pending conflicts are the owner's again. */
export async function reopenChanged(tx: Db | Tx, kind: ElementKind, elementId: string, fields: string[]): Promise<void> {
  if (!fields.length) return;
  await tx
    .update(pluginConflicts)
    .set({ status: "open", merged: null })
    .where(and(eq(pluginConflicts.kind, kind), eq(pluginConflicts.elementId, elementId), inArray(pluginConflicts.field, fields), inArray(pluginConflicts.status, ["stem", "approval"])));
}

/** Elements that leave the plugin, kept as the owner's own or gone, have no plugin conflict left. */
export async function forgetConflicts(tx: Db | Tx, elementIds: string[]): Promise<void> {
  if (elementIds.length) await tx.delete(pluginConflicts).where(inArray(pluginConflicts.elementId, elementIds));
}
