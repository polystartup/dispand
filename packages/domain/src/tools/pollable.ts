import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { skillsAndTools } from "../agents/skills-and-tools.ts";
import { agents, agentTools, tools } from "../db/schema.ts";

// Polls only read (design 6.7): the scheduler calls a tool outside any Job, so an action it may
// call is one the owner lets polls read, and never one an agent must ask before using.

/** Each of the tool's actions, whether a poll may read it now, and the agents that must ask before using it. */
export async function pollableActions(db: Db | Tx, ownerId: string, toolId: string) {
  const [tool] = await db.select({ actions: tools.actions, pollable: tools.pollable, disabled: tools.disabled }).from(tools).where(and(eq(tools.id, toolId), eq(tools.ownerId, ownerId)));
  if (!tool) return null;
  // Every agent that holds the tool, chosen or through a skill that requires it; one without a
  // choice of its own asks before every action.
  const owned = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.ownerId, ownerId));
  const chosen = await db.select({ agentId: agentTools.agentId, unasked: agentTools.unasked }).from(agentTools).where(eq(agentTools.toolId, toolId));
  const holders: { name: string; unasked: string[] }[] = [];
  for (const agent of owned) {
    const mine = chosen.find((c) => c.agentId === agent.id);
    if (mine) holders.push({ name: agent.name, unasked: mine.unasked });
    else if ((await skillsAndTools(db, agent.id)).tools.some((t) => t.toolId === toolId)) holders.push({ name: agent.name, unasked: [] });
  }
  const allowed = new Set(tool.pollable ?? tool.actions.flatMap((a) => (a.readOnly ? [a.name] : [])));
  return tool.actions.map((a) => {
    const askedBy = holders.filter((h) => !h.unasked.includes(a.name)).map((h) => h.name);
    return { name: a.name, readOnly: a.readOnly === true, allowed: allowed.has(a.name), askedBy, pollable: !tool.disabled.includes(a.name) && allowed.has(a.name) && askedBy.length === 0, ...(tool.disabled.includes(a.name) ? { disabled: true as const } : {}) };
  });
}

/** Whether a poll may call `action` of the tool now (checked at a trigger's creation and at every dispatch). */
export async function isPollable(db: Db | Tx, ownerId: string, toolId: string, action: string): Promise<boolean> {
  return (await pollableActions(db, ownerId, toolId))?.find((a) => a.name === action)?.pollable === true;
}

/**
 * Why a poll of `agentId` may not call `action` of the tool now, or null when it may: the tool is
 * the owner's, the agent holds it, and the action is pollable. Checked when a poll trigger is
 * made or changed, before each call, before each Job, and before each start of a poll Job's session.
 */
export async function pollProblem(db: Db | Tx, ownerId: string, agentId: string, toolId: string, action: string): Promise<string | null> {
  const [tool] = await db.select({ id: tools.id, disabled: tools.disabled }).from(tools).where(and(eq(tools.id, toolId), eq(tools.ownerId, ownerId)));
  if (!tool) return "The tool no longer exists";
  if (tool.disabled.includes(action)) return "This action is disabled workspace-wide";
  if (!(await skillsAndTools(db, agentId)).tools.some((t) => t.toolId === toolId)) return "The agent doesn't have this tool";
  if (!(await isPollable(db, ownerId, toolId, action))) return "A poll may not read this action: the tool doesn't let polls read it, or an agent must ask before using it";
  return null;
}
