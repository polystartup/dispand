import { ORPCError } from "@orpc/server";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents as agentsTable, pluginConflicts, plugins as pluginsTable, questions, rows as rowsTable, tables as tablesTable, tools as toolsTable, triggers as triggersTable } from "../db/schema.ts";
import type { AuditActor } from "../audit/model.ts";
import { recordAudit } from "../audit/record.ts";
import { recordInteraction } from "../engine/interactions.ts";
import { message } from "../messages/index.ts";
import { newId } from "../ids.ts";
import { canonical } from "../platform/approvals.ts";
import type { InitialContext } from "../rpc/context.ts";
import { meter } from "../telemetry/index.ts";
import { type ElementKind, sameValue } from "./overrides.ts";
import type { PrimitiveDefinition } from "./definitions.ts";
import { applyTable, tablePlan, tablesOf } from "./table-apply.ts";
import type { TableChange } from "./table-merge.ts";
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
//
// A table is handed off whole (`kind: "table"`, field `changes`): Stem decides which of the
// changes the update showed apply. A change that removes values waits for the Approval with the
// values it would remove; one the table no longer allows by then is skipped. A table conflict is
// never the owner's to decide on its own: when Stem doesn't decide it, it is dropped, and the
// definition the table keeps as merged still lacks its changes, so the next update offers them
// again as the checklist.

const counts = meter("plugins");

/** What marks a plugin update's Approval in the Inbox (its payload's `toolName`): no tool goes by this name. */
export const PLUGIN_UPDATE = "plugin_update";

type Context = InitialContext & { ownerId: string };
export type Decision = { kind: "reset" } | { kind: "merge"; value: unknown };
/** How a decision ended: made, waiting for the owner's Approval, the owner's again, about nothing any more, or refused (a table change key the update didn't show). */
export type DecisionOutcome = "applied" | "approval" | "reopened" | "gone" | "refused";
type Conflict = typeof pluginConflicts.$inferSelect;

/** The field's value in effect and the plugin's, on the conflict's element; null when the element is gone or no longer the plugin's. */
export async function fieldNow(db: Db | Tx, c: Conflict): Promise<{ value: unknown; plugin: unknown } | null> {
  // A table's conflict is read as it was handed off (`tableNow` reads the table).
  if (c.kind === "table") return null;
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
  const kind = c.kind as ElementKind;
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
    await writeFields(mine === undefined ? context : { ...context, expectField: { field: c.field, value: mine } }, c.kind as ElementKind, c.elementId, { [c.field]: value, ...extra });
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
  if (c.kind === "table") return decideTable(context, actor, c, decision);
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
  if (!within(c.kind as ElementKind, c.field, value, c.mine, c.next)) {
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
  if (c.kind === "table") return answerTable(context, actor, c, approved);
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
  // A table Stem didn't decide is dropped: its changes stay out of the table's definition, offered by the next update.
  await tx.delete(pluginConflicts).where(and(eq(pluginConflicts.runId, runId), eq(pluginConflicts.status, "stem"), eq(pluginConflicts.kind, "table")));
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
    const table = r.kind === "agent" ? agentsTable : r.kind === "tool" ? toolsTable : r.kind === "table" ? tablesTable : triggersTable;
    const [element] = await db.select({ name: table.name }).from(table).where(and(eq(table.id, r.elementId), eq(table.ownerId, ownerId)));
    items.push({ ...(await conflictView(db, r)), kind: r.kind, elementId: r.elementId, name: element?.name ?? null });
  }
  return { plugin: plugin ?? null, items };
}

/** The field a table's conflict is kept under: one per table. */
export const TABLE_FIELD = "changes";

/** What a table's conflict keeps of the update's screen: the plugin's definition and the changes shown against the table then. */
export type HandedTable = { definition: PrimitiveDefinition; changes: TableChange[] };
/** What waits in the Approval: the changes that remove values, and the values each would remove (each row's id with its value), as read when Stem decided. */
type HeldTable = { keys: string[]; values: Record<string, [string, unknown][]> };

/** A change that takes values away: a field removed, retyped, or losing choices. Never applied without the owner's Approval. */
const removesValues = (c: TableChange) => c.kind === "remove" || c.kind === "retype" || (c.kind === "choices" && !c.ticked);

/**
 * The table's changes as they stand now, from the definition it keeps as merged to the plugin's
 * one it was handed off against; null when the table is gone, no longer the plugin's, or an
 * update merged it again since (another definition on either side).
 */
async function tableNow(db: Db | Tx, c: Conflict) {
  const [t] = await db.select().from(tablesTable).where(and(eq(tablesTable.id, c.elementId), eq(tablesTable.ownerId, c.ownerId), eq(tablesTable.pluginId, c.pluginId)));
  const handed = c.next as HandedTable;
  if (!t?.definition || canonical(t.definition) !== canonical(c.old)) return null;
  const [plugin] = await db.select({ definitions: pluginsTable.definitions }).from(pluginsTable).where(eq(pluginsTable.id, c.pluginId));
  const next = plugin?.definitions?.primitives.find((d) => d.name.toLowerCase() === (t.pluginComponent ?? "").toLowerCase());
  if (!next || canonical(next) !== canonical(handed.definition)) return null;
  const { tableExists } = await tablesOf(db, c.ownerId, { id: c.pluginId });
  return tablePlan(db, c.ownerId, t, () => t.definition!, next, tableExists);
}

/** The definition the table keeps as merged from now on, written only while it is still the one the conflict was planned from: an update that merged the table since wins. */
async function keepDefinition(db: Db | Tx, c: Conflict, definition: PrimitiveDefinition) {
  await db.update(tablesTable).set({ definition }).where(and(eq(tablesTable.id, c.elementId), sql`${tablesTable.definition} = ${JSON.stringify(c.old)}::jsonb`));
}

/** Each row's value of the table's field, by row id; empty cells left out. */
async function valuesOf(db: Db | Tx, tableId: string, fieldId: string | undefined): Promise<[string, unknown][]> {
  if (!fieldId) return [];
  const rows = await db.select({ id: rowsTable.id, values: rowsTable.values }).from(rowsTable).where(eq(rowsTable.tableId, tableId)).orderBy(asc(rowsTable.id));
  return rows.flatMap((r) => (r.values[fieldId] === undefined || r.values[fieldId] === null ? [] : [[r.id, r.values[fieldId]] as [string, unknown]]));
}

const fieldIdOf = (plan: NonNullable<Awaited<ReturnType<typeof tableNow>>>, change: TableChange | undefined) => plan.fields.find((f) => change?.field && f.pluginField?.toLowerCase() === change.field.toLowerCase())?.id;

/**
 * Stem's decision on a table: the change keys to apply (a reset: every one the update showed as
 * applicable). A key the update didn't show refuses the whole decision. A change the table no
 * longer allows is skipped; one that removes values waits for the owner's Approval, with the
 * values it would remove; the rest apply now. What Stem left out counts as declined, as an
 * unticked box does.
 */
async function decideTable(context: Context, actor: AuditActor, c: Conflict, decision: Decision): Promise<DecisionOutcome> {
  const shown = (c.next as HandedTable).changes.filter((ch) => !ch.stale && !ch.waiting).map((ch) => ch.key);
  const keys = decision.kind === "reset" ? shown : decision.value;
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string" || !shown.includes(k))) return "refused";
  const held = and(eq(pluginConflicts.id, c.id), eq(pluginConflicts.status, "stem"));
  const plan = await tableNow(context.db, c);
  if (!plan) {
    await context.db.delete(pluginConflicts).where(held);
    return "gone";
  }
  const fresh = plan.changes.filter((ch) => keys.includes(ch.key) && !ch.stale && !ch.waiting);
  const waiting = fresh.filter(removesValues).map((ch) => ch.key);
  const values: HeldTable["values"] = {};
  for (const key of waiting) values[key] = await valuesOf(context.db, plan.tableId, fieldIdOf(plan, plan.changes.find((ch) => ch.key === key)));
  // Claimed first: a Job stopped meanwhile gave the table back (`closeStemJob`), and nothing of it applies.
  const claimed = waiting.length
    ? await context.db.update(pluginConflicts).set({ status: "approval", merged: { keys: waiting, values } satisfies HeldTable }).where(held).returning({ id: pluginConflicts.id })
    : await context.db.delete(pluginConflicts).where(held).returning({ id: pluginConflicts.id });
  if (!claimed.length) return "gone";
  const definition = await applyTable(context, { id: c.pluginId }, plan, fresh.filter((ch) => !waiting.includes(ch.key)).map((ch) => ch.key), [], waiting);
  await keepDefinition(context.db, c, definition);
  // The Approval's answer reads the table against the definition it keeps from now on.
  if (waiting.length) await context.db.update(pluginConflicts).set({ old: definition }).where(eq(pluginConflicts.id, c.id));
  await audit(context, actor, c, waiting.length ? "approval" : decision.kind, c.runId);
  return waiting.length ? "approval" : "applied";
}

/**
 * The owner's answer to a table's changes that remove values. On a yes, the values are read
 * again: any difference from what was stored applies nothing, stores the values now and asks
 * again (CONFLICT). Else each change applies through its field operation, which reads the values
 * once more under the table's lock (a row's write takes it shared, so none lands in between) and
 * refuses on a difference: such a change stays out of the table's definition, offered again. On
 * a no they are declined, as an unticked box: the definition the table keeps takes them, and the
 * plugin's row still offers each with "Apply".
 */
async function answerTable(context: Context, actor: AuditActor, c: Conflict, approved: boolean): Promise<"applied" | "kept" | "gone"> {
  const held = c.merged as HeldTable;
  const plan = await tableNow(context.db, c);
  if (!plan) {
    await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
    return "gone";
  }
  let keys: string[] = [];
  if (approved) {
    const now: HeldTable["values"] = {};
    for (const key of held.keys) now[key] = await valuesOf(context.db, plan.tableId, fieldIdOf(plan, plan.changes.find((ch) => ch.key === key)));
    if (canonical(now) !== canonical(held.values)) {
      await context.db.update(pluginConflicts).set({ merged: { keys: held.keys, values: now } satisfies HeldTable }).where(eq(pluginConflicts.id, c.id));
      throw new ORPCError("CONFLICT", message("plugins.table.valuesChanged"));
    }
    keys = plan.changes.filter((ch) => held.keys.includes(ch.key) && !ch.stale && !ch.waiting).map((ch) => ch.key);
  }
  // Only this Approval's changes are answered: any other the table still lacks (one that failed earlier) stays offered.
  const others = plan.changes.filter((ch) => !held.keys.includes(ch.key)).map((ch) => ch.key);
  const expected = Object.fromEntries(keys.map((k) => [k, { values: held.values[k] ?? [], definition: c.old }]));
  const definition = await applyTable(context, { id: c.pluginId }, plan, keys, [], others, expected);
  await keepDefinition(context.db, c, definition);
  await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
  await audit(context, actor, c, approved ? "approved" : "declined", c.runId);
  return approved ? "applied" : "kept";
}
