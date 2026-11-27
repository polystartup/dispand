import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { runners, subscriptionEnrollments, workspaces } from "../db/schema.ts";
import { authorize } from "../workspace/authorize.ts";

// Apart from `subscriptions.ts`: `grants.ts` reads it too, and `subscriptions.ts` imports `grants.ts`.

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
