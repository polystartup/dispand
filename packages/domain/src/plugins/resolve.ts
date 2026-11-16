import { ORPCError } from "@orpc/server";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents as agentsTable, pluginConflicts, plugins as pluginsTable, questions, tools as toolsTable, triggers as triggersTable } from "../db/schema.ts";
import type { AuditActor } from "../audit/model.ts";
import { recordAudit } from "../audit/record.ts";
import { recordInteraction } from "../engine/interactions.ts";
import { newId } from "../ids.ts";
import { canonical } from "../platform/approvals.ts";
import type { InitialContext } from "../rpc/context.ts";
import { meter } from "../telemetry/index.ts";
import { type ElementKind, sameValue } from "./overrides.ts";
import { agentValues } from "./update.ts";
import { writeFields } from "./write-field.ts";

// "Let Stem deal with it": an update's conflicts the owner handed to Stem, one field each, and
// how Stem's decisions apply. A decision applies only while the field is still the owner's value
// it was handed off with and the plugin's value still the one it was handed off against: else
// the conflict is the owner's again (`open`). Within what the owner already had or the update
// showed, it applies at once; anything else waits for the owner's Approval: one Approval in the
// Inbox per Stem Job (so per update), made when the Job ends, whose items are the conflicts of
// that Job waiting in `approval`, each answered on its own (`answerConflict`). Any conflict kept
// in `plugin_conflicts` with the Job's `runId` is an item of it.

const counts = meter("plugins");

/** What marks a plugin update's Approval in the Inbox (its payload's `toolName`): no tool goes by this name. */
export const PLUGIN_UPDATE = "plugin_update";

type Context = InitialContext & { ownerId: string };
export type Decision = { kind: "reset" } | { kind: "merge"; value: unknown };
/** How a decision ended: made, waiting for the owner's Approval, the owner's again, or about nothing any more. */
export type DecisionOutcome = "applied" | "approval" | "reopened" | "gone";
type Conflict = typeof pluginConflicts.$inferSelect;

/** The field's value in effect and the plugin's, on the conflict's element; null when the element is gone or no longer the plugin's. */
export async function fieldNow(db: Db | Tx, c: Conflict): Promise<{ value: unknown; plugin: unknown } | null> {
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

/**
 * An agent's rights: they combine, so two decisions each within bounds could give the agent
 * together what neither the owner's nor the plugin's version did. A change to one of them always
 * waits for the owner's Approval.
 */
const AGENT_RIGHTS = new Set(["bundles", "dataTables", "toolIds", "skillPackageIds", "selfLearning", "consults"]);

/** Whether a decided value may apply without the owner's Approval: one of the two values, and for an agent's rights the owner's alone. */
function within(kind: ElementKind, field: string, value: unknown, mine: unknown, next: unknown): boolean {
  if (kind === "agent" && AGENT_RIGHTS.has(field)) return sameValue(kind, field, value, mine);
  return sameValue(kind, field, value, mine) || sameValue(kind, field, value, next);
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

/**
 * Writes the decided value; a tool the agent gains by it starts with every action on Ask, as a
 * tool an update gives does. With `mine`, the write holds only while the field still has that
 * value, checked by the element's update under its row lock: false when the owner's change got
 * there first.
 */
async function apply(context: Context, c: Conflict, value: unknown, mine?: unknown): Promise<boolean> {
  let extra = {};
  if (c.kind === "agent" && c.field === "toolIds" && Array.isArray(value)) {
    const [agent] = await context.db.select().from(agentsTable).where(eq(agentsTable.id, c.elementId));
    const had = agent ? (await agentValues(context.db, agent)).toolIds : [];
    const gained = (value as string[]).filter((id) => !had.includes(id));
    if (gained.length) extra = { toolPermissions: gained.map((toolId) => ({ toolId, unasked: [] })) };
  }
  try {
    await writeFields(mine === undefined ? context : { ...context, expectField: { field: c.field, value: mine } }, c.kind, c.elementId, { [c.field]: value, ...extra });
    return true;
  } catch (err) {
    if (mine !== undefined && err instanceof ORPCError && err.code === "CONFLICT") return false;
    throw err;
  }
}

/** A decision whose field changed before it could be written: the conflict is the owner's again. */
async function reopen(context: Context, actor: AuditActor, c: Conflict): Promise<"reopened"> {
  await context.db.update(pluginConflicts).set({ status: "open", merged: null }).where(eq(pluginConflicts.id, c.id));
  await audit(context, actor, c, "reopened", c.runId);
  return "reopened";
}

/**
 * Applies Stem's decision on one conflict it holds: a reset takes the plugin's value; a merge
 * within the two values applies; any other merge waits for the owner's Approval (`merged`). A
 * conflict that changed since it was handed off applies nothing and is the owner's again.
 */
export async function decide(context: Context, actor: AuditActor, conflictId: string, decision: Decision, runId?: string): Promise<DecisionOutcome> {
  const [c] = await context.db
    .select()
    .from(pluginConflicts)
    .where(and(eq(pluginConflicts.id, conflictId), eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.status, "stem"), ...(runId ? [eq(pluginConflicts.runId, runId)] : [])));
  if (!c) return "gone";
  const state = await fresh(context.db, c);
  if (state === "gone") {
    await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
    return "gone";
  }
  // Each write holds only while Stem still has it: a Job stopped meanwhile gave it back (`closeStemJob`), and its Approval was asked without it.
  const held = and(eq(pluginConflicts.id, c.id), eq(pluginConflicts.status, "stem"));
  if (state === "stale") {
    if (!(await context.db.update(pluginConflicts).set({ status: "open", merged: null }).where(held).returning({ id: pluginConflicts.id })).length) return "gone";
    await audit(context, actor, c, "reopened", c.runId);
    return "reopened";
  }
  const value = decision.kind === "reset" ? state.plugin : decision.value;
  if (!within(c.kind, c.field, value, c.mine, c.next)) {
    if (!(await context.db.update(pluginConflicts).set({ status: "approval", merged: value }).where(held).returning({ id: pluginConflicts.id })).length) return "gone";
    await audit(context, actor, c, "approval", c.runId);
    return "approval";
  }
  // The check above read the field; the write holds only if it still has the owner's value, so a save landing in between wins.
  if (!(await apply(context, c, value, c.mine))) return reopen(context, actor, c);
  await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
  await audit(context, actor, c, decision.kind, c.runId);
  return "applied";
}

/**
 * The owner's answer to one item of a plugin update's Approval, a merged value of Stem's: still
 * standing, it applies on a yes; on a no the field stays as they have it ("Keep mine"). One that
 * changed meanwhile is theirs again either way, the other items untouched. The Approval is done
 * once none waits.
 */
export async function answerConflict(context: Context, actor: AuditActor, conflictId: string, approved: boolean): Promise<"applied" | "kept" | "reopened" | "gone"> {
  const [c] = await context.db.select().from(pluginConflicts).where(and(eq(pluginConflicts.id, conflictId), eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.status, "approval")));
  if (!c) return "gone";
  const outcome = await answerOne(context, actor, c, approved);
  await context.db.transaction((tx) => settleApprovals(tx, [c.runId], actor.type === "user" ? actor : undefined));
  // Every Inbox showing it hears that an item left, even while others still wait.
  context.engine.questionChanges.publish("changed", true);
  return outcome;
}

async function answerOne(context: Context, actor: AuditActor, c: Conflict, approved: boolean): Promise<"applied" | "kept" | "reopened" | "gone"> {
  const state = await fresh(context.db, c);
  if (state === "stale") {
    await context.db.update(pluginConflicts).set({ status: "open", merged: null }).where(eq(pluginConflicts.id, c.id));
    await audit(context, actor, c, "reopened", c.runId);
    return "reopened";
  }
  if (approved && state !== "gone" && !(await apply(context, c, c.merged, c.mine))) return reopen(context, actor, c);
  await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
  if (state === "gone") return "gone";
  await audit(context, actor, c, approved ? "approved" : "declined", c.runId);
  return approved ? "applied" : "kept";
}

/** The owner decides a conflict that is theirs again: keep their value, or take the plugin's. */
export async function ownerChoice(context: Context, actor: AuditActor, conflictId: string, choice: "mine" | "plugin"): Promise<void> {
  const [c] = await context.db.select().from(pluginConflicts).where(and(eq(pluginConflicts.id, conflictId), eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.status, "open")));
  if (!c) return;
  const now = await fieldNow(context.db, c);
  if (now && choice === "plugin") await apply(context, c, now.plugin);
  await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
  if (now) await audit(context, actor, c, choice, c.runId);
}

/** An update that changes the plugin's value of these fields: their pending conflicts are the owner's again. */
export async function reopenChanged(tx: Db | Tx, kind: ElementKind, elementId: string, fields: string[]): Promise<void> {
  if (!fields.length) return;
  const reopened = await tx
    .update(pluginConflicts)
    .set({ status: "open", merged: null })
    .where(and(eq(pluginConflicts.kind, kind), eq(pluginConflicts.elementId, elementId), inArray(pluginConflicts.field, fields), inArray(pluginConflicts.status, ["stem", "approval"])))
    .returning({ runId: pluginConflicts.runId });
  await tx.transaction((t) => settleApprovals(t, reopened.map((r) => r.runId)));
}

/** Elements that leave the plugin, kept as the owner's own or gone, have no plugin conflict left. */
export async function forgetConflicts(tx: Db | Tx, elementIds: string[]): Promise<void> {
  if (!elementIds.length) return;
  const gone = await tx.delete(pluginConflicts).where(inArray(pluginConflicts.elementId, elementIds)).returning({ runId: pluginConflicts.runId });
  await tx.transaction((t) => settleApprovals(t, gone.map((r) => r.runId)));
}

/**
 * A Stem Job that ended: what it didn't decide is the owner's again. What waits for the owner's
 * Approval becomes one Approval in the Inbox, for the whole Job, returned so its Inbox hears of
 * it (and a push goes, once). It stays when the Job is over: no session waits on it.
 */
export async function closeStemJob(tx: Tx, runId: string): Promise<typeof questions.$inferSelect | null> {
  await tx.update(pluginConflicts).set({ status: "open" }).where(and(eq(pluginConflicts.runId, runId), eq(pluginConflicts.status, "stem")));
  const [waiting] = await tx.select({ ownerId: pluginConflicts.ownerId, pluginId: pluginConflicts.pluginId }).from(pluginConflicts).where(and(eq(pluginConflicts.runId, runId), eq(pluginConflicts.status, "approval"))).limit(1);
  if (!waiting) return null;
  const [row] = await tx
    .insert(questions)
    .values({ id: newId("q"), ownerId: waiting.ownerId, runId, placement: "notifications", kind: "approval", payload: { kind: "permission", toolName: PLUGIN_UPDATE, input: { pluginId: waiting.pluginId }, canAlwaysAllow: false }, status: "pending" })
    .returning();
  await recordInteraction(tx, row!, "created");
  counts.counter("dispand.questions.opened").add(1, { "dispand.question.kind": "approval" });
  return row!;
}

const isUpdateApproval = sql`${questions.payload} ->> 'toolName' = ${PLUGIN_UPDATE}`;

/**
 * The Inbox Approvals of these Stem Jobs that nothing waits on any more: answered when the owner
 * answered the last item (`by`), expired when the last left otherwise (an update reopened it, its
 * element left the plugin). True when one closed. In a transaction: the Approval's row is locked
 * before its items are counted, so of two that remove its last items at once, the second counts
 * after the first committed and closes it.
 */
export async function settleApprovals(tx: Tx, runIds: (string | null)[], by?: { type: "user"; userId: string }): Promise<boolean> {
  let closed = false;
  for (const runId of new Set(runIds)) {
    if (!runId) continue;
    const [approval] = await tx.select({ id: questions.id }).from(questions).where(and(eq(questions.runId, runId), eq(questions.status, "pending"), isUpdateApproval)).for("update");
    if (!approval) continue;
    const [left] = await tx.select({ id: pluginConflicts.id }).from(pluginConflicts).where(and(eq(pluginConflicts.runId, runId), eq(pluginConflicts.status, "approval"))).limit(1);
    if (left) continue;
    const done = await tx
      .update(questions)
      .set(by ? { status: "answered", answer: { kind: "permission", decision: "allow" }, answeredAt: new Date(), answeredBy: by } : { status: "expired" })
      .where(and(eq(questions.id, approval.id), eq(questions.status, "pending")))
      .returning();
    for (const q of done) await recordInteraction(tx, q, by ? "answered" : "expired", by);
    closed ||= done.length > 0;
  }
  return closed;
}

/** The Inbox Approval a conflict waits in, once its Stem Job ended; null before. */
export async function approvalOf(db: Db | Tx, runId: string | null): Promise<string | null> {
  if (!runId) return null;
  const [q] = await db.select({ id: questions.id }).from(questions).where(and(eq(questions.runId, runId), eq(questions.status, "pending"), isUpdateApproval));
  return q?.id ?? null;
}

/** A conflict as the owner decides it: the field's value now, the plugin's now, Stem's suggestion, and the token of the three. */
export async function conflictView(db: Db | Tx, r: Conflict) {
  const now = await fieldNow(db, r);
  const shown = { id: r.id, field: r.field, status: r.status, mine: now?.value ?? r.mine, next: now?.plugin ?? r.next, merged: r.status === "approval" ? r.merged : null };
  return { ...shown, reviewed: createHash("sha256").update(canonical(shown)).digest("hex") };
}

/**
 * A plugin update's Inbox Approval as its owner reads it: the plugin, and each item still waiting
 * (an element's field, with Stem's value and the owner's), with the token its answer carries.
 */
export async function approvalView(db: Db, ownerId: string, q: { runId: string; payload: unknown }) {
  const pluginId = String((q.payload as { input?: { pluginId?: unknown } }).input?.pluginId ?? "");
  const [plugin] = await db.select({ id: pluginsTable.id, name: pluginsTable.name }).from(pluginsTable).where(and(eq(pluginsTable.id, pluginId), eq(pluginsTable.ownerId, ownerId)));
  const rows = await db
    .select()
    .from(pluginConflicts)
    .where(and(eq(pluginConflicts.runId, q.runId), eq(pluginConflicts.ownerId, ownerId), eq(pluginConflicts.status, "approval")))
    .orderBy(asc(pluginConflicts.createdAt), asc(pluginConflicts.id));
  const items = [];
  for (const r of rows) {
    const table = r.kind === "agent" ? agentsTable : r.kind === "tool" ? toolsTable : triggersTable;
    const [element] = await db.select({ name: table.name }).from(table).where(and(eq(table.id, r.elementId), eq(table.ownerId, ownerId)));
    items.push({ ...(await conflictView(db, r)), kind: r.kind, elementId: r.elementId, name: element?.name ?? null });
  }
  return { plugin: plugin ?? null, items };
}
