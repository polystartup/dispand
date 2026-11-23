import type { Tx } from "../db/client.ts";
import { events, type runs } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { meter } from "../telemetry/index.ts";
import { JOB } from "../triggers/model.ts";

// Jobs as built-in primitives (design 6.3): a Job created, finished or failed appends an `events`
// row in the same transaction, so a `primitive` trigger on `job` can react to another agent's Job.
// Events, not Audit rows: the engine already audits a Job's life.

const counts = meter("engine");

type JobRow = Pick<typeof runs.$inferSelect, "id" | "workspaceId" | "ownerId" | "agentId" | "triggerId" | "cause" | "status" | "rootId">;

/**
 * One Job event: its table the built-in kind, its row the Job, its values the Job's agent,
 * trigger, cause's kind and status, never its result, error or transcript. Its actor is the Job
 * itself (what made it is its cause), and it belongs to the Job's root cause, so a chain of Jobs
 * firing on Jobs is counted against that root's checkpoint.
 */
export async function recordJobEvent(tx: Tx, run: JobRow, operation: "created" | "finished" | "failed"): Promise<void> {
  await tx.insert(events).values({
    id: newId("evt"),
    ownerId: run.ownerId,
    workspaceId: run.workspaceId,
    tableId: JOB,
    rowId: run.id,
    operation,
    changedFieldIds: [],
    before: {},
    after: { agentId: run.agentId, triggerId: run.triggerId, causeKind: run.cause?.kind ?? null, status: run.status },
    actor: { type: "job", runId: run.id },
    rootId: run.rootId,
  });
  counts.counter("dispand.events.recorded").add(1, { "dispand.event.kind": JOB, "dispand.event.operation": operation });
}
