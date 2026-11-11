import { eq } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { events, runs, type EventActor, type questions } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { meter } from "../telemetry/index.ts";
import { INTERACTION } from "../triggers/model.ts";

// Questions and Approvals as built-in primitives (design 6.3): asking, answering and expiring one
// appends an `events` row in the same transaction, as a primitive table's write does.

const counts = meter("engine");

type Asked = Pick<typeof questions.$inferSelect, "id" | "ownerId" | "runId" | "stepRunId" | "kind">;

/**
 * One interaction event: its table the built-in kind, its row the item's id, its values the
 * item's kind and the asking run, agent and step, never its text, options or answer. It belongs
 * to the asking Job's root cause, whoever wrote it: a paused root's interactions wait with its
 * other events. `actor` is who made the change (the asking Job, or the person who answered).
 */
export async function recordInteraction(tx: Tx, q: Asked, operation: "created" | "answered" | "expired", actor?: EventActor): Promise<void> {
  const [asking] = await tx.select({ agentId: runs.agentId, rootId: runs.rootId }).from(runs).where(eq(runs.id, q.runId));
  await tx.insert(events).values({
    id: newId("evt"),
    ownerId: q.ownerId,
    tableId: INTERACTION,
    rowId: q.id,
    operation,
    changedFieldIds: [],
    before: {},
    after: { kind: q.kind, runId: q.runId, agentId: asking?.agentId ?? null, stepRunId: q.stepRunId ?? null },
    actor: actor ?? { type: "job", runId: q.runId },
    rootId: asking?.rootId ?? null,
  });
  counts.counter("dispand.events.recorded").add(1, { "dispand.event.kind": INTERACTION, "dispand.event.operation": operation });
}

/** `recordInteraction` for each item, in order. */
export async function recordInteractions(tx: Tx, qs: Asked[], operation: "created" | "answered" | "expired"): Promise<void> {
  for (const q of qs) await recordInteraction(tx, q, operation);
}

