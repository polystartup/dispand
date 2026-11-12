import { eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { audit, workspaceSettings } from "../db/schema.ts";
import { errorKind } from "../log.ts";
import { inSpan, meter, tracer } from "../telemetry/index.ts";

const traces = tracer("audit");
const counts = meter("audit");

/** Rows deleted per statement, so one sweep never holds a long lock on a large table. */
export const SWEEP_BATCH = 1000;

/** The retention of a workspace with no settings row (design 6.8). */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Deletes the Audit rows older than their owner's retention (`workspace_settings.
 * audit_retention_days`, 90 days without a settings row), in batches of `SWEEP_BATCH` until none
 * is left. Only Audit rows: events and memory are not subject to it. Which rows of a batch go
 * first doesn't matter, so the batch takes them in no order.
 */
export async function sweepAudit(db: Db, now: Date): Promise<{ removed: number }> {
  return inSpan(traces, "audit.sweep", {}, errorKind, async (span) => {
    let removed = 0;
    for (;;) {
      const past = db
        .select({ id: audit.id })
        .from(audit)
        .leftJoin(workspaceSettings, eq(workspaceSettings.ownerId, audit.ownerId))
        .where(lt(audit.at, sql`${now.toISOString()}::timestamptz - make_interval(days => coalesce(${workspaceSettings.auditRetentionDays}, ${DEFAULT_RETENTION_DAYS}))`))
        .limit(SWEEP_BATCH);
      const gone = await db.delete(audit).where(inArray(audit.id, past)).returning({ id: audit.id });
      removed += gone.length;
      if (gone.length < SWEEP_BATCH) break;
    }
    span.setAttribute("dispand.audit.swept", removed);
    if (removed > 0) counts.counter("dispand.audit.swept").add(removed);
    return { removed };
  });
}
