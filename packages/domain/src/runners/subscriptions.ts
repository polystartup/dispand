import { createHash, randomBytes } from "node:crypto";
import type { SubscriptionStatus } from "@dispand/runner-protocol";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record.ts";
import type { Db, Tx } from "../db/client.ts";
import { runners, subscriptionChallenges, subscriptionEnrollments, workspaces } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { message } from "../messages/index.ts";
import { base, member } from "../rpc/context.ts";
import { emitLog, meter } from "../telemetry/index.ts";
import { authorize } from "../workspace/authorize.ts";
import { endEnrollmentGrants } from "./grants.ts";

// Personal CLI subscriptions: a person enrolls the subscription signed in on a runner with two
// proofs, a challenge they start in their Dispand session and confirm on that runner. The binding
// is a row; it ends (the row is deleted) when the runner reports another provider identity, the
// runner is revoked, the person is removed or revokes it. Every reader also checks the person's
// access and the runner at use, so nothing relies on a stored flag. Its grants (`grants.ts`) end with it.

const counts = meter("runners");
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

type Harness = SubscriptionStatus["harness"];
type Ended = "identity-changed" | "access-lost" | "runner-revoked" | "revoked" | "replaced";

const sha256 = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Deletes the enrollments `where` matches, with an Audit row for each: why it ended and who ended it (`by`, else its subscriber). */
export async function endEnrollments(tx: Tx, where: SQL | undefined, reason: Ended, by?: string) {
  const ended = await tx.delete(subscriptionEnrollments).where(where)
    .returning({ id: subscriptionEnrollments.id, workspaceId: subscriptionEnrollments.workspaceId, runnerId: subscriptionEnrollments.runnerId, userId: subscriptionEnrollments.userId });
  await endEnrollmentGrants(tx, ended.map((e) => e.id));
  for (const e of ended) {
    const actor = by ?? e.userId;
    await recordAudit(tx, { workspaceId: e.workspaceId, ownerId: actor, actor: { type: "user", userId: actor }, action: "workspace.subscriptionEnded",
      resource: { type: "workspace", id: e.workspaceId }, details: { runnerId: e.runnerId, userId: e.userId, reason } });
  }
  if (ended.length) {
    counts.counter("dispand.runner.subscriptions_ended").add(ended.length, { "dispand.subscription.end": reason });
    emitLog("runners", "info", "personal subscriptions ended", { "dispand.subscription.end": reason, "dispand.count": ended.length });
  }
}

/** Ends everything the person holds in these workspaces: their enrollments and pending challenges (they lost access there). */
export async function endPersonSubscriptions(tx: Tx, workspaceIds: string[], userId: string, by: string) {
  if (!workspaceIds.length) return;
  await tx.delete(subscriptionChallenges).where(and(inArray(subscriptionChallenges.workspaceId, workspaceIds), eq(subscriptionChallenges.userId, userId)));
  await endEnrollments(tx, and(inArray(subscriptionEnrollments.workspaceId, workspaceIds), eq(subscriptionEnrollments.userId, userId)), "access-lost", by);
}

/** Ends what a revoked runner held. */
export async function endRunnerSubscriptions(tx: Tx, runnerId: string, by: string) {
  await tx.delete(subscriptionChallenges).where(eq(subscriptionChallenges.runnerId, runnerId));
  await endEnrollments(tx, eq(subscriptionEnrollments.runnerId, runnerId), "runner-revoked", by);
}

/**
 * The runner reported its signed-in subscriptions (`hello`, `clis.replied`): an enrollment whose
 * harness now reports another identity, or none, ends. A fresh sign-in needs a fresh enrollment.
 */
export async function reportedSubscriptions(db: Db, runnerId: string, reported: SubscriptionStatus[]) {
  const held = await db.select({ id: subscriptionEnrollments.id, harness: subscriptionEnrollments.harness, identity: subscriptionEnrollments.identity, signInNeeded: subscriptionEnrollments.signInNeeded })
    .from(subscriptionEnrollments).where(eq(subscriptionEnrollments.runnerId, runnerId));
  const same = (e: (typeof held)[number]) => reported.find((r) => r.harness === e.harness && r.identity === e.identity);
  const changed = held.filter((e) => !same(e)).map((e) => e.id);
  if (changed.length) await db.transaction((tx) => endEnrollments(tx, inArray(subscriptionEnrollments.id, changed), "identity-changed"));
  // The ones that hold keep the runner's word on whether their login must be signed in again.
  for (const e of held) {
    const signInNeeded = same(e)?.signInNeeded;
    if (signInNeeded === undefined || signInNeeded === e.signInNeeded) continue;
    await db.update(subscriptionEnrollments).set({ signInNeeded }).where(eq(subscriptionEnrollments.id, e.id));
    counts.counter("dispand.runner.subscription_sign_ins").add(1, { "dispand.result": signInNeeded ? "needed" : "ok" });
    emitLog("runners", "info", "personal subscription sign-in state", { "dispand.runner.id": runnerId, "dispand.result": signInNeeded ? "needed" : "ok" });
  }
}

/**
 * Confirms a challenge typed on the runner that sent it (in that runner's workspace scope): binds the
 * person who started it, if they still have access there, to this runner, harness and identity, in
 * place of any enrollment of that harness on it. Returns the enrollment's id, or null: a challenge
 * unknown, used, expired or started for another runner of the workspace binds nothing, and it is spent all the same.
 */
export async function confirmEnrollment(db: Db, runner: { id: string; organizationId: string; workspaceId: string }, ask: { harness: Harness; identity: string; challenge: string }): Promise<string | null> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    // Lock order, shared with `revokeRunner`: the runner row first, then its challenges.
    const [live] = await tx.select({ id: runners.id }).from(runners).where(and(eq(runners.id, runner.id), isNull(runners.revokedAt))).for("update");
    if (!live) return null;
    // Spent in the statement that reads it, so a replay or a concurrent confirm finds it used.
    const [challenge] = await tx.update(subscriptionChallenges).set({ usedAt: now })
      .where(and(eq(subscriptionChallenges.codeHash, sha256(ask.challenge)), eq(subscriptionChallenges.workspaceId, runner.workspaceId), isNull(subscriptionChallenges.usedAt)))
      .returning({ runnerId: subscriptionChallenges.runnerId, workspaceId: subscriptionChallenges.workspaceId, userId: subscriptionChallenges.userId, expiresAt: subscriptionChallenges.expiresAt });
    if (!challenge || challenge.runnerId !== runner.id || challenge.workspaceId !== runner.workspaceId || challenge.expiresAt <= now) return null;
    if (!(await authorize(tx, challenge.userId, runner.organizationId, runner.workspaceId))) return null;
    await endEnrollments(tx, and(eq(subscriptionEnrollments.runnerId, runner.id), eq(subscriptionEnrollments.harness, ask.harness)), "replaced", challenge.userId);
    const id = newId("enr");
    await tx.insert(subscriptionEnrollments).values({ id, workspaceId: runner.workspaceId, runnerId: runner.id, userId: challenge.userId, harness: ask.harness, identity: ask.identity });
    await recordAudit(tx, { workspaceId: runner.workspaceId, ownerId: challenge.userId, actor: { type: "user", userId: challenge.userId }, action: "workspace.subscriptionEnrolled",
      resource: { type: "workspace", id: runner.workspaceId }, details: { runnerId: runner.id, userId: challenge.userId } });
    return id;
  });
  counts.counter("dispand.runner.enrollments").add(1, { "dispand.result": result ? "ok" : "refused" });
  emitLog("runners", "info", "personal subscription enrollment", { "dispand.runner.id": runner.id, "dispand.result": result ? "ok" : "refused" });
  return result;
}

/**
 * The workspace's enrollments that hold now: on a live runner, for a person who has access to the
 * workspace at this moment (read live, never cached). What anything that uses an enrollment reads.
 */
export async function liveEnrollments(db: Db | Tx, place: { organizationId: string; workspaceId: string }, where?: SQL) {
  const rows = await db.select({ id: subscriptionEnrollments.id, runnerId: subscriptionEnrollments.runnerId, userId: subscriptionEnrollments.userId, harness: subscriptionEnrollments.harness, identity: subscriptionEnrollments.identity, signInNeeded: subscriptionEnrollments.signInNeeded, createdAt: subscriptionEnrollments.createdAt })
    .from(subscriptionEnrollments)
    .innerJoin(runners, and(eq(runners.id, subscriptionEnrollments.runnerId), isNull(runners.revokedAt)))
    .innerJoin(workspaces, and(eq(workspaces.id, subscriptionEnrollments.workspaceId), eq(workspaces.organizationId, place.organizationId)))
    .where(and(eq(subscriptionEnrollments.workspaceId, place.workspaceId), where))
    .orderBy(asc(subscriptionEnrollments.createdAt), asc(subscriptionEnrollments.id));
  const allowed = new Map<string, boolean>();
  for (const u of new Set(rows.map((r) => r.userId))) allowed.set(u, (await authorize(db, u, place.organizationId, place.workspaceId)) !== null);
  return rows.filter((r) => allowed.get(r.userId));
}

// A person's own: never a Job's, and never on someone else's behalf.
const person = base.use(member).use(async ({ context, next }) => {
  if (context.jobPlace) throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  return next();
});

/** Starts an enrollment on a live runner of the workspace, for the caller only: the challenge to type on that runner. */
const startEnrollment = person.input(z.object({ runnerId: z.string() })).handler(async ({ input, context }) => {
  const { workspaceId } = context.access;
  const [runner] = await context.db.select({ id: runners.id }).from(runners)
    .where(and(eq(runners.id, input.runnerId), eq(runners.workspaceId, workspaceId), isNull(runners.revokedAt)));
  if (!runner) throw new ORPCError("NOT_FOUND", message("tools.runnerNotFound"));
  const challenge = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  // The caller's earlier challenges for this runner and every expired one go: a person has one pending per runner.
  await context.db.delete(subscriptionChallenges).where(and(eq(subscriptionChallenges.workspaceId, workspaceId),
    or(lt(subscriptionChallenges.expiresAt, new Date()), and(eq(subscriptionChallenges.runnerId, runner.id), eq(subscriptionChallenges.userId, context.actorId)))));
  await context.db.insert(subscriptionChallenges).values({ id: newId("chal"), workspaceId, runnerId: runner.id, userId: context.actorId, codeHash: sha256(challenge), expiresAt });
  counts.counter("dispand.runner.enrollment_challenges").add(1);
  emitLog("runners", "info", "personal subscription enrollment started", { "dispand.runner.id": runner.id });
  return { challenge, expiresAt };
});

/**
 * The workspace's live enrollments: which runner and harness, and whether it is the caller's. Never the
 * identity, never whose it is otherwise. `signInNeeded` (the runner's login must be signed in again
 * there) for the caller's own, and for a manager on every one.
 */
const subscriptions = base.use(member).handler(async ({ context }) => {
  const managing = !context.jobPlace && (context.access.role === "owner" || context.access.role === "manager");
  return (await liveEnrollments(context.db, context.access)).map((e) => {
    const mine = e.userId === context.actorId;
    return { id: e.id, runnerId: e.runnerId, harness: e.harness, mine, createdAt: e.createdAt, ...(mine || managing ? { signInNeeded: e.signInNeeded } : {}) };
  });
});

/** Ends the caller's own enrollment. Someone else's is NOT_FOUND, a manager's call included. */
const endSubscription = person.input(z.object({ enrollmentId: z.string() })).handler(async ({ input, context }) => {
  const own = and(eq(subscriptionEnrollments.id, input.enrollmentId), eq(subscriptionEnrollments.workspaceId, context.access.workspaceId), eq(subscriptionEnrollments.userId, context.actorId));
  const ended = await context.db.transaction(async (tx) => {
    const [row] = await tx.select({ id: subscriptionEnrollments.id }).from(subscriptionEnrollments).where(own);
    if (row) await endEnrollments(tx, own, "revoked");
    return row !== undefined;
  });
  if (!ended) throw new ORPCError("NOT_FOUND", message("runners.subscriptionNotFound"));
});

export const subscriptionProcedures = { startEnrollment, subscriptions, endSubscription };

