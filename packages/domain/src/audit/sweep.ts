import { eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { audit, organizations, workspaces } from "../db/schema.ts";
import { eachScope, inScope, type Scope, SYSTEM } from "../db/scope.ts";
import { errorKind } from "../log.ts";
import { inSpan, meter, tracer } from "../telemetry/index.ts";

const traces = tracer("audit");
const counts = meter("audit");

/** Rows deleted per statement, so one sweep never holds a long lock on a large table. */
export const SWEEP_BATCH = 1000;

/** Rows past their organization's retention: `organizations.audit_retention_days`, set by its owner. */
const past = (now: Date) => {
  const days = sql`(select ${organizations.auditRetentionDays} from ${organizations} join ${workspaces} on ${workspaces.organizationId} = ${organizations.id} where ${workspaces.id} = ${audit.workspaceId})`;
  return lt(audit.at, sql`${now.toISOString()}::timestamptz - make_interval(days => ${days})`);
};

/** The workspaces with a row past their organization's retention, read under SYSTEM from ids and times only. */
export async function auditSweepScopes(db: Db, now: Date): Promise<Scope[]> {
  return inScope(SYSTEM, () => db.selectDistinct({ organizationId: workspaces.organizationId, workspaceId: workspaces.id }).from(audit)
    .innerJoin(workspaces, eq(workspaces.id, audit.workspaceId)).where(past(now)));
}

/**
 * Deletes the Audit rows past their organization's retention, per workspace (`eachScope`; once, as
 * is, on a single-tenant database), in batches of `SWEEP_BATCH` until none is left. Only Audit
 * rows: events and memory are not subject to it. Which rows of a batch go first doesn't matter,
 * so the batch takes them in no order.
 */
export async function sweepAudit(db: Db, now: Date): Promise<{ removed: number }> {
  return inSpan(traces, "audit.sweep", {}, errorKind, async (span) => {
    let removed = 0;
    await eachScope(db, (db) => auditSweepScopes(db, now), async () => {
      for (;;) {
        const batch = db.select({ id: audit.id }).from(audit).where(past(now)).limit(SWEEP_BATCH);
        const gone = await db.delete(audit).where(inArray(audit.id, batch)).returning({ id: audit.id });
        removed += gone.length;
        if (gone.length < SWEEP_BATCH) break;
      }
    });
    span.setAttribute("dispand.audit.swept", removed);
    if (removed > 0) counts.counter("dispand.audit.swept").add(removed);
    return { removed };
  });
}
