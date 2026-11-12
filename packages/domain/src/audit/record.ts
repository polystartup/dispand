import { eq } from "drizzle-orm";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { audit, runs } from "../db/schema.ts";
import { logError } from "../log.ts";
import { currentTraceId, isOpenedSecret, meter } from "../telemetry/index.ts";
import { AUDIT_ACTIONS, AUDIT_RESOURCES, AUDIT_RESULTS, type AuditAction, type AuditActor, AuditDetails, type AuditResource, type AuditResult } from "./model.ts";

// The one writer of Audit rows (design 6.8). A row that records a database change is written in
// that change's transaction (`recordAudit`), so a change rolled back leaves no row; one that
// records a call outside the database is written after it (`recordAuditAfter`), and a failure to
// write it is logged, never turned into a refusal of the call.

const counts = meter("audit");

/**
 * Rows are listed by `(at, id)`, and rows often share their `at` (one transaction's, or one
 * millisecond's), so ids rise in the order rows are made, within one millisecond too: a plain
 * ULID's random part would order those rows by chance.
 */
const nextUlid = monotonicFactory();

/** Each string of the details is cut here. */
export const MAX_DETAIL = 200;
/** The details, serialized, are cut to this many characters (keys dropped from the end). */
export const MAX_DETAILS = 2000;

/** One row to write. `agentId`: the acting Job's agent (looked up when not given) or the agent a scheduler row is for. */
export type AuditEntry = {
  ownerId: string;
  actor: AuditActor;
  agentId?: string | null;
  jobId?: string | null;
  action: AuditAction;
  resource: { type: AuditResource; id?: string | null };
  result?: AuditResult;
  details?: AuditDetails;
};

const Id = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const Entry = z.object({
  ownerId: Id,
  actor: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("user"), userId: Id }),
    z.strictObject({ type: z.literal("job"), runId: Id }),
    z.strictObject({ type: z.literal("scheduler") }),
  ]),
  agentId: Id.nullish(),
  jobId: Id.nullish(),
  action: z.enum(AUDIT_ACTIONS),
  resource: z.strictObject({ type: z.enum(AUDIT_RESOURCES), id: Id.nullish() }),
  result: z.enum(AUDIT_RESULTS).default("ok"),
  details: AuditDetails.default({}),
});

/** The details as stored: strings cut, any value equal to an opened secret dropped, the whole within `MAX_DETAILS`. */
function cutDetails(details: AuditDetails): AuditDetails {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (isOpenedSecret(value)) continue;
      out[key] = value.slice(0, MAX_DETAIL);
    } else out[key] = value;
  }
  const keys = Object.keys(out);
  while (keys.length > 0 && JSON.stringify(out).length > MAX_DETAILS) delete out[keys.pop()!];
  return out as AuditDetails;
}

async function insert(db: Db | Tx, entry: AuditEntry): Promise<void> {
  // Throws on an entry outside the schema: its transaction fails with it.
  const parsed = Entry.parse(entry);
  const agentId =
    parsed.agentId !== undefined
      ? parsed.agentId
      : parsed.actor.type === "job"
        ? ((await db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, parsed.actor.runId)))[0]?.agentId ?? null)
        : null;
  const resourceId = parsed.resource.id && !isOpenedSecret(parsed.resource.id) ? parsed.resource.id : null;
  await db.insert(audit).values({
    id: `aud_${nextUlid()}`,
    ownerId: parsed.ownerId,
    actor: parsed.actor,
    actorAgentId: agentId,
    jobId: parsed.jobId ?? null,
    action: parsed.action,
    resourceType: parsed.resource.type,
    resourceId,
    result: parsed.result,
    details: cutDetails(parsed.details),
    traceId: currentTraceId() ?? null,
  });
}

/** Writes a row in `tx`, with the change it records. Throws on an invalid entry, so the change fails with it. */
export async function recordAudit(tx: Tx | Db, entry: AuditEntry): Promise<void> {
  await insert(tx, entry);
  counts.counter("dispand.audit.rows").add(1, { "dispand.audit.action": entry.action, "dispand.result": "ok" });
}

/** Writes a row for what already happened outside the database. Never throws: a failure is logged and counted. */
export async function recordAuditAfter(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(db, entry);
  } catch (err) {
    logError("audit write failed", err);
    counts.counter("dispand.audit.rows").add(1, { "dispand.audit.action": String(entry.action), "dispand.result": "failed" });
  }
}
