import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { agents, organizationMembers, type Route, runs, workflows, workspaces } from "../db/schema.ts";
import { escalationRights } from "../agents/escalations.ts";
import { authorize } from "../workspace/authorize.ts";

// Routing: a question a Job asks a person outside a chat (an escalation) goes to one person, hop
// by hop: the member the agent picked (1), else the agent's creator (2), else the organization's
// owner (3). A workflow run has no agent: its creator, then the owner. Each hop's rule is read
// live, here only: when the question is recorded, and at each later use (check at use).

/** What an unattended question gets at once when its agent may not ask a person. */
export const REFUSED_TEXT = "Your agent may not ask a person: decide, or end with what you have";

/** Where a run is, and who its hops may reach, read live. */
type Place = {
  workspaceId: string;
  organizationId: string;
  /** The asking agent; null for a workflow run. */
  agentId: string | null;
  /** The agent's live escalation mode (a workflow run has none). */
  mode: string | null;
  /** The agent's creator, or the workflow's. */
  creator: string | null;
  /** The people the Job could ask at its start (its snapshot). */
  snapshot: string[];
};

async function placeOf(tx: Tx, runId: string): Promise<Place> {
  const [run] = await tx
    .select({
      workspaceId: runs.workspaceId,
      organizationId: workspaces.organizationId,
      agentId: runs.agentId,
      mode: agents.escalateMode,
      agentCreator: agents.ownerId,
      workflowCreator: workflows.ownerId,
      snapshot: runs.snapshot,
    })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(workflows, eq(workflows.id, runs.workflowId))
    .where(eq(runs.id, runId));
  if (!run) throw new Error("no such run");
  return {
    workspaceId: run.workspaceId,
    organizationId: run.organizationId,
    agentId: run.agentId,
    mode: run.agentId ? (run.mode ?? "disabled") : null,
    creator: run.agentId ? run.agentCreator : run.workflowCreator,
    snapshot: (run.snapshot?.escalations ?? []).map((e) => e.userId),
  };
}

async function orgOwner(tx: Tx, organizationId: string): Promise<string | null> {
  const [owner] = await tx.select({ userId: organizationMembers.userId }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, "owner")));
  return owner?.userId ?? null;
}

/** Whether escalation is on for the run: always for a workflow run, which has no agent to set it. */
const enabled = (place: Place) => place.agentId === null || place.mode !== "disabled";

/** Whether `userId` may be asked on `hop` now: the same rule that put them there, read live. */
async function allowed(tx: Tx, place: Place, hop: Route["hop"], userId: string): Promise<boolean> {
  if (!enabled(place)) return false;
  if (hop === 1) return place.agentId !== null && (await escalationRights(tx, place.agentId, userId)).length > 0;
  if (hop === 2 && userId !== place.creator) return false;
  if (hop === 3 && userId !== (await orgOwner(tx, place.organizationId))) return false;
  return (await authorize(tx, userId, place.organizationId, place.workspaceId)) !== null;
}

/** The first hop from `from` on whose person may be asked and wasn't yet, or null when none is left. */
async function hopFrom(tx: Tx, place: Place, from: 2 | 3, reason: Route["reason"], tried: string[]): Promise<{ addresseeId: string; route: Route } | null> {
  for (const hop of from === 2 ? ([2, 3] as const) : ([3] as const)) {
    const userId = hop === 2 ? place.creator : await orgOwner(tx, place.organizationId);
    if (!userId || tried.includes(userId) || !(await allowed(tx, place, hop, userId))) continue;
    const why: Route["reason"] = hop === 3 ? "orgOwner" : place.agentId === null ? "workflow" : reason;
    return { addresseeId: userId, route: { hop, reason: why, tried: [...tried, userId] } };
  }
  return null;
}

/**
 * Where an unattended question of `runId` goes first: the person `to` names when the Job could ask
 * them at its start and may still now (hop 1), else the creator (hop 2, `noFit` with no `to`,
 * `creator` for a refused one, which is never stored), else the organization's owner (hop 3).
 * Null when the run's agent may not ask a person (escalation disabled, read live), whichever tool asked.
 */
export async function firstHop(tx: Tx, runId: string, to: string | undefined): Promise<{ addresseeId: string; route: Route } | null> {
  const place = await placeOf(tx, runId);
  if (!enabled(place)) return null;
  if (to !== undefined && place.snapshot.includes(to) && (await allowed(tx, place, 1, to))) {
    return { addresseeId: to, route: { hop: 1, reason: "picked", tried: [to] } };
  }
  return hopFrom(tx, place, 2, to === undefined ? "noFit" : "creator", []);
}
