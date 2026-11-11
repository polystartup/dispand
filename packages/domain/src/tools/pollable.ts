import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, agentTools, tools } from "../db/schema.ts";

// Polls only read (design 6.7): the scheduler calls a tool outside any Job, so an action it may
// call is one the owner lets polls read, and never one an agent must ask before using.

/** Each of the tool's actions, whether a poll may read it now, and the agents that must ask before using it. */
export async function pollableActions(db: Db | Tx, ownerId: string, toolId: string) {
  const [tool] = await db.select({ actions: tools.actions, pollable: tools.pollable }).from(tools).where(and(eq(tools.id, toolId), eq(tools.ownerId, ownerId)));
  if (!tool) return null;
  const holders = await db
    .select({ name: agents.name, unasked: agentTools.unasked })
    .from(agentTools)
    .innerJoin(agents, eq(agents.id, agentTools.agentId))
    .where(eq(agentTools.toolId, toolId));
  const allowed = new Set(tool.pollable ?? tool.actions.flatMap((a) => (a.readOnly ? [a.name] : [])));
  return tool.actions.map((a) => {
    const askedBy = holders.filter((h) => !h.unasked.includes(a.name)).map((h) => h.name);
    return { name: a.name, readOnly: a.readOnly === true, allowed: allowed.has(a.name), askedBy, pollable: allowed.has(a.name) && askedBy.length === 0 };
  });
}

/** Whether a poll may call `action` of the tool now (checked at a trigger's creation and at every dispatch). */
export async function isPollable(db: Db | Tx, ownerId: string, toolId: string, action: string): Promise<boolean> {
  return (await pollableActions(db, ownerId, toolId))?.find((a) => a.name === action)?.pollable === true;
}
