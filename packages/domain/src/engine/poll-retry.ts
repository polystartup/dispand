import { and, count, eq, gte, sql } from "drizzle-orm";
import { recordAudit } from "../audit/record.ts";
import type { Tx } from "../db/client.ts";
import { messages, pollItems, questions, runs } from "../db/schema.ts";
import { stored, storedText } from "../messages/index.ts";
import { meter } from "../telemetry/index.ts";

/** The Jobs one poll item may start: its first, and more after a transient failure (`retryPollItem`). */
export const POLL_ITEM_JOBS = 3;

const counts = meter("engine");

/**
 * Whether a Job's error is a model provider's that may pass: rate limited, or a 408, 409 or 5xx, as
 * the cloud runner words it (`providerError`). Only the cloud runner's errors are kept as message
 * keys: a runner's words are plain text (`plainText`), so none reads as one.
 */
export function transientFailure(error: string | null): boolean {
  if (!error) return false;
  const text = storedText(error);
  if (!("key" in text)) return false;
  if (text.key === "cloud.fail.rateLimited") return true;
  const status = (text.values as { status?: unknown } | undefined)?.status;
  return text.key === "cloud.fail.providerError" && typeof status === "number" && (status === 408 || status === 409 || status >= 500);
}

/**
 * A poll's Job that failed transiently (`transientFailure`) hands its item back: `deferred` again,
 * so a tick starts another Job for it (`Scheduler.claimDeferredItems`), up to `POLL_ITEM_JOBS` Jobs
 * in all. Only when the Job called no tool and asked nothing: another Job would do or ask it
 * again. In the transaction that ends the Job (`Engine.finishRun`), with its Audit row.
 */
export async function retryPollItem(tx: Tx, run: typeof runs.$inferSelect): Promise<void> {
  if (run.cause?.kind !== "poll" || !run.agentId || !transientFailure(run.error)) return;
  const { triggerId, itemId } = run.cause;
  const [item] = await tx
    .select()
    .from(pollItems)
    .where(and(eq(pollItems.triggerId, triggerId), eq(pollItems.itemId, itemId), eq(pollItems.runId, run.id), eq(pollItems.status, "started")))
    .for("update");
  if (!item) return;
  const [acted] = await tx
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.runId, run.id), eq(messages.role, "tool")));
  const [asked] = await tx.select({ n: count() }).from(questions).where(eq(questions.runId, run.id));
  if (acted!.n > 0 || asked!.n > 0) return;
  // Its Jobs so far: those of its trigger's agent since it was first seen, with it as their cause.
  const [jobs] = await tx
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.agentId, run.agentId), gte(runs.createdAt, item.firstSeen), eq(runs.triggerId, triggerId), sql`${runs.cause}->>'itemId' = ${itemId}`));
  if (jobs!.n >= POLL_ITEM_JOBS) return;
  await tx
    .update(pollItems)
    .set({ status: "deferred", message: stored("engine.poll.retried") })
    .where(eq(pollItems.id, item.id));
  await recordAudit(tx, {
    workspaceId: run.workspaceId,
    ownerId: run.ownerId,
    actor: { type: "job", runId: run.id },
    jobId: run.id,
    action: "poll.itemRetried",
    resource: { type: "trigger", id: triggerId },
    details: { triggerId, jobs: jobs!.n },
  });
  counts.counter("dispand.poll.items_retried", { description: "Poll items handed back for another Job after a transient failure" }).add(1);
}
