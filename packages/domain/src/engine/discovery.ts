import { and, eq, inArray, isNotNull, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, chatQueue, cloudSessions, eventFires, events, harnesses, messages, pollItems, questions, roots, runs, schedules, stepRuns, triggers, type RunStatus, user, workflows, workspaces } from "../db/schema.ts";
import { inScope, SYSTEM, type Scope } from "../db/scope.ts";
import { ACTIVE_STEP, OPEN_STEP } from "./step-lifecycle.ts";

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

/**
 * The organizations a tick's claims may take work of: those the install was asked about and allows
 * (`Scheduler.claim`), or null when it refuses none. Anything else stays due, unclaimed, like a
 * paused root's events: a refused organization's, and one with nothing due when they were asked.
 */
export type Allowed = string[] | null;
/** A claimed row's workspace (`of`, a scalar subquery) in one of the `allowed` organizations. */
const within = (allowed: Allowed, of: SQL) =>
  allowed === null ? undefined : sql`${of} in (select ${workspaces.id} from ${workspaces} where ${inArray(workspaces.organizationId, allowed)})`;
const agentWorkspace = sql`(select ${agents.workspaceId} from ${agents} where ${agents.id} = ${triggers.agentId})`;
const triggerWorkspace = (triggerId: typeof eventFires.triggerId | typeof pollItems.triggerId) =>
  sql`(select ${agents.workspaceId} from ${triggers} join ${agents} on ${agents.id} = ${triggers.agentId} where ${triggers.id} = ${triggerId})`;
export const scheduleWithin = (allowed: Allowed) => within(allowed, sql`(select ${workflows.workspaceId} from ${workflows} where ${workflows.id} = ${schedules.workflowId})`);
export const triggerWithin = (allowed: Allowed) => within(allowed, agentWorkspace);
export const eventWithin = (allowed: Allowed) => within(allowed, sql`${events.workspaceId}`);
export const eventFireWithin = (allowed: Allowed) => within(allowed, triggerWorkspace(eventFires.triggerId));
export const pollItemWithin = (allowed: Allowed) => within(allowed, triggerWorkspace(pollItems.triggerId));

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
/** A harness (joined) with a step queued and a place free: what `slots.next` hands out. */
export const queuedWithRoom = and(
  queuedStep,
  sql`(select count(*) from ${stepRuns} w where w.harness_id = ${harnesses.id} and w.working) < ${harnesses.maxWorking}`,
);
/**
 * Held (`Engine.hold`) while its run might not work, started or not, or kept its slot to deliver
 * or resume (a hold during a turn): its root going now or none (a workflow run; `roots`
 * left-joined). Not paused by a person (`pausePersonal`), nor a replaced session waiting for its
 * former one to end.
 */
export const heldWork = and(
  or(isNull(runs.rootId), eq(roots.state, "going")),
  activeRun,
  inArray(stepRuns.status, OPEN_STEP),
  isNotNull(stepRuns.pendingAction),
  sql`${stepRuns.pendingAction}->'paused' is null`,
  sql`coalesce(${stepRuns.resumeAfterSession}->>'ended', 'true') <> 'false'`,
  or(and(eq(stepRuns.working, false), isNull(stepRuns.queuedAt)), handedStep),
);
/** A consult asked while its root was paused or its organization refused: no consulted Job yet (`Engine.openWaitingConsults`). */
export const waitingConsult = and(eq(questions.kind, "consult"), eq(questions.status, "pending"), isNull(questions.consultRunId));
/** One to open now: its asking run (`runs`) going, its root (`roots`, joined) too. */
export const consultToOpen = and(waitingConsult, activeRun, eq(roots.state, "going"));
/** A consult whose consulted run (`runs`, joined on `consult_run_id`) ended unanswered. */
/**
 * A question that must move on by `now` (`Engine.sweepEscalations`): a routed one whose hop lapsed,
 * or any whose addressee was deleted or archived (a consult's goes to its agent, never a person).
 */
const goneAddressee = or(isNull(questions.addresseeId), sql`exists (select 1 from ${user} where ${user.id} = ${questions.addresseeId} and ${user.archivedAt} is not null)`);
// A person's Assistant chat is private: its questions wait for them, or for the purge.
const inAssistantChat = sql`exists (select 1 from ${runs} join ${agents} on ${agents.id} = ${runs.agentId} where ${runs.id} = ${questions.runId} and ${agents.builtIn} = 'assistant')`;
export const lapsedEscalation = (now: Date) => and(eq(questions.status, "pending"), or(lte(questions.answerBy, now), and(goneAddressee, ne(questions.kind, "consult"), sql`not ${inAssistantChat}`)));
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

/** Organizations with work a claim takes (`Scheduler.claim`, `Scheduler.poll`), each once, read under SYSTEM. */
export async function claimOrganizations(db: Db, now: Date): Promise<string[]> {
  const scopes = [...(await scheduledScopes(db, now)), ...(await eventScopes(db)), ...(await pollScopes(db, now))];
  return [...new Set(scopes.map((s) => s.organizationId!))];
}

/**
 * Workspaces with a question that must move on (`Engine.sweepEscalations`): found from the
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

/** Workspaces with a step queued for a free place, a step held, or a consult to open (`Engine.redrain`). */
export function redrainScopes(db: Db): Promise<Scope[]> {
  return listed(
    () => db.selectDistinct(scope).from(harnesses).innerJoin(workspaces, eq(workspaces.id, harnesses.workspaceId)).innerJoin(stepRuns, eq(stepRuns.harnessId, harnesses.id)).where(queuedWithRoom),
    () => ofRuns(db).innerJoin(stepRuns, eq(stepRuns.runId, runs.id)).leftJoin(roots, eq(roots.id, runs.rootId)).where(heldWork),
    () => ofRuns(db).innerJoin(questions, eq(questions.runId, runs.id)).innerJoin(roots, eq(roots.id, runs.rootId)).where(consultToOpen),
  );
}

/** Every workspace: for the startup routines, which bring each one up to this build. */
export function workspaceScopes(db: Db): Promise<Scope[]> {
  return listed(() => db.selectDistinct(scope).from(workspaces));
}
