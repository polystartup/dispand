import { requireLegacyWorkspace } from "../workspace/access.ts";
import { ORPCError } from "@orpc/server";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents as agentsTable, fields as fieldsTable, pluginConflicts, plugins as pluginsTable, questions, rows as rowsTable, skillFiles, skillFileUpstream, skillPackages, tables as tablesTable, tools as toolsTable, triggers as triggersTable } from "../db/schema.ts";
import type { AuditActor } from "../audit/model.ts";
import { recordAudit } from "../audit/record.ts";
import { recordInteraction } from "../engine/interactions.ts";
import { message, reasonOf, say, type Text } from "../messages/index.ts";
import { publish, removeFieldIn, retypeIn, updateFieldIn } from "../data/tables.ts";
import { checkFile, putFile } from "../skills/procedures.ts";
import { newId } from "../ids.ts";
import { canonical } from "../platform/approvals.ts";
import type { InitialContext } from "../rpc/context.ts";
import { meter } from "../telemetry/index.ts";
import { type ElementKind, sameValue } from "./overrides.ts";
import type { PrimitiveDefinition } from "./definitions.ts";
import { applyTable, definitionAfter, tablePlan, tablesOf } from "./table-apply.ts";
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
//
// A skill's file is a wording field (`kind: "skill_file"`, the skill package's id, field
// `file:<path>`), its value the file's text (a file that isn't text: its size and digest; none:
// null). A reset takes the plugin's file as the package keeps it (`skill_file_upstream`). A decision
// or an answer applies in one transaction with the package locked as every file edit locks it: the
// file and the plugin's read again (another value is the owner's to decide again), the conflict
// claimed, then the file written.

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
  if (c.kind === "skill_file") return fileNow(db, c);
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
const AGENT_RIGHTS = new Set(["bundles", "dataTables", "toolIds", "skillPackageIds", "selfLearning", "consults", "consultMode"]);

/** Whether a decided value may apply without the owner's Approval: one of the two values, and for an agent's rights the owner's alone. */
function within(kind: Conflict["kind"], field: string, value: unknown, mine: unknown, next: unknown): boolean {
  if (kind === "agent" && AGENT_RIGHTS.has(field)) return sameValue(kind, field, value, mine);
  return sameValue(kind as ElementKind, field, value, mine) || sameValue(kind as ElementKind, field, value, next);
}

async function audit(context: Context, actor: AuditActor, c: Conflict, decision: string, jobId: string | null) {
  // Ids, the field's name and the decision's kind: never a value.
  const [plugin] = await context.db.select({ workspaceId: pluginsTable.workspaceId }).from(pluginsTable).where(eq(pluginsTable.id, c.pluginId));
  await recordAudit(context.db, { workspaceId: plugin!.workspaceId, ownerId: context.ownerId, actor, jobId, action: "plugin.decided", resource: { type: "plugin", id: c.pluginId }, details: { elementKind: c.kind, elementId: c.elementId, field: c.field, decision } });
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
export async function decide(context: Context, actor: AuditActor, conflictId: string, decision: Decision, runId?: string, /** Where a table's changes its operations refused are told. */ report?: { refused: Refused[] }): Promise<DecisionOutcome> {
  const [c] = await context.db
    .select()
    .from(pluginConflicts)
    .where(and(eq(pluginConflicts.id, conflictId), eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.status, "stem"), ...(runId ? [eq(pluginConflicts.runId, runId)] : [])));
  if (!c) return "gone";
  if (c.kind === "table") return decideTable(context, actor, c, decision, report);
  if (c.kind === "skill_file") return decideFile(context, actor, c, decision, report);
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
export async function answerConflict(context: Context, actor: AuditActor, conflictId: string, approved: boolean, /** The merged value the owner answered on, when they read it first: another one now is shown again. */ seen?: unknown, /** Where a table's changes that went stale, or that their operations refused, are told. */ report?: { refused: Refused[]; stale: string[] }): Promise<"applied" | "kept" | "reopened" | "gone"> {
  const [c] = await context.db.select().from(pluginConflicts).where(and(eq(pluginConflicts.id, conflictId), eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.status, "approval")));
  if (!c) return "gone";
  if (seen !== undefined && canonical(c.merged) !== canonical(seen)) throw new ORPCError("CONFLICT", message("plugins.override.conflictChanged"));
  const outcome = await answerOne(context, actor, c, approved, report);
  await context.db.transaction((tx) => settleApprovals(tx, [c.runId], actor.type === "user" ? actor : undefined));
  // Every Inbox showing it hears that an item left, even while others still wait.
  context.engine.questionChanges.publish("changed", true);
  return outcome;
}

async function answerOne(context: Context, actor: AuditActor, c: Conflict, approved: boolean, report?: { refused: Refused[]; stale: string[] }): Promise<"applied" | "kept" | "reopened" | "gone"> {
  if (c.kind === "table") return answerTable(context, actor, c, approved, report);
  if (c.kind === "skill_file") return answerFile(context, actor, c, approved);
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
  if (c.kind === "skill_file") {
    const now = await context.db.transaction(async (tx) => {
      const now = await fileNow(tx, c, true);
      if (now && choice === "plugin") await putFile(tx, await requireLegacyWorkspace({ db: tx, ownerId: context.ownerId, job: context.job }), c.elementId, pathOf(c), now.upstream);
      await tx.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
      return now;
    });
    if (now) await audit(context, actor, c, choice, c.runId);
    return;
  }
  const now = await fieldNow(context.db, c);
  if (now && choice === "plugin") await apply(context, c, now.plugin);
  await context.db.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
  if (now) await audit(context, actor, c, choice, c.runId);
}

/** An update that changes the plugin's value of these fields: their pending conflicts are the owner's again. */
export async function reopenChanged(tx: Db | Tx, kind: ElementKind | "skill_file", elementId: string, fields: string[]): Promise<void> {
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

/** Where a conflict's element is: its table of rows. */
export const elementTable = (kind: Conflict["kind"]) => (kind === "agent" ? agentsTable : kind === "tool" ? toolsTable : kind === "table" ? tablesTable : kind === "skill_file" ? skillPackages : triggersTable);

/** A conflict as the owner decides it: the field's value now, the plugin's now, Stem's suggestion, and the token of the three. */
export async function conflictView(db: Db | Tx, r: Conflict) {
  const now = await fieldNow(db, r);
  // A file the owner removed, or the plugin did, is null now: shown as none, not as it was.
  const shown = { id: r.id, field: r.field, status: r.status, mine: now ? now.value : r.mine, next: now ? now.plugin : r.next, merged: r.status === "approval" ? r.merged : null };
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
    const table = elementTable(r.kind);
    const [element] = await db.select({ name: table.name }).from(table).where(and(eq(table.id, r.elementId), eq(table.ownerId, ownerId)));
    items.push({ ...(await conflictView(db, r)), kind: r.kind, elementId: r.elementId, name: element?.name ?? null });
  }
  return { plugin: plugin ?? null, items };
}

/** The field a table's conflict is kept under: one per table. */
export const TABLE_FIELD = "changes";

/** What a table's conflict keeps of the update's screen: the plugin's definition and the changes shown against the table then. */
export type HandedTable = { definition: PrimitiveDefinition; changes: TableChange[] };
/** A field's values as read when Stem decided: how many rows hold one, the first of them (each row's id with its value) to show, and a digest of all. */
type Snapshot = { count: number; shown: [string, unknown][]; digest: string };
/** What waits in the Approval: the changes that remove values, and the values of each one's field. */
type HeldTable = { keys: string[]; values: Record<string, Snapshot> };
/** A change of a table Stem picked or the owner approved that its operation refused, and why: reported, offered again by the next update. */
export type Refused = { key: string; reason: Text };

/** How many of a field's values an Approval keeps to show. */
const SHOWN_VALUES = 50;

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
type Plan = NonNullable<Awaited<ReturnType<typeof tableNow>>>;

const fieldOf = (plan: Plan, change: TableChange | undefined) => plan.fields.find((f) => change?.field && f.pluginField?.toLowerCase() === change.field.toLowerCase());

/** The values of the field a change names, every row's: their count, the first to show, and a digest of all. */
async function snapshotOf(db: Db | Tx, plan: Plan, change: TableChange | undefined): Promise<Snapshot> {
  const fieldId = fieldOf(plan, change)?.id;
  const rows = fieldId ? await db.select({ id: rowsTable.id, values: rowsTable.values }).from(rowsTable).where(eq(rowsTable.tableId, plan.tableId)).orderBy(asc(rowsTable.id)) : [];
  const all = rows.flatMap((r) => (r.values[fieldId!] === undefined || r.values[fieldId!] === null ? [] : [[r.id, r.values[fieldId!]] as [string, unknown]]));
  return { count: all.length, shown: all.slice(0, SHOWN_VALUES), digest: createHash("sha256").update(canonical(all)).digest("hex") };
}

/**
 * Stem's decision on a table: the change keys to apply (a reset: every one the update showed as
 * applicable). A key the update didn't show refuses the whole decision. A change the table no
 * longer allows is skipped; one that removes values waits for the owner's Approval, with the
 * values of its field; the rest apply now, and one its operation refuses is in `report`. What
 * Stem left out counts as declined, as an unticked box does.
 */
async function decideTable(context: Context, actor: AuditActor, c: Conflict, decision: Decision, report?: { refused: Refused[] }): Promise<DecisionOutcome> {
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
  for (const key of waiting) values[key] = await snapshotOf(context.db, plan, plan.changes.find((ch) => ch.key === key));
  // Claimed first: a Job stopped meanwhile gave the table back (`closeStemJob`), and nothing of it applies.
  const claimed = waiting.length
    ? await context.db.update(pluginConflicts).set({ status: "approval", merged: { keys: waiting, values } satisfies HeldTable }).where(held).returning({ id: pluginConflicts.id })
    : await context.db.delete(pluginConflicts).where(held).returning({ id: pluginConflicts.id });
  if (!claimed.length) return "gone";
  const failed: { name: string; reason: Text; key?: string }[] = [];
  const definition = await applyTable(context, { id: c.pluginId }, plan, fresh.filter((ch) => !waiting.includes(ch.key)).map((ch) => ch.key), failed, waiting);
  report?.refused.push(...failed.map((f) => ({ key: f.key ?? "", reason: f.reason })));
  // Written only while the table still keeps the definition the decision was planned from: an update that merged it since wins.
  await context.db.update(tablesTable).set({ definition }).where(and(eq(tablesTable.id, c.elementId), sql`${tablesTable.definition} = ${JSON.stringify(c.old)}::jsonb`));
  // The Approval's answer reads the table against the definition it keeps from now on.
  if (waiting.length) await context.db.update(pluginConflicts).set({ old: definition }).where(eq(pluginConflicts.id, c.id));
  await audit(context, actor, c, waiting.length ? "approval" : decision.kind, c.runId);
  return waiting.length ? "approval" : "applied";
}

/** Thrown in an Approval's transaction when the values changed: it rolls the claim back, and the values now are stored. */
class ValuesChanged extends Error {
  constructor(readonly values: HeldTable["values"]) {
    super("values changed");
  }
}

/**
 * The owner's answer to a table's changes that remove values, in one transaction with the table
 * locked as every field operation locks it (a row's write takes that lock shared, so none lands
 * in between): the changes are planned again against the definition the table keeps, the
 * Approval's item is claimed as the owner answered it (an update that dropped it, or values
 * stored anew since, leave nothing to claim), and on a yes the values are read again (any
 * difference applies nothing, stores the values now and asks again, CONFLICT), then each change
 * runs its field operation's change in that same transaction. A change that went stale (the field
 * retyped or edited since) is skipped, declined; one its operation refuses is reported and stays
 * out of the definition, offered again. On a no they are declined, as an unticked box: the
 * definition the table keeps takes them, and the plugin's row still offers each with "Apply".
 */
async function answerTable(context: Context, actor: AuditActor, c: Conflict, approved: boolean, report?: { refused: Refused[]; stale: string[] }): Promise<"applied" | "kept" | "gone"> {
  const held = c.merged as HeldTable;
  const asAnswered = and(eq(pluginConflicts.id, c.id), eq(pluginConflicts.status, "approval"), sql`${pluginConflicts.merged} = ${JSON.stringify(c.merged)}::jsonb`);
  let done: { applied: { tableId: string; rowIds: string[] }[]; refused: Refused[]; stale: string[] } | "gone";
  try {
    done = await context.db.transaction(async (tx) => {
      await tx.select({ id: tablesTable.id }).from(tablesTable).where(eq(tablesTable.id, c.elementId)).for("update");
      const plan = await tableNow(tx, c);
      if (!plan) {
        await tx.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
        return "gone" as const;
      }
      if (!(await tx.delete(pluginConflicts).where(asAnswered).returning({ id: pluginConflicts.id })).length) throw new ORPCError("CONFLICT", message("plugins.override.conflictChanged"));
      const applied: { tableId: string; rowIds: string[] }[] = [];
      const refused: Refused[] = [];
      const stale: string[] = [];
      if (approved) {
        const now: HeldTable["values"] = {};
        for (const key of held.keys) now[key] = await snapshotOf(tx, plan, plan.changes.find((ch) => ch.key === key));
        if (held.keys.some((k) => now[k]!.digest !== held.values[k]?.digest)) throw new ValuesChanged(now);
        for (const key of held.keys) {
          const change = plan.changes.find((ch) => ch.key === key);
          const fieldId = fieldOf(plan, change)?.id;
          const def = plan.next.fields.find((f) => change?.field && f.name.toLowerCase() === change.field.toLowerCase());
          if (!change || change.stale || change.waiting || !fieldId) {
            stale.push(key);
            continue;
          }
          try {
            // Each in a savepoint: one refused leaves the others.
            const rowIds = await tx.transaction(async (sp) => {
              const [field] = await sp.select().from(fieldsTable).where(eq(fieldsTable.id, fieldId));
              if (change.kind === "remove") return (await removeFieldIn(sp, field!), []);
              if (change.kind === "retype") return (await retypeIn(sp, field!, def!.type as never, false)).rowIds;
              return (await updateFieldIn(sp, field!, { choices: def?.choices ?? [] })).cleared;
            });
            applied.push({ tableId: plan.tableId, rowIds });
          } catch (err) {
            if (!(err instanceof ORPCError)) throw err;
            refused.push({ key, reason: reasonOf(err) });
          }
        }
      }
      // Only this Approval's changes are answered: any other the table still lacks (one that failed earlier) stays offered, and so does one refused now.
      const again = plan.changes.filter((ch) => ch.waiting || !held.keys.includes(ch.key) || refused.some((r) => r.key === ch.key));
      await tx.update(tablesTable).set({ definition: definitionAfter(plan, again) }).where(eq(tablesTable.id, plan.tableId));
      return { applied, refused, stale };
    });
  } catch (err) {
    if (!(err instanceof ValuesChanged)) throw err;
    await context.db.update(pluginConflicts).set({ merged: { keys: held.keys, values: err.values } satisfies HeldTable }).where(asAnswered);
    throw new ORPCError("CONFLICT", message("plugins.table.valuesChanged"));
  }
  if (done === "gone") return "gone";
  for (const a of done.applied) publish(context.dataEvents, a.tableId, a.rowIds);
  report?.refused.push(...done.refused);
  report?.stale.push(...done.stale);
  await audit(context, actor, c, approved ? "approved" : "declined", c.runId);
  return approved ? "applied" : "kept";
}

/** A skill's file as its conflict keeps it: its text, a file that isn't text as its size and digest, null for none. */
export function fileValue(content: Uint8Array | undefined): unknown {
  if (content === undefined) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    // A NUL can't be stored in jsonb: such a file is kept as one that isn't text.
    if (!text.includes("\u0000")) return text;
  } catch {
    // Not UTF-8: as below.
  }
  return { bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
}

const pathOf = (c: Conflict) => c.field.slice("file:".length);

/**
 * A file conflict's file and the plugin's, with the plugin's bytes (what a reset writes); null
 * when the package is gone or no longer the plugin's. `lock`: the package `for update`, as a file's
 * edit and the update lock it.
 */
async function fileNow(db: Db | Tx, c: Conflict, lock = false) {
  const query = db.select({ id: skillPackages.id }).from(skillPackages).where(and(eq(skillPackages.id, c.elementId), eq(skillPackages.ownerId, c.ownerId), eq(skillPackages.pluginId, c.pluginId)));
  const [pkg] = lock ? await query.for("update") : await query;
  if (!pkg) return null;
  const [file] = await db.select({ content: skillFiles.content }).from(skillFiles).where(and(eq(skillFiles.packageId, pkg.id), eq(skillFiles.path, pathOf(c))));
  const [upstream] = await db.select({ content: skillFileUpstream.content }).from(skillFileUpstream).where(and(eq(skillFileUpstream.packageId, pkg.id), eq(skillFileUpstream.path, pathOf(c))));
  return { value: fileValue(file?.content), plugin: fileValue(upstream?.content), upstream: upstream?.content ?? null };
}

/** Whether a file conflict still stands as it was handed off: the owner's file and the plugin's both as they were. */
const fileStands = (c: Conflict, now: { value: unknown; plugin: unknown }) => canonical(now.value) === canonical(c.mine) && canonical(now.plugin) === canonical(c.next);

/**
 * Stem's decision on a skill's file, in one transaction under the package's lock: a reset writes
 * the plugin's file (none, when the plugin has none), a merge (a text) equal to either file
 * applies, any other waits for the owner's Approval. One the package's check refuses (a
 * `SKILL.md` that no longer reads as a skill), checked before it applies or waits, applies
 * nothing and is in `report`.
 */
async function decideFile(context: Context, actor: AuditActor, c: Conflict, decision: Decision, report?: { refused: Refused[] }): Promise<DecisionOutcome> {
  if (decision.kind === "merge" && typeof decision.value !== "string") {
    report?.refused.push({ key: c.field, reason: say("plugins.stem.fileText") });
    return "refused";
  }
  const held = and(eq(pluginConflicts.id, c.id), eq(pluginConflicts.status, "stem"));
  let outcome: DecisionOutcome;
  try {
    outcome = await context.db.transaction(async (tx): Promise<DecisionOutcome> => {
      const now = await fileNow(tx, c, true);
      if (!now) {
        await tx.delete(pluginConflicts).where(held);
        return "gone";
      }
      if (!fileStands(c, now)) return (await tx.update(pluginConflicts).set({ status: "open", merged: null }).where(held).returning({ id: pluginConflicts.id })).length ? "reopened" : "gone";
      const value = decision.kind === "reset" ? now.plugin : decision.value;
      if (!within(c.kind, c.field, value, c.mine, c.next)) {
        // Checked now, so Stem hears of a text the package wouldn't take, not the owner on yes.
        await checkFile(tx, await requireLegacyWorkspace({ db: tx, ownerId: context.ownerId, job: context.job }), c.elementId, pathOf(c), Buffer.from(value as string));
        return (await tx.update(pluginConflicts).set({ status: "approval", merged: value }).where(held).returning({ id: pluginConflicts.id })).length ? "approval" : "gone";
      }
      if (!(await tx.delete(pluginConflicts).where(held).returning({ id: pluginConflicts.id })).length) return "gone";
      await putFile(tx, await requireLegacyWorkspace({ db: tx, ownerId: context.ownerId, job: context.job }), c.elementId, pathOf(c), decision.kind === "reset" ? now.upstream : Buffer.from(value as string));
      return "applied";
    });
  } catch (err) {
    if (!(err instanceof ORPCError)) throw err;
    report?.refused.push({ key: c.field, reason: reasonOf(err) });
    return "refused";
  }
  if (outcome === "gone") return outcome;
  await audit(context, actor, c, outcome === "applied" ? decision.kind : outcome, c.runId);
  // The skill's text reached sessions: they get the file as it is now.
  if (outcome === "applied") await context.engine.narrowWorkspaceSessions(await requireLegacyWorkspace(context), context.db);
  return outcome;
}

/**
 * The owner's answer to Stem's merged text of a skill's file, in one transaction under the
 * package's lock: the file and the plugin's read again (another value is the owner's to decide
 * again), the item claimed as the owner answered it, then on a yes the text written.
 */
async function answerFile(context: Context, actor: AuditActor, c: Conflict, approved: boolean): Promise<"applied" | "kept" | "reopened" | "gone"> {
  const asAnswered = and(eq(pluginConflicts.id, c.id), eq(pluginConflicts.status, "approval"), sql`${pluginConflicts.merged} = ${JSON.stringify(c.merged)}::jsonb`);
  const outcome = await context.db.transaction(async (tx) => {
    const now = await fileNow(tx, c, true);
    if (!now) {
      await tx.delete(pluginConflicts).where(eq(pluginConflicts.id, c.id));
      return "gone" as const;
    }
    const claimed = fileStands(c, now) ? await tx.delete(pluginConflicts).where(asAnswered).returning({ id: pluginConflicts.id }) : await tx.update(pluginConflicts).set({ status: "open", merged: null }).where(asAnswered).returning({ id: pluginConflicts.id });
    if (!claimed.length) throw new ORPCError("CONFLICT", message("plugins.override.conflictChanged"));
    if (!fileStands(c, now)) return "reopened" as const;
    if (approved) await putFile(tx, await requireLegacyWorkspace({ db: tx, ownerId: context.ownerId, job: context.job }), c.elementId, pathOf(c), Buffer.from(c.merged as string));
    return approved ? ("applied" as const) : ("kept" as const);
  });
  if (outcome === "gone") return outcome;
  await audit(context, actor, c, outcome === "reopened" ? "reopened" : approved ? "approved" : "declined", c.runId);
  return outcome;
}
