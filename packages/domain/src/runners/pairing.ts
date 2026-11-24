import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { recordAudit } from "../audit/record.ts";
import { message } from "../messages/index.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { harnesses, runnerPairings, runners, workspaces } from "../db/schema.ts";
import { requireManager } from "../workspace/people.ts";
import { newId } from "../ids.ts";
import { endRunnerSubscriptions } from "./subscriptions.ts";

type RunnerScope = { organizationId: string; workspaceId: string };

const PAIRING_TTL_MS = 15 * 60 * 1000;
// No 0/O, 1/I/L: the code may be read aloud or typed.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Unknown, used or expired pairing code: the endpoint answers 401 for all three alike. */
export class PairingRefused extends Error {
  override name = "PairingRefused";
}

function sha256(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Creates an unpaired runner and its single-use pairing code (valid 15 minutes). */
export async function createRunner(db: Db, ownerId: string, name: string, scope: RunnerScope) {
  const runnerId = newId("runner");
  const pairingCode = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  await db.transaction(async (tx) => {
    // The registrant's role, checked again when the runner is written.
    const workspaceId = (await requireManager(tx, ownerId, scope)).id;
    await tx.insert(runners).values({ id: runnerId, ownerId, workspaceId, name });
    await recordAudit(tx, { workspaceId, ownerId, actor: { type: "user", userId: ownerId }, action: "workspace.runnerRegistered",
      resource: { type: "workspace", id: workspaceId }, details: { runnerId } });
    await tx.insert(runnerPairings).values({
      id: newId("pair"),
      ownerId,
      runnerId,
      codeHash: sha256(pairingCode),
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
    });
  });
  return { runnerId, pairingCode };
}

/** Exchanges a pairing code (any case, spaces around ignored) for the runner's long-lived token. Throws `PairingRefused`. */
export async function pair(db: Db, code: string): Promise<{ runnerId: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const codeHash = sha256(code.trim().toUpperCase());
  const now = new Date();
  // The code is all there is: its runner's workspace is read under SYSTEM, then the pairing runs in it.
  const [found] = await inScope(SYSTEM, () => db
    .select({ organizationId: workspaces.organizationId, workspaceId: workspaces.id })
    .from(runnerPairings)
    .innerJoin(runners, eq(runners.id, runnerPairings.runnerId))
    .innerJoin(workspaces, eq(workspaces.id, runners.workspaceId))
    .where(eq(runnerPairings.codeHash, codeHash)));
  if (!found) throw new PairingRefused();
  return inScope(found, () => db.transaction(async (tx) => {
    // Lock order, shared with `revokeRunner`: the runner row first, then its pairing codes.
    // Opposite orders deadlock on Postgres, and an aborted revoke would leave the new token valid.
    const [pairing] = await tx
      .select({ runnerId: runnerPairings.runnerId })
      .from(runnerPairings)
      .where(eq(runnerPairings.codeHash, codeHash));
    if (!pairing) throw new PairingRefused();
    const [runner] = await tx
      .select({ id: runners.id })
      .from(runners)
      .where(and(eq(runners.id, pairing.runnerId), isNull(runners.revokedAt)))
      .for("update");
    if (!runner) throw new PairingRefused();
    // Marking the code used in the same statement that checks it makes it single-use under concurrency.
    const [used] = await tx
      .update(runnerPairings)
      .set({ usedAt: now })
      .where(and(eq(runnerPairings.codeHash, codeHash), isNull(runnerPairings.usedAt), gt(runnerPairings.expiresAt, now)))
      .returning({ runnerId: runnerPairings.runnerId });
    if (!used) throw new PairingRefused();
    await tx.update(runners).set({ tokenHash: sha256(token) }).where(eq(runners.id, runner.id));
    return { runnerId: runner.id, token };
  }));
}

/**
 * The live runner a token belongs to, with the scope of its workspace, or null (unknown or
 * revoked). The lookup runs under SYSTEM: the token is all there is. What the runner then does runs in `scope`.
 */
export async function findRunnerByToken(db: Db, token: string) {
  const hash = sha256(token);
  const [runner] = await inScope(SYSTEM, () => db
    .select({ id: runners.id, ownerId: runners.ownerId, workspaceId: workspaces.id, organizationId: workspaces.organizationId, tokenHash: runners.tokenHash, lastSeq: runners.lastSeq })
    .from(runners)
    .innerJoin(workspaces, eq(workspaces.id, runners.workspaceId))
    .where(and(eq(runners.tokenHash, hash), isNull(runners.revokedAt))));
  if (!runner?.tokenHash || !timingSafeEqual(Buffer.from(runner.tokenHash, "hex"), Buffer.from(hash, "hex"))) return null;
  const { id, ownerId, workspaceId, organizationId, lastSeq } = runner;
  return { id, ownerId, workspaceId, lastSeq, scope: { organizationId, workspaceId } };
}

/**
 * Revokes a runner of the workspace, whoever registered it, for its manager (re-checked here): its
 * token and pending codes stop working. Returns false if not found.
 */
export async function revokeRunner(db: Db, ownerId: string, runnerId: string, scope: RunnerScope): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const target = eq(runners.workspaceId, (await requireManager(tx, ownerId, scope)).id);
    // Lock order, shared with `pair`: the runner row first (this update), then its pairing codes.
    const [runner] = await tx
      .update(runners)
      .set({ revokedAt: now, tokenHash: null })
      .where(and(eq(runners.id, runnerId), target, isNull(runners.revokedAt)))
      .returning({ id: runners.id });
    if (!runner) return false;
    const [used] = await tx.select({ id: harnesses.id }).from(harnesses).where(eq(harnesses.runnerId, runnerId)).limit(1);
    if (used) throw new ORPCError("CONFLICT", message("runners.usedByHarness"));
    await endRunnerSubscriptions(tx, runnerId, ownerId);
    await recordAudit(tx, { workspaceId: scope.workspaceId, ownerId, actor: { type: "user", userId: ownerId }, action: "workspace.runnerRevoked",
      resource: { type: "workspace", id: scope.workspaceId }, details: { runnerId } });
    await tx
      .update(runnerPairings)
      .set({ usedAt: now })
      .where(and(eq(runnerPairings.runnerId, runnerId), isNull(runnerPairings.usedAt)));
    return true;
  });
}
