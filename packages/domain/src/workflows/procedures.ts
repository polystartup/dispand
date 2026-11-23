import { ORPCError } from "@orpc/server";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { MAX_RESULT_FILES } from "@dispand/runner-protocol";
import type { Db } from "../db/client.ts";
import type { Tx } from "../db/client.ts";
import {
  agents,
  chatQueue,
  messages,
  questions,
  runs as runsTable,
  scheduleFires,
  schedules,
  stepRuns,
  triggers,
  widgets,
  workflows as workflowsTable,
  workflowVersions,
} from "../db/schema.ts";
import { EngineError, passOn } from "../engine/errors.ts";
import { runIssues } from "../engine/problems.ts";
import { messageView, questionView, queuedView, runView, stepView, type RunEvent } from "../engine/views.ts";
import { proposalView } from "../platform/proposals.ts";
import { loadToolSchemas } from "../tools/executor.ts";
import { newId } from "../ids.ts";
import { message } from "../messages/index.ts";
import { base, type InitialContext, inPlacedScope, inStreamScope, member, signedIn } from "../rpc/context.ts";
import { authorize, placeOfRun } from "../workspace/authorize.ts";
import { loadTableSchemas } from "../data/tables.ts";
import { consultMarks } from "../jobs/consults.ts";
import { tableIdsOf } from "./data-steps.ts";
import { structuralIssues } from "./derive.ts";
import { agentIdsOf, defaultWorkflowDef, StorableText, WorkflowDef } from "./model.ts";
import { cronProblem, nextFireAfter } from "./schedule.ts";
import { hasLegacyWorkspaceAccess, readableRun, type RunReader } from "../workspace/access.ts";
import { toolIdsOf } from "./tool-steps.ts";

const owner = base.use(member);

/** A member procedure's caller, as the run checks (`readableRun`) take a reader: its person is the actor. */
const asReader = (context: Pick<InitialContext, "db" | "job"> & { actorId: string }): RunReader => ({ db: context.db, job: context.job, ownerId: context.actorId });
const reader = base.use(signedIn);

const Name = z.string().trim().min(1).max(100);

type WorkflowRow = typeof workflowsTable.$inferSelect;

function toWorkflow(w: WorkflowRow, def: WorkflowDef) {
  return { id: w.id, name: w.name, version: w.currentVersion, def, updatedAt: w.updatedAt, archived: w.archivedAt !== null };
}

/** JSON with sorted keys: jsonb doesn't keep key order, so compare defs through this. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/** The workflow with its schedule (null for a manual trigger) and its latest 10 fires. */
async function withSchedule<W extends { id: string }>(db: Db, workflow: W) {
  const [[schedule], fires] = await Promise.all([
    db.select().from(schedules).where(eq(schedules.workflowId, workflow.id)),
    db.select().from(scheduleFires).where(eq(scheduleFires.workflowId, workflow.id)).orderBy(desc(scheduleFires.scheduledFor)).limit(10),
  ]);
  return {
    ...workflow,
    schedule: schedule ? { enabled: schedule.enabled, nextFireAt: schedule.nextFireAt } : null,
    fires: fires.map(({ scheduledFor, status, runId, message }) => ({ scheduledFor, status, runId, message })),
  };
}

/** The workspace's workflow; a deleted one (archived) only when `archived` asks for it, to read its runs' history. */
async function find(context: { db: Db; access: { workspaceId: string } }, id: string, archived = false) {
  const [row] = await context.db
    .select()
    .from(workflowsTable)
    .where(and(eq(workflowsTable.id, id), eq(workflowsTable.workspaceId, context.access.workspaceId), archived ? undefined : isNull(workflowsTable.archivedAt)));
  if (!row) throw new ORPCError("NOT_FOUND", message("workflows.notFound"));
  return row;
}

async function defOf(db: Db, workflowId: string, version: number): Promise<WorkflowDef> {
  const [row] = await db
    .select({ def: workflowVersions.def })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, version)));
  return row!.def;
}

/** Every agent the definition names must be the workspace's, and no other person's Assistant. */
async function requireAgents(db: Db, actorId: string, workspaceId: string, def: WorkflowDef) {
  const ids = agentIdsOf(def);
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), or(isNull(agents.builtIn), eq(agents.ownerId, actorId)), inArray(agents.id, ids)));
  if (rows.length !== ids.length) throw new ORPCError("NOT_FOUND", message("workflows.agentNotFound"));
}

/** Every table the definition's data steps name must be one of the owner's. */
async function requireTables(db: Db, workspaceId: string, def: WorkflowDef) {
  const ids = tableIdsOf(def);
  if ((await loadTableSchemas(db, workspaceId, ids)).length !== ids.length) throw new ORPCError("NOT_FOUND", message("workflows.tableNotFound"));
}

/** Every tool the definition's Tool steps name must be one of the workflow's workspace. */
async function requireTools(db: Db, workspaceId: string, def: WorkflowDef) {
  const ids = toolIdsOf(def);
  if ((await loadToolSchemas(db, workspaceId, ids)).length !== ids.length) throw new ORPCError("NOT_FOUND", message("workflows.toolNotFound"));
}

/** Whether a workflow's current version, or the version of a run still going, puts the agent to work. */
export async function agentInUse(db: Db | Tx, workspaceId: string, agentId: string): Promise<boolean> {
  const current = await db
    .select({ def: workflowVersions.def })
    .from(workflowsTable)
    .innerJoin(
      workflowVersions,
      and(eq(workflowVersions.workflowId, workflowsTable.id), eq(workflowVersions.version, workflowsTable.currentVersion)),
    )
    .where(and(eq(workflowsTable.workspaceId, workspaceId), isNull(workflowsTable.archivedAt)));
  const running = await db
    .select({ def: workflowVersions.def })
    .from(runsTable)
    .innerJoin(
      workflowVersions,
      and(eq(workflowVersions.workflowId, runsTable.workflowId), eq(workflowVersions.version, runsTable.version)),
    )
    .where(and(eq(runsTable.workspaceId, workspaceId), inArray(runsTable.status, ["running", "waiting"])));
  return [...current, ...running].some(({ def }) => agentIdsOf(def).includes(agentId));
}

const create = owner.input(z.object({ name: Name })).handler(async ({ input, context }) => {
  const id = newId("wf");
  const def = defaultWorkflowDef(newId("node"));
  const row = await context.db.transaction(async (tx) => {
    const [row] = await tx.insert(workflowsTable).values({ id, ownerId: context.actorId, workspaceId: context.access.workspaceId, name: input.name, currentVersion: 1 }).returning();
    await tx.insert(workflowVersions).values({ workflowId: id, version: 1, ownerId: context.actorId, def });
    return row!;
  });
  return toWorkflow(row, def);
});

/** Saves the name, and the definition as a new version when it changed (runs keep theirs). */
const update = owner.input(z.object({ id: z.string(), name: Name, def: WorkflowDef })).handler(async ({ input, context }) => {
  const workflow = await find(context, input.id);
  const [broken] = structuralIssues(input.def);
  if (broken) throw new ORPCError("BAD_REQUEST", message(broken.message.key, broken.message.values));
  // A schedule must be able to fire: its next time is computed in the same transaction.
  const trigger = input.def.trigger;
  const scheduleProblem = trigger.type === "schedule" ? cronProblem(trigger.field.cron, trigger.field.timezone) : null;
  if (scheduleProblem) throw new ORPCError("BAD_REQUEST", message(scheduleProblem.key, scheduleProblem.values));
  const now = (context.now ?? (() => new Date()))();
  await requireAgents(context.db, context.actorId, workflow.workspaceId, input.def);
  await requireTables(context.db, workflow.workspaceId, input.def);
  await requireTools(context.db, workflow.workspaceId, input.def);
  const row = await context.db.transaction(async (tx) => {
    await lockSchedule(tx, input.id);
    // Locked: concurrent saves get consecutive versions.
    const [current] = await tx.select().from(workflowsTable).where(eq(workflowsTable.id, input.id)).for("update");
    // Deleted meanwhile (an autosave racing the delete): nothing more is saved.
    if (current!.archivedAt) throw new ORPCError("NOT_FOUND", message("workflows.notFound"));
    const [stored] = await tx
      .select({ def: workflowVersions.def })
      .from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, input.id), eq(workflowVersions.version, current!.currentVersion)));
    let version = current!.currentVersion;
    if (canonical(stored!.def) !== canonical(input.def)) {
      version += 1;
      await tx.insert(workflowVersions).values({ workflowId: input.id, version, ownerId: context.actorId, def: input.def });
    }
    const [row] = await tx
      .update(workflowsTable)
      .set({ name: input.name, currentVersion: version, updatedAt: new Date() })
      .where(eq(workflowsTable.id, input.id))
      .returning();
    // The schedule starts its runs as the workflow's creator.
    await syncSchedule(tx, workflow.ownerId, input.id, input.def, now);
    return row!;
  });
  // As `get` gives it: the editor keeps the saved workflow as its cached `get`.
  return withSchedule(context.db, toWorkflow(row, input.def));
});

/**
 * Locks the workflow's schedule row, if any, before the workflow: the scheduler holds schedule
 * rows while it locks their workflows, so taking them in the other order could deadlock.
 */
async function lockSchedule(tx: Tx, workflowId: string) {
  await tx.select({ id: schedules.workflowId }).from(schedules).where(eq(schedules.workflowId, workflowId)).for("update");
}

/**
 * Keeps the workflow's `schedules` row with its trigger: created for a schedule, its times reset
 * only when the cron or timezone changed (a rename doesn't move the next fire), deleted for a
 * manual trigger.
 */
async function syncSchedule(tx: Tx, ownerId: string, workflowId: string, def: WorkflowDef, now: Date) {
  if (def.trigger.type !== "schedule") {
    await tx.delete(schedules).where(eq(schedules.workflowId, workflowId));
    return;
  }
  const { cron, timezone } = def.trigger.field;
  const [existing] = await tx.select().from(schedules).where(eq(schedules.workflowId, workflowId));
  if (existing?.cron === cron && existing.timezone === timezone) return;
  const times = { cron, timezone, nextFireAt: nextFireAfter(cron, timezone, now), lastCheckedAt: now };
  await tx
    .insert(schedules)
    .values({ workflowId, ownerId, ...times })
    .onConflictDoUpdate({ target: schedules.workflowId, set: times });
}

/** Pauses or resumes the workflow's schedule; resumed, it fires from now on (no catch-up for the pause). */
const setScheduleEnabled = owner.input(z.object({ id: z.string(), enabled: z.boolean() })).handler(async ({ input, context }) => {
  await find(context, input.id);
  const now = (context.now ?? (() => new Date()))();
  await context.db.transaction(async (tx) => {
    const [s] = await tx.select().from(schedules).where(eq(schedules.workflowId, input.id)).for("update");
    if (!s) throw new ORPCError("NOT_FOUND", message("workflows.noSchedule"));
    if (s.enabled === input.enabled) return;
    const resumed = input.enabled ? { nextFireAt: nextFireAfter(s.cron, s.timezone, now), lastCheckedAt: now } : {};
    await tx.update(schedules).set({ enabled: input.enabled, ...resumed }).where(eq(schedules.workflowId, input.id));
  });
});

/**
 * Deletes the workflow for its owner: archived, it no longer lists, opens or runs, its schedule
 * and its widgets go, and its runs stay as history. Refused while one of its runs is going.
 */
const remove = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  await find(context, input.id);
  await context.db.transaction(async (tx) => {
    await lockSchedule(tx, input.id);
    // Locked: a run starting now (which locks it to share) waits, then finds it archived.
    const [row] = await tx.select({ archivedAt: workflowsTable.archivedAt }).from(workflowsTable).where(eq(workflowsTable.id, input.id)).for("update");
    if (row!.archivedAt) return;
    const [active] = await tx
      .select({ n: count() })
      .from(runsTable)
      .where(and(eq(runsTable.workflowId, input.id), inArray(runsTable.status, ["running", "waiting"])));
    if (active && active.n > 0) throw new ORPCError("CONFLICT", message("workflows.runGoing"));
    await tx.update(workflowsTable).set({ archivedAt: new Date() }).where(eq(workflowsTable.id, input.id));
    await tx.delete(schedules).where(eq(schedules.workflowId, input.id));
    await tx.delete(widgets).where(eq(widgets.workflowId, input.id));
  });
});

const list = owner.handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(workflowsTable)
    .where(and(eq(workflowsTable.workspaceId, context.access.workspaceId), isNull(workflowsTable.archivedAt)))
    .orderBy(desc(workflowsTable.updatedAt), asc(workflowsTable.id));
  return rows.map((w) => ({ id: w.id, name: w.name, version: w.currentVersion, updatedAt: w.updatedAt }));
});

/** The workflow with its current definition, or the definition of `version` (what a run started on). */
const get = owner.input(z.object({ id: z.string(), version: z.number().int().min(1).optional() })).handler(async ({ input, context }) => {
  // A version asked for is a run's: its history reads on once the workflow is deleted.
  const row = await find(context, input.id, input.version !== undefined);
  const version = input.version ?? row.currentVersion;
  if (version > row.currentVersion) throw new ORPCError("NOT_FOUND", message("workflows.versionNotFound"));
  return { ...(await withSchedule(context.db, toWorkflow(row, await defOf(context.db, row.id, version)))), version };
});

export const workflows = { create, update, delete: remove, list, get, setScheduleEnabled };

// Runs

/** Changing a run still requires the legacy owner as well as access to its workspace. */
async function requireOwnedRun(context: RunReader, runId: string) {
  const [row] = await context.db.select({ id: runsTable.id }).from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.ownerId, context.ownerId), readableRun(context)));
  if (!row) throw new ORPCError("NOT_FOUND", message("workflows.runNotFound"));
}

/**
 * A question as a run shows it. Keep proposal scope after a decision so the conversation
 * retains what was approved or declined; authorization still depends on question status.
 */
export async function runQuestion(db: Db, ownerId: string, q: ReturnType<typeof questionView>) {
  return { ...q, proposal: q.proposalId ? await proposalView(db, ownerId, q.proposalId) : null };
}

async function readRun(context: RunReader, runId: string) {
  const [run] = await context.db.select().from(runsTable).where(and(eq(runsTable.id, runId), readableRun(context)));
  if (!run) throw new ORPCError("NOT_FOUND", message("workflows.runNotFound"));
  return run;
}

/** Hydrate only an authorized run. The actor's own permissions still apply to related proposals. */
async function snapshot({ db, ownerId }: RunReader, run: typeof runsTable.$inferSelect) {
  const runId = run.id;
  const [steps, transcript, asked, queued] = await Promise.all([
    db.select().from(stepRuns).where(eq(stepRuns.runId, runId)),
    db.select().from(messages).where(eq(messages.runId, runId)).orderBy(asc(messages.position)),
    db.select().from(questions).where(eq(questions.runId, runId)).orderBy(asc(questions.createdAt)),
    ownerId !== run.ownerId ? [] : db.select().from(chatQueue).where(and(eq(chatQueue.runId, runId), inArray(chatQueue.state, ["pending", "failed"]))).orderBy(asc(chatQueue.position)),
  ]);
  // A workflow run keeps no def: its version's says whether its chat can continue.
  const def = run.def ?? (run.workflowId ? await defOf(db, run.workflowId, run.version) : null);
  return {
    run: runView(run, def),
    steps: steps.map(stepView),
    messages: transcript.map(messageView),
    queue: queued.map(queuedView),
    questions: await Promise.all(asked.map((q) => runQuestion(db, ownerId, questionView(q)))),
  };
}

export function engineError(err: unknown): never {
  if (!(err instanceof EngineError)) throw err;
  const code = { NOT_FOUND: "NOT_FOUND", INVALID: "BAD_REQUEST", CLOSED: "CONFLICT", NOT_PENDING: "CONFLICT", STOPPED: "CONFLICT" }[err.code];
  throw new ORPCError(code, passOn(err));
}

const start = owner.input(z.object({ workflowId: z.string() })).handler(async ({ input, context }) => {
  const workflow = await find(context, input.workflowId);
  const def = await defOf(context.db, workflow.id, workflow.currentVersion);
  const [issue] = await runIssues(context.db, workflow.workspaceId, def);
  if (issue) throw new ORPCError("BAD_REQUEST", message(issue.message.key, issue.message.values));
  await requireAgents(context.db, context.actorId, workflow.workspaceId, def);
  const runId = await context.engine.startRun(workflow.id, context.actorId).catch(engineError);
  if (def.trigger.field.type !== "chat") return { runId };
  const [chat] = await context.db
    .select({ sessionId: stepRuns.sessionId })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, def.trigger.field.id)));
  return { runId, ...(chat?.sessionId ? { chatSessionId: chat.sessionId } : {}) };
});

const sendChat = owner
  .input(z.object({ runId: z.string(), text: StorableText(100_000).trim().min(1), continueChat: z.boolean().optional(), skillId: z.string().max(64).optional(), attachmentIds: z.array(z.string().max(64)).max(MAX_RESULT_FILES).optional() }))
  .handler(async ({ input, context }) => {
    await requireOwnedRun(asReader(context), input.runId);
    if (context.job && input.skillId) throw new ORPCError("FORBIDDEN", message("workflows.ownerSkill"));
    // Files held for the owner (`files.hold`) go only with the owner's own message.
    if (context.job && input.attachmentIds?.length) throw new ORPCError("FORBIDDEN", message("data.file.agentOnly"));
    return context.engine.sendChat(input.runId, input.text, input.skillId, input.attachmentIds ?? [], !context.job && input.continueChat).catch(engineError);
  });

/** The owner sends a pending queued message now, into the agent's running turn (`Engine.steerQueued`). */
const steerQueued = owner.input(z.object({ runId: z.string(), queuedId: z.string().max(64) })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  await requireOwnedRun(asReader(context), input.runId);
  await context.engine.steerQueued(input.runId, input.queuedId).catch(engineError);
});

/** The owner changes a message queued while the chat was busy, while it is still pending. */
const editQueued = owner.input(z.object({ runId: z.string(), queuedId: z.string().max(64), text: StorableText(100_000).trim().min(1) })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  await requireOwnedRun(asReader(context), input.runId);
  await context.engine.editQueued(input.runId, input.queuedId, input.text).catch(engineError);
});

/** The owner takes back a queued message not sent yet (pending, or failed). */
const removeQueued = owner.input(z.object({ runId: z.string(), queuedId: z.string().max(64) })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  await requireOwnedRun(asReader(context), input.runId);
  await context.engine.removeQueued(input.runId, input.queuedId).catch(engineError);
});

const interruptChat = owner.input(z.object({ runId: z.string(), turnId: z.string().min(1).max(256) })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  await requireOwnedRun(asReader(context), input.runId);
  return context.engine.interruptChat(input.runId, input.turnId).catch(engineError);
});

/** Stops a run or a Job still going: its open steps fail with "Stopped" and its sessions end. */
const stop = owner.input(z.object({ runId: z.string() })).handler(async ({ input, context }) => {
  await requireOwnedRun(asReader(context), input.runId);
  await context.engine.stopRun(input.runId).catch(engineError);
});

const runInput = z.object({ runId: z.string() });
const runNotFound = () => new ORPCError("NOT_FOUND", message("workflows.runNotFound"));
/** `read` in the run's workspace, once the caller may open it there (`inPlacedScope`). */
const inRunPlace = async <T>(context: RunReader & Parameters<typeof inPlacedScope>[0], runId: string, read: () => Promise<T>) =>
  inPlacedScope(context, await placeOfRun(context.db, runId), runNotFound, read);
const access = reader.input(runInput).handler(({ input, context }) => inRunPlace(context, input.runId, async () => {
  const [row] = await context.db.select({ ownerId: runsTable.ownerId }).from(runsTable)
    .where(and(eq(runsTable.id, input.runId), readableRun(context)));
  if (!row) throw new ORPCError("NOT_FOUND", message("workflows.runNotFound"));
  return { canManage: row.ownerId === context.ownerId && await hasLegacyWorkspaceAccess(context) };
}));

const getRun = reader.input(runInput).handler(({ input, context }) => inRunPlace(context, input.runId, async () => snapshot(context, await readRun(context, input.runId))));

/** The run as it is, then every change to it while the client listens. */
const stream = reader.input(runInput).handler(async function* ({ input, context, signal }) {
  const allowed = () => context.db.select({ ownerId: runsTable.ownerId }).from(runsTable)
    .where(and(eq(runsTable.id, input.runId), readableRun(context)));
  // The run's workspace, under SYSTEM; then the person's membership there, live, before every read.
  const admit = async () => {
    const placed = await placeOfRun(context.db, input.runId);
    if (!placed || !(await authorize(context.db, context.ownerId, placed.organizationId, placed.workspaceId))) throw new ORPCError("NOT_FOUND", message("workflows.runNotFound"));
    return placed;
  };
  const scoped = <T>(read: () => Promise<T>) => inStreamScope(context, admit, read);
  // Subscribed before the snapshot is read, so no change falls between them. A client that falls
  // more than STREAM_BUFFER changes behind gets a fresh snapshot instead: nothing is dropped unseen.
  const queue: RunEvent[] = [];
  let behind = false;
  let wake: (() => void) | undefined;
  const unsubscribe = context.engine.events.subscribe(input.runId, (change) => {
    if (queue.length >= STREAM_BUFFER) {
      behind = true;
      queue.length = 0;
    } else if (!behind) queue.push(change);
    wake?.();
  });
  const stop = () => wake?.();
  signal?.addEventListener("abort", stop);
  try {
    yield { type: "snapshot" as const, ...(await scoped(async () => snapshot(context, await readRun(context, input.runId)))) };
    while (!signal?.aborted) {
      if (behind) {
        behind = false;
        yield { type: "snapshot" as const, ...(await scoped(async () => snapshot(context, await readRun(context, input.runId)))) };
      } else if (queue.length > 0) {
        const change = queue.shift()! satisfies RunEvent;
        const out = await scoped(async () => {
          const [row] = await allowed();
          if (!row) throw new ORPCError("NOT_FOUND", message("workflows.runNotFound"));
          if (change.type === "queued" && row.ownerId !== context.ownerId) return null;
          return change.type === "question" ? { ...change, question: await runQuestion(context.db, context.ownerId, change.question) } : change;
        });
        if (out) yield out;
      }
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", stop);
  }
});

/** How many changes a run stream holds for a slow client before it resynchronizes it. */
export const STREAM_BUFFER = 1000;

/** How many characters of a conversation's first message name it in a list. */
export const TITLE_LENGTH = 80;

/**
 * The latest runs of one workflow, the latest Jobs of one agent or of one trigger, or the owner's
 * latest runs of both kinds when none is given. `kind: "chat"` keeps the Jobs that are
 * conversations (their own definition opens with a chat); `title` is the first words of a
 * conversation's first message, null before it has one. `waitingOn` and `consultedBy`: the agent a
 * Job's pending consult waits on, and the agent that consulted it (`jobs/consults.ts`).
 */
const listRuns = owner.input(z.object({ workflowId: z.string().optional(), agentId: z.string().optional(), triggerId: z.string().optional(), kind: z.literal("chat").optional() })).handler(async ({ input, context }) => {
  if (input.triggerId) {
    const [trigger] = await context.db
      .select({ id: triggers.id })
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .where(and(eq(triggers.id, input.triggerId), eq(agents.workspaceId, context.access.workspaceId)));
    if (!trigger) throw new ORPCError("NOT_FOUND", message("workflows.triggerNotFound"));
  }
  if (input.workflowId) await find(context, input.workflowId, true);
  if (input.agentId) {
    const [agent] = await context.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, context.access.workspaceId)));
    if (!agent) throw new ORPCError("NOT_FOUND", message("workflows.agentNotFound"));
  }
  const rows = await context.db
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.ownerId, context.actorId),
        readableRun(asReader(context)),
        input.workflowId ? eq(runsTable.workflowId, input.workflowId) : undefined,
        input.agentId ? eq(runsTable.agentId, input.agentId) : undefined,
        input.triggerId ? eq(runsTable.triggerId, input.triggerId) : undefined,
        input.kind ? sql`${runsTable.def} -> 'trigger' -> 'field' ->> 'type' = ${input.kind}` : undefined,
      ),
    )
    .orderBy(desc(runsTable.createdAt), desc(runsTable.id))
    .limit(50);
  // The runs with a step waiting for a slot of its harness (`engine/slots.ts`).
  const ids = rows.map((r) => r.id);
  const queued = ids.length
    ? new Set((await context.db.selectDistinct({ runId: stepRuns.runId }).from(stepRuns).where(and(inArray(stepRuns.runId, ids), isNotNull(stepRuns.queuedAt)))).map((r) => r.runId))
    : new Set<string>();
  // Each run's first message of the owner, cut in the database: a message can be long.
  const firsts = ids.length
    ? await context.db
        .selectDistinctOn([messages.runId], { runId: messages.runId, text: sql<string>`left(${messages.text}, ${TITLE_LENGTH})` })
        .from(messages)
        .where(and(inArray(messages.runId, ids), eq(messages.role, "user")))
        .orderBy(messages.runId, asc(messages.position))
    : [];
  const titles = new Map(firsts.map((m) => [m.runId, m.text.replace(/\s+/g, " ").trim() || null]));
  const marks = await consultMarks(context.db, rows);
  // Each workflow run's workflow name, a deleted workflow's included: the list names its runs.
  const workflowIds = [...new Set(rows.flatMap((r) => r.workflowId ?? []))];
  const names = new Map(
    workflowIds.length ? (await context.db.select({ id: workflowsTable.id, name: workflowsTable.name }).from(workflowsTable).where(inArray(workflowsTable.id, workflowIds))).map((w) => [w.id, w.name]) : [],
  );
  return rows.map((r) => ({ ...runView(r), workflowName: r.workflowId ? (names.get(r.workflowId) ?? null) : null, queued: queued.has(r.id), title: titles.get(r.id) ?? null, ...marks.get(r.id)! }));
});

export const runs = { access, start, sendChat, steerQueued, editQueued, removeQueued, interruptChat, stop, get: getRun, stream, list: listRuns };
