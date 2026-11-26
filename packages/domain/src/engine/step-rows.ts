import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, messages, roots, runs, stepRuns, workflowVersions } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { message } from "../messages/index.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import { EngineError } from "./errors.ts";
import { refusedRun } from "./roots.ts";
import { give, type Refused } from "./slots.ts";
import { type Out, type RunRow, type StepRow, stepView } from "./views.ts";

// Reads and writes of a run's step rows that need nothing of the engine but the database.

/** The step as it is now, for `runs.stream` (it queued, or left the queue). */
export async function pushStep(tx: Tx, stepId: string, out: Out[]) {
  const [row] = await tx.select().from(stepRuns).where(eq(stepRuns.id, stepId));
  if (row) out.push({ type: "step", step: stepView(row) });
}

/** A loop runs in the engine, without a session: it stays running while its iterations do. */
export async function startLoop(db: Db, step: StepRow, out: Out[]): Promise<boolean> {
  const [row] = await db
    .update(stepRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
    .returning();
  if (row) out.push({ type: "step", step: stepView(row) });
  return !!row;
}

/** One pending row per body step of the loop, for `iteration` (once: a retried advance adds none). */
export async function openIteration(db: Db, run: RunRow, def: WorkflowDef, loopId: string, iteration: number, out: Out[]): Promise<boolean> {
  const body = def.steps.filter((s) => s.loopId === loopId);
  const harnessOf = await agentHarnesses(db, run.workspaceId, body);
  const rows = await db
    .insert(stepRuns)
    .values(body.map((s) => ({ id: newId("step"), runId: run.id, nodeId: s.id, iteration, harnessId: harnessOf(s), status: "pending" as const })))
    .onConflictDoNothing()
    .returning();
  for (const row of rows) out.push({ type: "step", step: stepView(row) });
  return rows.length > 0;
}

/** A step on a branch the run didn't take: it never runs. */
export async function skip(db: Db, step: StepRow, out: Out[]): Promise<boolean> {
  const [row] = await db
    .update(stepRuns)
    .set({ status: "skipped", finishedAt: new Date() })
    .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
    .returning();
  if (row) out.push({ type: "step", step: stepView(row) });
  return !!row;
}

/** A step that held a slot gives it back, or leaves the queue; the steps handed the slot go on once `tx` commits (`handOver`). */
export async function release(tx: Tx, step: StepRow, out: Out[], refused: Refused) {
  if (!step.working && !step.queuedAt) return;
  const handed = await give(tx, step.id, refused);
  if (handed.length === 0) return;
  const rows = await tx.select({ id: stepRuns.id, runId: stepRuns.runId }).from(stepRuns).where(inArray(stepRuns.id, handed));
  for (const r of rows) out.push({ type: "slot", runId: r.runId, stepId: r.id });
}

/** The runs each transaction locked (`lockRun`). */
const lockedRuns = new WeakMap<Tx, Set<string>>();

/**
 * Locks the run's row for the rest of `tx`, after its root's (`FOR KEY SHARE`; a caller that
 * locks the root `FOR UPDATE`, `rootGoingLocked`, does so first), and returns it. Every
 * transaction that ends a run's steps or changes its row takes it first: the root, the run, then
 * its steps and questions, then their harness (`slots.ts`), so two paths on one run wait for each
 * other instead of deadlocking (`expectRunLocked` checks it). A consulted Job's asker goes first:
 * the consulted Job's end answers into the asker's step and run (`answerConsult`), and the
 * asker's stop stops it (`expire`). `NO KEY UPDATE` leaves free the key share a foreign key's
 * check takes (a message, a question or an event written for the run). `skipLocked`: undefined
 * while another transaction holds it.
 */
export async function lockRun(tx: Tx, runId: string, { skipLocked = false } = {}): Promise<RunRow | undefined> {
  // The root read with the cause, in one statement: a Job has one (its asker's, for a consulted Job), a workflow run none.
  const [rooted] = await tx.select({ cause: runs.cause }).from(runs).innerJoin(roots, eq(roots.id, runs.rootId)).where(eq(runs.id, runId)).for("key share", { of: roots });
  if (rooted?.cause?.kind === "consult" && !(await lockRun(tx, rooted.cause.jobId, { skipLocked })) && skipLocked) return undefined;
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("no key update", skipLocked ? { skipLocked } : {});
  if (!run) return undefined;
  const runIds = lockedRuns.get(tx) ?? new Set<string>();
  lockedRuns.set(tx, runIds.add(runId));
  return run;
}

/** Throws unless `tx` locked the run first (`lockRun`): a path that would lock its rows in another order. */
export function expectRunLocked(tx: Tx, runId: string): void {
  if (!lockedRuns.get(tx)?.has(runId)) throw new Error(`run ${runId} changed without its lock (lockRun)`);
}

/** `rootGoing`, with the run's root locked: a chat message and a checkpoint are decided one after the other. */
export async function rootGoingLocked(tx: Tx, runId: string, refused: Refused): Promise<boolean> {
  const [row] = await tx.select({ state: roots.state }).from(runs).innerJoin(roots, eq(roots.id, runs.rootId)).where(eq(runs.id, runId)).for("update", { of: roots });
  return (!row || row.state === "going") && !(await refusedRun(tx, runId, refused));
}

/** A Job carries its own definition; a workflow run reads the version it started on. */
export async function defOf(
  run: Pick<typeof runs.$inferSelect, "workflowId" | "version" | "def">,
  db: Tx | Db,
): Promise<WorkflowDef> {
  if (run.def) return run.def;
  const [row] = run.workflowId
    ? await db
        .select({ def: workflowVersions.def })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.workflowId, run.workflowId), eq(workflowVersions.version, run.version)))
    : [];
  if (!row) throw new EngineError("NOT_FOUND", message("workflows.versionNotFound"));
  return row.def;
}

export function undeliveredMessages(db: Db, stepRunId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.stepRunId, stepRunId), eq(messages.role, "user"), isNull(messages.deliveredAt)))
    .orderBy(asc(messages.position));
}

/** What a chat's sessions already got: the owner's delivered messages and the agent's answers. */
export function deliveredTranscript(db: Db, stepRunId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.stepRunId, stepRunId), or(eq(messages.role, "assistant"), and(eq(messages.role, "user"), isNotNull(messages.deliveredAt)))))
    .orderBy(asc(messages.position));
}

/**
 * Each agent step's harness as its agent is now, by node, for its row: what a queued step is
 * charged to. A workflow agent step's is set again when it becomes ready (`openSession`).
 */
export async function agentHarnesses(db: Db | Tx, workspaceId: string, nodes: object[]): Promise<(node: object) => string | null> {
  const agentOf = (n: object) => ("agentId" in n && typeof n.agentId === "string" && n.agentId ? n.agentId : null);
  const ids = [...new Set(nodes.flatMap((n) => agentOf(n) ?? []))];
  const rows = ids.length
    ? await db.select({ id: agents.id, harnessId: agents.harnessId }).from(agents).where(and(inArray(agents.id, ids), eq(agents.workspaceId, workspaceId)))
    : [];
  const byAgent = new Map(rows.map((r) => [r.id, r.harnessId]));
  return (n) => byAgent.get(agentOf(n) ?? "") ?? null;
}
