import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, chatQueue, cloudSessions, eventFires, events, messages, pollItems, questions, roots, runs, schedules, stepRuns, triggers, workflows, workspaces, type RunStatus } from "../db/schema.ts";
import { inScope, SYSTEM, type Scope } from "../db/scope.ts";
import { ACTIVE_STEP } from "./step-lifecycle.ts";

// Background work that spans workspaces runs per workspace through `eachScope`: these listings say
// which workspaces have work due, read under SYSTEM (ids, workspace ids, status and scheduling
// columns only). Each one is built from the predicates of the claim or recovery listing it feeds,
// exported here and used there, so the two can't drift apart.

export const ACTIVE_RUN: RunStatus[] = ["running", "waiting"];

export const dueSchedule = (now: Date) => and(eq(schedules.enabled, true), lte(schedules.nextFireAt, now));
export const dueTrigger = (kind: "schedule" | "poll", now: Date) => and(eq(triggers.kind, kind), eq(triggers.enabled, true), lte(triggers.nextFireAt, now));
/** An event's root is paused (or absent: a person's write before its first Job). */
export const notPaused = or(isNull(roots.state), ne(roots.state, "paused"));
export const dueEvent = and(isNull(events.processedAt), notPaused);
export const deferredEventFire = eq(eventFires.status, "deferred");
export const deferredPollItem = eq(pollItems.status, "deferred");

export const pendingChat = eq(chatQueue.state, "pending");
export const queuedStep = isNotNull(stepRuns.queuedAt);
export const activeRun = inArray(runs.status, ACTIVE_RUN);
/** An idle chat with nothing to deliver, answer or run after it. Used only inside its workspace. */
export const idleChat = and(
  eq(stepRuns.status, "running"), eq(stepRuns.turnStatus, "idle"), isNotNull(stepRuns.idleSince),
  eq(stepRuns.working, false), isNull(stepRuns.queuedAt), isNull(stepRuns.pendingAction),
  isNull(stepRuns.resumeAfterSession), isNull(stepRuns.codexInputId),
  sql`${stepRuns.start} @> '{"interactive":true}' and ${stepRuns.start}->'expectedOutputs' = '[]'::jsonb`,
  sql`not exists (select 1 from ${messages} where ${messages.stepRunId} = ${stepRuns.id} and ${messages.role} = 'user' and ${messages.deliveredAt} is null)`,
  sql`not exists (select 1 from ${questions} where ${questions.runId} = ${stepRuns.runId} and
    (${questions.status} = 'pending' or (${questions.status} = 'answered' and ${questions.sessionId} = ${stepRuns.sessionId} and ${questions.deliveredAt} is null)))`,
  sql`not exists (select 1 from ${chatQueue} where ${chatQueue.stepRunId} = ${stepRuns.id} and
    (${chatQueue.state} in ('pending', 'steering') or (${chatQueue.state} = 'dispatched' and ${chatQueue.ackedAt} is null)))`,
  sql`not exists (select 1 from ${stepRuns} other where other.run_id = ${stepRuns.runId} and other.id <> ${stepRuns.id} and other.status not in ('succeeded', 'skipped'))`,
);
/** Handed a slot to deliver answers and messages, or to resume. */
export const handedStep = and(eq(stepRuns.working, true), sql`${stepRuns.pendingAction}->>'kind' in ('deliver', 'resume')`);
/** Held while its root was paused, the root gone on since (`roots` joined). */
export const heldStep = and(
  eq(roots.state, "going"),
  inArray(stepRuns.status, ACTIVE_STEP),
  isNotNull(stepRuns.sessionId),
  isNotNull(stepRuns.pendingAction),
  eq(stepRuns.working, false),
  isNull(stepRuns.queuedAt),
);
/** A consult whose consulted run (`runs`, joined on `consult_run_id`) ended unanswered. */
/** A routed question whose hop lapsed by `now` (`Engine.sweepEscalations`). */
export const lapsedEscalation = (now: Date) => and(eq(questions.status, "pending"), lte(questions.answerBy, now));
export const unansweredConsult = and(eq(questions.kind, "consult"), eq(questions.status, "pending"), inArray(runs.status, ["succeeded", "failed"]));
export const liveCloudStep = inArray(stepRuns.status, ["pending", "running", "waiting"]);

const scope = { organizationId: workspaces.organizationId, workspaceId: workspaces.id };

/** The scopes the listings name, each once, read under SYSTEM. */
async function listed(...listings: (() => PromiseLike<Scope[]>)[]): Promise<Scope[]> {
  const found = new Map<string, Scope>();
  for (const listing of listings) for (const s of await inScope(SYSTEM, listing)) found.set(s.workspaceId!, s);
  return [...found.values()];
}

const ofTriggers = (db: Db) => db.selectDistinct(scope).from(triggers).innerJoin(agents, eq(agents.id, triggers.agentId)).innerJoin(workspaces, eq(workspaces.id, agents.workspaceId));
const ofRuns = (db: Db) => db.selectDistinct(scope).from(runs).innerJoin(workspaces, eq(workspaces.id, runs.workspaceId));

/** Workspaces with a schedule or a schedule trigger due (`Scheduler.claim`). */
export function scheduledScopes(db: Db, now: Date): Promise<Scope[]> {
  return listed(
    () => db.selectDistinct(scope).from(schedules).innerJoin(workflows, eq(workflows.id, schedules.workflowId)).innerJoin(workspaces, eq(workspaces.id, workflows.workspaceId)).where(dueSchedule(now)),
    () => ofTriggers(db).where(dueTrigger("schedule", now)),
  );
}

/** Workspaces with an event to match or a deferred event fire (`Scheduler.claim`). */
export function eventScopes(db: Db): Promise<Scope[]> {
  return listed(
    () => db.selectDistinct(scope).from(events).leftJoin(roots, eq(roots.id, events.rootId)).innerJoin(workspaces, eq(workspaces.id, events.workspaceId)).where(dueEvent),
    () => ofTriggers(db).innerJoin(eventFires, eq(eventFires.triggerId, triggers.id)).where(deferredEventFire),
  );
}

/** Workspaces with a poll due or a deferred poll item (`Scheduler.poll`, `Scheduler.claim`). */
export function pollScopes(db: Db, now: Date): Promise<Scope[]> {
  return listed(
    () => ofTriggers(db).where(dueTrigger("poll", now)),
    () => ofTriggers(db).innerJoin(pollItems, eq(pollItems.triggerId, triggers.id)).where(deferredPollItem),
  );
}

/**
 * Workspaces with a routed question whose hop lapsed (`Engine.sweepEscalations`): found from the
 * question's status and deadline and its run's workspace, never from its route.
 */
export function escalationScopes(db: Db, now: Date): Promise<Scope[]> {
  return listed(() => ofRuns(db).innerJoin(questions, eq(questions.runId, runs.id)).where(lapsedEscalation(now)));
}

/** Workspaces with work `Engine.recover` goes on with. */
export function recoverScopes(db: Db): Promise<Scope[]> {
  return listed(
    () => ofRuns(db).innerJoin(chatQueue, eq(chatQueue.runId, runs.id)).where(pendingChat),
    () => ofRuns(db).innerJoin(stepRuns, eq(stepRuns.runId, runs.id)).where(queuedStep),
    () => ofRuns(db).where(activeRun),
    () => ofRuns(db).innerJoin(stepRuns, eq(stepRuns.runId, runs.id)).where(handedStep),
    () => ofRuns(db).innerJoin(stepRuns, eq(stepRuns.runId, runs.id)).innerJoin(roots, eq(roots.id, runs.rootId)).where(heldStep),
    () => ofRuns(db).innerJoin(questions, eq(questions.consultRunId, runs.id)).where(unansweredConsult),
    () => ofRuns(db).innerJoin(stepRuns, eq(stepRuns.runId, runs.id)).innerJoin(cloudSessions, eq(cloudSessions.stepRunId, stepRuns.id)).where(liveCloudStep),
  );
}

/** Every workspace: for the startup routines, which bring each one up to this build. */
export function workspaceScopes(db: Db): Promise<Scope[]> {
  return listed(() => db.selectDistinct(scope).from(workspaces));
}
