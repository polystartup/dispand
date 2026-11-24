import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { agents, organizationMembers, type Route, runs, workflows, workspaces } from "../db/schema.ts";
import { escalationRights } from "../agents/escalations.ts";
import { authorize } from "../workspace/authorize.ts";

// Routing: a question a run asks a person outside a chat goes to one person, hop by hop. A run a
// person started, or a Job of their Stem, asks them first (0), whatever its agent's "May escalate"
// says: asking the starter isn't escalation, as in a chat. Past them, or for a run no person started, it is an escalation:
// the member the agent picked (1), else the agent's creator (2), else the organization's owner
// (3), and only while escalation is on. A workflow run has no agent: its creator, then the owner.
// Each hop's rule is read live, here only: when the question is recorded, and at each later use
// (check at use).

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
  /** The person the run is for (`starterOf`); null for an unattended one. */
  starter: string | null;
};

async function placeOf(tx: Tx, runId: string): Promise<Place> {
  const [run] = await tx
    .select({
      workspaceId: runs.workspaceId,
      organizationId: workspaces.organizationId,
      agentId: runs.agentId,
      mode: agents.escalateMode,
      agentCreator: agents.ownerId,
      builtIn: agents.builtIn,
      workflowCreator: workflows.ownerId,
      snapshot: runs.snapshot,
      person: runs.ownerId,
      cause: runs.cause,
      trigger: runs.trigger,
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
    starter: starterOf(run),
  };
}

/**
 * Who a run is for, asked first outside a chat: a person's Stem (their Assistant) acts for them, so
 * its Jobs are theirs whatever started them (a chat, its scheduled review, a plugin update's
 * conflicts); any other run, the person who started it by hand. A run records a person in other
 * cases too (a consulted Job, a schedule's workflow run): those have none.
 */
function starterOf(run: { agentId: string | null; builtIn: string | null; agentCreator: string | null; person: string | null; cause: { kind: string } | null; trigger: { type: string } }): string | null {
  if (run.builtIn === "assistant") return run.agentCreator;
  return (run.agentId ? run.cause?.kind === "user" : run.trigger.type === "manual") ? run.person : null;
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
  // The starter is asked whatever the mode: they started the run.
  if (hop === 0) return userId === place.starter && (await authorize(tx, userId, place.organizationId, place.workspaceId)) !== null;
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
 * Where a question of `runId` outside a chat goes first: the person who started the run while they
 * are a member (hop 0), whatever the mode and whatever `to` names. Else, as an escalation: the
 * person `to` names when the Job could ask them at its start and may still now (hop 1), else the
 * creator (hop 2, `noFit` with no `to`, `creator` for a refused one, which is never stored), else
 * the organization's owner (hop 3). Null when it would escalate and the run's agent may not ask a
 * person (escalation disabled, read live), whichever tool asked.
 */
export async function firstHop(tx: Tx, runId: string, to: string | undefined): Promise<{ addresseeId: string; route: Route } | null> {
  const place = await placeOf(tx, runId);
  if (place.starter && (await allowed(tx, place, 0, place.starter))) return { addresseeId: place.starter, route: { hop: 0, reason: "starter", tried: [place.starter] } };
  if (!enabled(place)) return null;
  if (to !== undefined && place.snapshot.includes(to) && (await allowed(tx, place, 1, to))) {
    return { addresseeId: to, route: { hop: 1, reason: "picked", tried: [to] } };
  }
  return hopFrom(tx, place, 2, to === undefined ? "noFit" : "creator", []);
}

/** How long each hop has to answer before the sweep moves the question on. */
export const HOP_MS = 72 * 60 * 60 * 1000;
/** The deadline of a hop starting now. */
export const answerBy = (now = new Date()) => new Date(now.getTime() + HOP_MS);

/** What a question that no hop can take any more is answered, in each of its questions' slot. */
export const NOBODY_TEXT = "Nobody answered this question: decide, or end with what you have";

type Escalation = { runId: string; addresseeId: string | null; route: Route | null };

/**
 * Whether a routed question's addressee may still be asked, read live: the rule that put them on
 * their hop (for an escalation, with escalation still enabled). True for any other question (no route).
 */
export async function qualifies(tx: Tx, q: Escalation): Promise<boolean> {
  if (!q.route || !q.addresseeId) return true;
  return allowed(tx, await placeOf(tx, q.runId), q.route.hop, q.addresseeId);
}

/**
 * Where a routed question that failed its check goes: the next hop whose person may be asked and
 * wasn't (`route.tried` skipped, so no one is asked twice), or a text to settle it with when
 * escalation is now disabled or no hop is left. Past the starter (hop 0), it escalates as a
 * question with nobody named would: the creator, then the organization's owner, only while
 * escalation is on, else the agent gets the refusal.
 */
export async function nextMove(tx: Tx, q: Escalation & { route: Route }): Promise<{ addresseeId: string; route: Route } | { settle: string }> {
  const place = await placeOf(tx, q.runId);
  if (!enabled(place)) return { settle: REFUSED_TEXT };
  const next = q.route.hop === 3 ? null : await hopFrom(tx, place, q.route.hop === 2 ? 3 : 2, q.route.hop === 0 ? "noFit" : "creator", q.route.tried);
  return next ?? { settle: NOBODY_TEXT };
}
