import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runs } from "../db/schema.ts";
import { secretAad, SecretError, type SecretBox } from "../secrets.ts";
import type { JobIdentity } from "./call.ts";

// A Job's token: what its session presents to the Job endpoint. Random, per Job, dead with the
// Job. The database keeps its hash (to find the Job) and its sealed form (to hand it to the
// Job's sessions, at each start), never the token itself.

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const aad = (runId: string) => secretAad("runs", runId, "token");

/** A new token for the Job `runId`, with what the run's row stores of it. */
export function issueJobToken(secrets: SecretBox, runId: string): { token: string; hash: string; sealed: string } {
  const token = `dj_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashOf(token), sealed: secrets.seal(token, aad(runId)) };
}

/** The Job's token, opened from its run; null when it has none (or it wasn't sealed for this run). */
export function jobTokenOf(secrets: SecretBox, run: { id: string; tokenSealed: string | null }): string | null {
  if (!run.tokenSealed) return null;
  try {
    return secrets.open(run.tokenSealed, aad(run.id));
  } catch (err) {
    if (err instanceof SecretError) return null;
    throw err;
  }
}

/** The Job a token names, while that Job is still going. */
export async function jobOfToken(db: Db, token: string): Promise<JobIdentity | null> {
  if (!token.startsWith("dj_")) return null;
  const hash = hashOf(token);
  const [run] = await db
    .select({ id: runs.id, ownerId: runs.ownerId, agentId: runs.agentId, tokenHash: runs.tokenHash })
    .from(runs)
    .where(and(eq(runs.tokenHash, hash), eq(runs.source, "agent"), inArray(runs.status, ["running", "waiting"])));
  if (!run?.agentId || !run.tokenHash) return null;
  // The lookup is by hash; the comparison itself takes the same time whatever the stored value.
  if (!timingSafeEqual(Buffer.from(run.tokenHash), Buffer.from(hash))) return null;
  return { runId: run.id, ownerId: run.ownerId, agentId: run.agentId };
}
