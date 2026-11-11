import { and, asc, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { harnesses, runs, stepRuns, type QueueClass } from "../db/schema.ts";
import { meter, spanEvent } from "../telemetry/index.ts";

export type { QueueClass };

// A slot is a step run that holds one of its harness's places (`step_runs.working`): at most
// `harnesses.max_working` at once. Every change locks the step's row first, then its harness's
// (`FOR UPDATE`), so two changes on one harness never both see a free place.

const counts = meter("engine");

/** The order the queue is served in: a person waiting first, then resumes, then new starts. */
const CLASS_ORDER = sql`case ${stepRuns.queueClass} when 'person' then 0 when 'resume' then 1 else 2 end`;

/**
 * Gives the step one of its harness's slots, or queues it (class `cls`, from now) when none is
 * free. Called again on a step that already holds one or is already queued, it changes nothing:
 * only `give` and `next` serve the queue, in its order.
 */
export async function take(tx: Tx, step: { id: string; harnessId: string }, cls: QueueClass): Promise<"working" | "queued"> {
  const [row] = await tx.select({ working: stepRuns.working, queuedAt: stepRuns.queuedAt }).from(stepRuns).where(eq(stepRuns.id, step.id)).for("update");
  if (row?.working) return "working";
  if (row?.queuedAt) return "queued";
  const harness = await lockHarness(tx, step.harnessId);
  const free = harness ? (await workingOn(tx, step.harnessId)) < harness.maxWorking : true;
  await tx
    .update(stepRuns)
    .set(free ? { harnessId: step.harnessId, working: true } : { harnessId: step.harnessId, queuedAt: new Date(), queueClass: cls })
    .where(eq(stepRuns.id, step.id));
  const result = free ? "working" : "queued";
  spanEvent("engine.slot", { "dispand.slot.action": "take", "dispand.slot.result": result, "dispand.step.id": step.id, "dispand.harness.id": step.harnessId, "dispand.queue.class": cls });
  if (harness) await gauges(tx, harness);
  return result;
}

/**
 * The step closes: it gives back its slot (or leaves the queue), and the free slots of its
 * harness go to the next queued steps (`next`). Returns those, for the caller to start once
 * this commits.
 */
export async function give(tx: Tx, stepId: string): Promise<string[]> {
  const [row] = await tx.select({ harnessId: stepRuns.harnessId }).from(stepRuns).where(eq(stepRuns.id, stepId)).for("update");
  if (!row?.harnessId) return [];
  const harness = await lockHarness(tx, row.harnessId);
  await tx.update(stepRuns).set({ working: false, queuedAt: null, queueClass: null, pendingAction: null }).where(eq(stepRuns.id, stepId));
  spanEvent("engine.slot", { "dispand.slot.action": "give", "dispand.step.id": stepId, "dispand.harness.id": row.harnessId });
  return harness ? hand(tx, harness) : [];
}

/** Hands the harness's free slots to its queued steps, in the queue's order; returns them, to start once this commits. */
export async function next(tx: Tx, harnessId: string): Promise<string[]> {
  const harness = await lockHarness(tx, harnessId);
  return harness ? hand(tx, harness) : [];
}

type HarnessRow = { id: string; kind: string; maxWorking: number };

async function hand(tx: Tx, harness: HarnessRow): Promise<string[]> {
  const free = harness.maxWorking - (await workingOn(tx, harness.id));
  const handed: string[] = [];
  if (free > 0) {
    // Only steps of runs still going: a run that failed left its queue (`Engine.fail`).
    const queued = await tx
      .select({ id: stepRuns.id, queuedAt: stepRuns.queuedAt, queueClass: stepRuns.queueClass })
      .from(stepRuns)
      .innerJoin(runs, eq(runs.id, stepRuns.runId))
      .where(and(eq(stepRuns.harnessId, harness.id), isNotNull(stepRuns.queuedAt), inArray(runs.status, ["running", "waiting"])))
      .orderBy(CLASS_ORDER, asc(stepRuns.queuedAt), asc(stepRuns.id))
      .limit(free)
      .for("update", { of: stepRuns, skipLocked: true });
    const now = new Date();
    for (const step of queued) {
      await tx.update(stepRuns).set({ working: true, queuedAt: null, queueClass: null, pendingAction: { kind: "start" } }).where(eq(stepRuns.id, step.id));
      counts.histogram("dispand.harness.queue_wait", { unit: "ms", description: "From a step queued for a slot to its slot" }).record(now.getTime() - step.queuedAt!.getTime(), { "dispand.queue.class": step.queueClass ?? "new" });
      spanEvent("engine.slot", { "dispand.slot.action": "hand", "dispand.step.id": step.id, "dispand.harness.id": harness.id, "dispand.queue.class": step.queueClass ?? "new" });
      handed.push(step.id);
    }
  }
  await gauges(tx, harness);
  return handed;
}

function lockHarness(tx: Tx, harnessId: string): Promise<HarnessRow | undefined> {
  return tx
    .select({ id: harnesses.id, kind: harnesses.kind, maxWorking: harnesses.maxWorking })
    .from(harnesses)
    .where(eq(harnesses.id, harnessId))
    .for("update")
    .then(([row]) => row);
}

async function workingOn(tx: Tx, harnessId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(stepRuns).where(and(eq(stepRuns.harnessId, harnessId), eq(stepRuns.working, true)));
  return row?.n ?? 0;
}

async function gauges(tx: Tx, harness: HarnessRow) {
  const [row] = await tx
    .select({ working: sql<number>`count(*) filter (where ${stepRuns.working})`.mapWith(Number), queued: sql<number>`count(*) filter (where ${stepRuns.queuedAt} is not null)`.mapWith(Number) })
    .from(stepRuns)
    .where(eq(stepRuns.harnessId, harness.id));
  const attributes = { "dispand.harness.id": harness.id, "dispand.harness.kind": harness.kind };
  counts.gauge("dispand.harness.working", { description: "Sessions of a harness working on a turn" }).record(row?.working ?? 0, attributes);
  counts.gauge("dispand.harness.queued", { description: "Steps of a harness waiting for a slot" }).record(row?.queued ?? 0, attributes);
}
