import { MAX_GRANT_TTL_MS, type Grant } from "@dispand/runner-protocol";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { personalGrants, runs, stepRuns, subscriptionEnrollments, workspaces, type Placement } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { emitLog, meter } from "../telemetry/index.ts";
import { liveEnrollments } from "./subscriptions.ts";

// Personal placement: which credential a step's session runs on, and the grants that let a runner
// spend its subscriber's own subscription for one action. We decided the enrolled subscriber's own
// attended actions on that runner use their subscription, and everything else the workspace's
// credential, chosen once when the action is authorized, never switched. The action keeps its actor
// and enrollment; every use (dispatch, a resume, a message, an answer, each relayed request) checks
// both again, read live. A check that fails pauses the action; nothing falls back to another credential.

/**
 * Personal execution's server switch. Off: no step is placed personally, no grant is issued and
 * every check is denied. On: for the CLIs in `OPEN` only; the runner runs a grant only under gVisor.
 */
export const personalSwitch = { on: true };

/** The CLIs a subscription may serve. */
const OPEN: ReadonlySet<string> = new Set(["codex", "claude-code"]);

/** A grant's life between checks: well under the protocol's ceiling, so a revocation the runner missed holds at most this long. */
export const GRANT_TTL_MS = Math.min(5 * 60_000, MAX_GRANT_TTL_MS);

const WORKSPACE: Placement = { kind: "workspace" };
/** The provider whose workspace model key (`clis.modelKeys`) serves each CLI. */
const PROVIDER = { "claude-code": "anthropic", codex: "openai" } as const;
type Kind = keyof typeof PROVIDER;
const ACTIVE = ["running", "waiting"] as const;

/** Why an action can't spend its subscription now. */
export type Paused = "off" | "actor" | "enrollment" | "access" | "ended" | "approver" | "worker";
export type GrantEnd = "superseded" | "paused" | "ended" | "turn-end" | "revoked" | "expired" | "denied";

const counts = meter("runners");

type RunFacts = { source: string; cause: { kind: string } | null; trigger: { type: string }; ownerId: string | null; workspaceId: string };

/**
 * The person whose own attended action this run is: a Job they started by hand. A schedule, a
 * trigger, an event, a poll, a consult, a workflow run (its owner is the workflow's creator) and a
 * Job with no person act for no one here, so they never run on a subscription.
 */
export function attendedActor(run: RunFacts): string | null {
  return run.source === "agent" && run.cause?.kind === "user" && run.trigger.type === "manual" ? run.ownerId : null;
}

async function placeOf(db: Db | Tx, workspaceId: string) {
  const [w] = await db.select({ organizationId: workspaces.organizationId }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return w ? { organizationId: w.organizationId, workspaceId } : null;
}

/** The credential a run's action on this CLI harness gets when it is authorized (decision above). */
export async function placementFor(db: Db | Tx, run: RunFacts, harness: { kind: string; runnerId: string }): Promise<Placement> {
  const actorId = attendedActor(run);
  const place = personalSwitch.on && actorId && OPEN.has(harness.kind) ? await placeOf(db, run.workspaceId) : null;
  if (!place || !actorId) return WORKSPACE;
  const [held] = await liveEnrollments(db, place, and(eq(subscriptionEnrollments.runnerId, harness.runnerId), eq(subscriptionEnrollments.harness, harness.kind as Kind), eq(subscriptionEnrollments.userId, actorId)));
  return held ? { kind: "personal", enrollmentId: held.id, actorId } : WORKSPACE;
}

/**
 * Whether this runner's CLI may serve only its subscriber's own actions: personal execution is on,
 * the CLI's login there is someone's enrolled subscription, and the runner has no workspace model
 * key for that CLI. A workspace-credential action then has nothing to run on.
 */
export async function personalOnly(db: Db | Tx, runner: { id: string; clis: { modelKeys?: string[] } }, kind: string): Promise<boolean> {
  if (!personalSwitch.on || !OPEN.has(kind) || !(kind in PROVIDER) || runner.clis.modelKeys?.includes(PROVIDER[kind as Kind])) return false;
  const [enrolled] = await db.select({ id: subscriptionEnrollments.id }).from(subscriptionEnrollments)
    .where(and(eq(subscriptionEnrollments.runnerId, runner.id), eq(subscriptionEnrollments.harness, kind as Kind))).limit(1);
  return enrolled !== undefined;
}

type Checked = { kind: "workspace" } | { kind: "personal"; enrollmentId: string; actorId: string; runnerId: string; workspaceId: string } | { kind: "paused"; reason: Paused };

/**
 * A step's placement as it may be used now: the workspace's, or its personal one with the same
 * actor and enrollment still holding (the run's person, the enrollment on the step's runner and
 * harness, the person's workspace access, all read now). Anything else pauses it.
 */
export async function checkPlacement(db: Db | Tx, stepRunId: string): Promise<Checked> {
  const [row] = await db.select({ placement: stepRuns.placement, status: stepRuns.status, runnerId: stepRuns.runnerId, harness: stepRuns.harness, run: { source: runs.source, cause: runs.cause, trigger: runs.trigger, ownerId: runs.ownerId, workspaceId: runs.workspaceId } })
    .from(stepRuns).innerJoin(runs, eq(runs.id, stepRuns.runId)).where(eq(stepRuns.id, stepRunId));
  if (row?.placement?.kind !== "personal") return { kind: "workspace" };
  const { enrollmentId, actorId } = row.placement;
  if (!personalSwitch.on || !OPEN.has(row.harness?.kind ?? "")) return { kind: "paused", reason: "off" };
  if (!(ACTIVE as readonly string[]).includes(row.status)) return { kind: "paused", reason: "ended" };
  if (attendedActor(row.run) !== actorId) return { kind: "paused", reason: "actor" };
  const [enrollment] = await db.select({ runnerId: subscriptionEnrollments.runnerId, harness: subscriptionEnrollments.harness, userId: subscriptionEnrollments.userId })
    .from(subscriptionEnrollments).where(eq(subscriptionEnrollments.id, enrollmentId));
  if (!enrollment || enrollment.userId !== actorId || enrollment.runnerId !== row.runnerId || enrollment.harness !== row.harness?.kind) return { kind: "paused", reason: "enrollment" };
  const place = await placeOf(db, row.run.workspaceId);
  const live = place ? await liveEnrollments(db, place, eq(subscriptionEnrollments.id, enrollmentId)) : [];
  if (!live.length) return { kind: "paused", reason: "access" };
  return { kind: "personal", enrollmentId, actorId, runnerId: enrollment.runnerId, workspaceId: row.run.workspaceId };
}

const ends = new Set<(runnerId: string, grantId: string) => void>();

/** Called with each grant that ends, to tell its runner (`grant.end`); returns the unsubscribe. */
export function onGrantEnd(listener: (runnerId: string, grantId: string) => void): () => void {
  ends.add(listener);
  return () => ends.delete(listener);
}

/**
 * Ends the grants `where` matches: deleted, so no check renews them, and their runners told. Told
 * from inside the caller's transaction: a rollback leaves a grant its runner already dropped, which
 * only stops its action (fail closed).
 */
export async function endGrants(db: Db | Tx, where: SQL | undefined, reason: GrantEnd) {
  const ended = await db.delete(personalGrants).where(where).returning({ id: personalGrants.id, runnerId: personalGrants.runnerId });
  for (const g of ended) for (const tell of ends) tell(g.runnerId, g.id);
  if (ended.length) {
    counts.counter("dispand.personal.grants_ended").add(ended.length, { "dispand.grant.end": reason });
    emitLog("runners", "info", "personal grants ended", { "dispand.grant.end": reason, "dispand.count": ended.length });
  }
  return ended;
}

/** Ends the grants of these enrollments (the enrollments ended). */
export const endEnrollmentGrants = (tx: Tx, enrollmentIds: string[]) =>
  enrollmentIds.length ? endGrants(tx, inArray(personalGrants.enrollmentId, enrollmentIds), "revoked") : Promise.resolve([]);

/** The step's grant now, if any: each new one ends the earlier, so there is at most one. */
export async function stepGrant(db: Db | Tx, stepRunId: string): Promise<string | null> {
  const [grant] = await db.select({ id: personalGrants.id }).from(personalGrants).where(eq(personalGrants.stepRunId, stepRunId));
  return grant?.id ?? null;
}

/** Ends a step's grants: its action paused, ended, or its turn did. */
export const endStepGrants = (db: Db | Tx, stepRunId: string, reason: GrantEnd) => endGrants(db, eq(personalGrants.stepRunId, stepRunId), reason);

/**
 * A grant for the step's next start (a first start, a resume), after the checks of `checkPlacement`:
 * a new one each time, ending the step's earlier ones. Null for a workspace-credential step; the
 * reason when it pauses instead. `audit` writes its Audit row in the same transaction.
 */
export async function issueGrant(db: Db, stepRunId: string, audit: (tx: Tx, grant: Grant) => Promise<void>): Promise<{ grant: Grant } | { paused: Paused } | null> {
  const result = await db.transaction(async (tx) => {
    // The step's row first: concurrent starts of one step issue one after the other.
    await tx.select({ id: stepRuns.id }).from(stepRuns).where(eq(stepRuns.id, stepRunId)).for("update");
    const checked = await checkPlacement(tx, stepRunId);
    if (checked.kind === "workspace") return null;
    await endStepGrants(tx, stepRunId, checked.kind === "paused" ? "paused" : "superseded");
    if (checked.kind === "paused") return { paused: checked.reason };
    const id = newId("grant");
    await tx.insert(personalGrants).values({ id, workspaceId: checked.workspaceId, stepRunId, runnerId: checked.runnerId, enrollmentId: checked.enrollmentId, actorId: checked.actorId, expiresAt: new Date(Date.now() + GRANT_TTL_MS) });
    const grant = { id, enrollmentId: checked.enrollmentId, ttlMs: GRANT_TTL_MS };
    await audit(tx, grant);
    return { grant };
  });
  if (result) counts.counter("dispand.personal.grants").add(1, { "dispand.result": "grant" in result ? "issued" : "paused" });
  return result;
}

/**
 * The relay's check of a grant from runner `runnerId`, before a model request or to extend a stream:
 * the same checks as at issue, then a fresh ttl. A grant of another runner, unknown, ended or expired
 * is denied, and an expired or failing one ends: it can't be renewed or reopened.
 */
export async function checkGrant(db: Db, runnerId: string, grantId: string): Promise<number | null> {
  const ttl = await db.transaction(async (tx) => {
    const [grant] = await tx.select().from(personalGrants).where(and(eq(personalGrants.id, grantId), eq(personalGrants.runnerId, runnerId))).for("update");
    if (!grant) return null;
    if (grant.expiresAt.getTime() <= Date.now()) {
      await endGrants(tx, eq(personalGrants.id, grant.id), "expired");
      return null;
    }
    const checked = await checkPlacement(tx, grant.stepRunId);
    if (checked.kind !== "personal" || checked.enrollmentId !== grant.enrollmentId || checked.actorId !== grant.actorId || checked.runnerId !== runnerId) {
      await endGrants(tx, eq(personalGrants.id, grant.id), "denied");
      return null;
    }
    await tx.update(personalGrants).set({ expiresAt: new Date(Date.now() + GRANT_TTL_MS) }).where(eq(personalGrants.id, grant.id));
    return GRANT_TTL_MS;
  });
  counts.counter("dispand.personal.grant_checks").add(1, { "dispand.result": ttl ? "ok" : "denied" });
  return ttl;
}
