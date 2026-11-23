import { and, eq, exists, isNull, ne, or, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { skillsAndTools } from "../agents/skills-and-tools.ts";
import { heldUnasked, strictTargets } from "../agents/tool-ask.ts";
import { agents, agentTools, runners, tools } from "../db/schema.ts";
import { type Message, say, stored } from "../messages/index.ts";

// Polls only read (design 6.7): the scheduler calls a tool outside any Job, so an action it may
// call is one the workspace lets polls read, and never one an agent must ask before using.

/** Each of the tool's actions, whether a poll may read it now, and the agents that must ask before using it. */
export async function pollableActions(db: Db | Tx, workspaceId: string, toolId: string) {
  const [tool] = await db.select().from(tools).where(and(eq(tools.id, toolId), eq(tools.workspaceId, workspaceId)));
  if (!tool) return null;
  // Every agent that holds the tool, chosen or through a skill that requires it; one without a
  // choice of its own asks before every action.
  const owned = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.workspaceId, workspaceId));
  const chosen = await db.select({ agentId: agentTools.agentId, unasked: agentTools.unasked, strictTarget: agentTools.strictTarget }).from(agentTools).where(eq(agentTools.toolId, toolId));
  const holders: { name: string; unasked: string[] }[] = [];
  for (const agent of owned) {
    const mine = chosen.find((c) => c.agentId === agent.id);
    // Under strict permissions, only the grants that still hold (`heldUnasked`), as in its Jobs.
    if (mine) holders.push({ name: agent.name, unasked: heldUnasked(await strictTargets(db, workspaceId, agent.id, [tool], []), mine, tool) });
    else if ((await skillsAndTools(db, agent.id)).tools.some((t) => t.toolId === toolId)) holders.push({ name: agent.name, unasked: [] });
  }
  const allowed = new Set(tool.pollable ?? tool.actions.flatMap((a) => (a.readOnly ? [a.name] : [])));
  return tool.actions.map((a) => {
    const askedBy = holders.filter((h) => !h.unasked.includes(a.name)).map((h) => h.name);
    return { name: a.name, readOnly: a.readOnly === true, allowed: allowed.has(a.name), askedBy, pollable: !tool.disabled.includes(a.name) && allowed.has(a.name) && askedBy.length === 0, ...(tool.disabled.includes(a.name) ? { disabled: true as const } : {}) };
  });
}

/** Whether a poll may call `action` of the tool now (checked at a trigger's creation and at every dispatch). */
export async function isPollable(db: Db | Tx, workspaceId: string, toolId: string, action: string): Promise<boolean> {
  return (await pollableActions(db, workspaceId, toolId))?.find((a) => a.name === action)?.pollable === true;
}

/**
 * Why a poll of `agentId` may not call `action` of the tool now, or null when it may: the tool is
 * of the agent's workspace, the agent holds it, and the action is pollable. Checked when a poll trigger is
 * made or changed, before each call, before each Job, and before each start of a poll Job's session.
 */
export async function pollProblem(db: Db | Tx, agentId: string, toolId: string, action: string, jobWorkspaceId?: string): Promise<Message | null> {
  const [agent] = await db.select({ workspaceId: agents.workspaceId }).from(agents).where(eq(agents.id, agentId));
  if (!agent) return say("tools.poll.agentLacks");
  const placed = exists(db.select({ id: runners.id }).from(runners)
    .where(and(eq(runners.id, tools.runnerId), eq(runners.workspaceId, agent.workspaceId), isNull(runners.revokedAt), jobWorkspaceId ? eq(runners.workspaceId, jobWorkspaceId) : undefined)));
  return toolPollProblem(db, agent.workspaceId, toolId, action, async () => (await skillsAndTools(db, agentId)).tools.some((t) => t.toolId === toolId), placed);
}

/** `pollProblem` as the stored message a record keeps (a skipped poll's or item's reason). */
export async function pollProblemText(db: Db | Tx, agentId: string, toolId: string, action: string): Promise<string | null> {
  const problem = await pollProblem(db, agentId, toolId, action);
  return problem && stored(problem.key, problem.values);
}

/** `pollProblem` for an agent that isn't made yet: `holds` says whether it will have the tool. */
export async function toolPollProblem(db: Db | Tx, workspaceId: string, toolId: string, action: string, holds: () => boolean | Promise<boolean>, placed?: SQL): Promise<Message | null> {
  const [tool] = await db.select({ id: tools.id, disabled: tools.disabled }).from(tools).where(and(eq(tools.id, toolId), eq(tools.workspaceId, workspaceId), placed && or(ne(tools.kind, "runner"), placed)));
  if (!tool) return say("tools.poll.gone");
  if (tool.disabled.includes(action)) return say("tools.poll.disabled");
  if (!(await holds())) return say("tools.poll.agentLacks");
  if (!(await isPollable(db, workspaceId, toolId, action))) return say("tools.poll.notReadable");
  return null;
}
