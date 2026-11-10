import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, agentTools, tools } from "../db/schema.ts";

/**
 * Makes one action of a tool the agent chose (one reached by URL: a runner's own tools have no
 * such flag yet) ask before use, or run without asking. False when
 * the owner has no such agent, tool on it, or action of it. Taking the question away is a grant:
 * the callers are a person's doing (the agent's page, the answer "always allow" to an approval).
 */
export async function setAsk(db: Db, ownerId: string, to: { agentId: string; toolId: string; action: string; ask: boolean }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ actions: tools.actions, unasked: agentTools.unasked })
      .from(agentTools)
      .innerJoin(agents, eq(agents.id, agentTools.agentId))
      .innerJoin(tools, eq(tools.id, agentTools.toolId))
      .where(and(eq(agentTools.agentId, to.agentId), eq(agentTools.toolId, to.toolId), eq(agents.ownerId, ownerId), eq(tools.ownerId, ownerId), eq(tools.kind, "http")))
      .for("update", { of: agentTools });
    if (!row?.actions.some((a) => a.name === to.action)) return false;
    // Only actions the tool still lists stay: one that is gone, should it come back, asks.
    const unasked = row.actions.map((a) => a.name).filter((name) => (name === to.action ? !to.ask : row.unasked.includes(name)));
    await tx.update(agentTools).set({ unasked }).where(and(eq(agentTools.agentId, to.agentId), eq(agentTools.toolId, to.toolId)));
    return true;
  });
}
