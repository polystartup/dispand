import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, organizationMembers, runs, workspaces } from "../db/schema.ts";
import { authorize } from "../workspace/authorize.ts";

/**
 * Who a run's question goes to: the run's person; for a run with none (an agent's unattended
 * Job), the agent's creator while they may still open the run's workspace, else the
 * organization's owner. Read when the question is made.
 */
export async function addresseeOf(db: Db | Tx, runId: string): Promise<string> {
  const [run] = await db
    .select({ ownerId: runs.ownerId, creator: agents.ownerId, workspaceId: runs.workspaceId, organizationId: workspaces.organizationId })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(eq(runs.id, runId));
  if (!run) throw new Error("no such run");
  if (run.ownerId) return run.ownerId;
  if (run.creator && (await authorize(db, run.creator, run.organizationId, run.workspaceId))) return run.creator;
  const [owner] = await db.select({ userId: organizationMembers.userId }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, run.organizationId), eq(organizationMembers.role, "owner")));
  if (!owner) throw new Error("an organization has an owner");
  return owner.userId;
}
