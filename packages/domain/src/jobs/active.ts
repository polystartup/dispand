import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { agents, runs } from "../db/schema.ts";

/**
 * Before agents are deleted, in the transaction that deletes them: locks them, so a Job being
 * created (which locks its agent to share) is seen or waits and then finds no agent, and gives
 * the name of one whose Job is still going. A deleted agent takes its Jobs with it, so it must
 * have none under a live session.
 */
export async function lockAgentsForDelete(tx: Tx, agentIds: string[]): Promise<string | undefined> {
  if (agentIds.length === 0) return undefined;
  await tx.select({ id: agents.id }).from(agents).where(inArray(agents.id, agentIds)).for("update");
  const [busy] = await tx
    .select({ name: agents.name })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(inArray(runs.agentId, agentIds), inArray(runs.status, ["running", "waiting"])))
    .limit(1);
  return busy?.name;
}
