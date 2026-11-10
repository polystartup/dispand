import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runnerPairings, runners } from "../db/schema.ts";
import { newId } from "../ids.ts";

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
export async function createRunner(db: Db, ownerId: string, name: string) {
  const runnerId = newId("runner");
  const pairingCode = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  await db.transaction(async (tx) => {
    await tx.insert(runners).values({ id: runnerId, ownerId, name });
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
  return db.transaction(async (tx) => {
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
  });
}

/** The live runner a token belongs to, or null (unknown or revoked). */
export async function findRunnerByToken(db: Db, token: string) {
  const hash = sha256(token);
  const [runner] = await db
    .select({ id: runners.id, ownerId: runners.ownerId, tokenHash: runners.tokenHash, lastSeq: runners.lastSeq })
    .from(runners)
    .where(and(eq(runners.tokenHash, hash), isNull(runners.revokedAt)));
  if (!runner?.tokenHash || !timingSafeEqual(Buffer.from(runner.tokenHash, "hex"), Buffer.from(hash, "hex"))) return null;
  return { id: runner.id, ownerId: runner.ownerId, lastSeq: runner.lastSeq };
}

/** Revokes the owner's runner: its token and pending codes stop working. Returns false if not found. */
export async function revokeRunner(db: Db, ownerId: string, runnerId: string): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (tx) => {
    // Lock order, shared with `pair`: the runner row first (this update), then its pairing codes.
    const [runner] = await tx
      .update(runners)
      .set({ revokedAt: now, tokenHash: null })
      .where(and(eq(runners.id, runnerId), eq(runners.ownerId, ownerId), isNull(runners.revokedAt)))
      .returning({ id: runners.id });
    if (!runner) return false;
    await tx
      .update(runnerPairings)
      .set({ usedAt: now })
      .where(and(eq(runnerPairings.runnerId, runnerId), isNull(runnerPairings.usedAt)));
    return true;
  });
}
