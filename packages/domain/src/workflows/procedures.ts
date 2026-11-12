import { ORPCError } from "@orpc/server";
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { Tx } from "../db/client.ts";
import {
  agents,
  messages,
  questions,
  runs as runsTable,
  scheduleFires,
  schedules,
  stepRuns,
  triggers,
  workflows as workflowsTable,
  workflowVersions,
} from "../db/schema.ts";
import { EngineError, messageView, questionView, runIssues, runView, stepView, type RunEvent } from "../engine/engine.ts";
import { proposalView } from "../platform/proposals.ts";
import { loadToolSchemas } from "../tools/executor.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { loadTableSchemas } from "../data/tables.ts";
import { tableIdsOf } from "./data-steps.ts";
import { structuralIssues } from "./derive.ts";
import { agentIdsOf, defaultWorkflowDef, StorableText, WorkflowDef } from "./model.ts";
import { cronProblem, nextFireAfter } from "./schedule.ts";
import { toolIdsOf } from "./tool-steps.ts";

const owner = base.use(authed);

const Name = z.string().trim().min(1).max(100);

type WorkflowRow = typeof workflowsTable.$inferSelect;

function toWorkflow(w: WorkflowRow, def: WorkflowDef) {
  return { id: w.id, name: w.name, version: w.currentVersion, def, updatedAt: w.updatedAt };
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

async function find(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(workflowsTable)
    .where(and(eq(workflowsTable.id, id), eq(workflowsTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

async function defOf(db: Db, workflowId: string, version: number): Promise<WorkflowDef> {
  const [row] = await db
    .select({ def: workflowVersions.def })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, version)));
  return row!.def;
}

/** Every agent the definition names must be one of the owner's. */
async function requireAgents(db: Db, ownerId: string, def: WorkflowDef) {
  const ids = agentIdsOf(def);
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), inArray(agents.id, ids)));
  if (rows.length !== ids.length) throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
}

/** Every table the definition's data steps name must be one of the owner's. */
async function requireTables(db: Db, ownerId: string, def: WorkflowDef) {
  const ids = tableIdsOf(def);
  if ((await loadTableSchemas(db, ownerId, ids)).length !== ids.length) throw new ORPCError("NOT_FOUND", { message: "Table not found" });
}

/** Every tool the definition's Tool steps name must be one of the owner's. */
async function requireTools(db: Db, ownerId: string, def: WorkflowDef) {
  const ids = toolIdsOf(def);
  if ((await loadToolSchemas(db, ownerId, ids)).length !== ids.length) throw new ORPCError("NOT_FOUND", { message: "Tool not found" });
}

/** Whether a workflow's current version, or the version of a run still going, puts the agent to work. */
export async function agentInUse(db: Db, ownerId: string, agentId: string): Promise<boolean> {
  const current = await db
    .select({ def: workflowVersions.def })
    .from(workflowsTable)
    .innerJoin(
      workflowVersions,
      and(eq(workflowVersions.workflowId, workflowsTable.id), eq(workflowVersions.version, workflowsTable.currentVersion)),
    )
    .where(eq(workflowsTable.ownerId, ownerId));
  const running = await db
    .select({ def: workflowVersions.def })
    .from(runsTable)
    .innerJoin(
      workflowVersions,
      and(eq(workflowVersions.workflowId, runsTable.workflowId), eq(workflowVersions.version, runsTable.version)),
    )
    .where(and(eq(runsTable.ownerId, ownerId), inArray(runsTable.status, ["running", "waiting"])));
  return [...current, ...running].some(({ def }) => agentIdsOf(def).includes(agentId));
}

const create = owner.input(z.object({ name: Name })).handler(async ({ input, context }) => {
  const id = newId("wf");
  const def = defaultWorkflowDef(newId("node"));
  const row = await context.db.transaction(async (tx) => {
    const [row] = await tx.insert(workflowsTable).values({ id, ownerId: context.ownerId, name: input.name, currentVersion: 1 }).returning();
    await tx.insert(workflowVersions).values({ workflowId: id, version: 1, ownerId: context.ownerId, def });
    return row!;
  });
  return toWorkflow(row, def);
});

/** Saves the name, and the definition as a new version when it changed (runs keep theirs). */
const update = owner.input(z.object({ id: z.string(), name: Name, def: WorkflowDef })).handler(async ({ input, context }) => {
  await find(context.db, context.ownerId, input.id);
  const [broken] = structuralIssues(input.def);
  if (broken) throw new ORPCError("BAD_REQUEST", { message: broken.message });
  // A schedule must be able to fire: its next time is computed in the same transaction.
  const trigger = input.def.trigger;
  const scheduleProblem = trigger.type === "schedule" ? cronProblem(trigger.field.cron, trigger.field.timezone) : null;
  if (scheduleProblem) throw new ORPCError("BAD_REQUEST", { message: scheduleProblem });
  const now = (context.now ?? (() => new Date()))();
  await requireAgents(context.db, context.ownerId, input.def);
  await requireTables(context.db, context.ownerId, input.def);
  await requireTools(context.db, context.ownerId, input.def);
  const row = await context.db.transaction(async (tx) => {
    await lockSchedule(tx, input.id);
    // Locked: concurrent saves get consecutive versions.
    const [current] = await tx.select().from(workflowsTable).where(eq(workflowsTable.id, input.id)).for("update");
    const [stored] = await tx
      .select({ def: workflowVersions.def })
      .from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, input.id), eq(workflowVersions.version, current!.currentVersion)));
    let version = current!.currentVersion;
    if (canonical(stored!.def) !== canonical(input.def)) {
      version += 1;
      await tx.insert(workflowVersions).values({ workflowId: input.id, version, ownerId: context.ownerId, def: input.def });
    }
    const [row] = await tx
      .update(workflowsTable)
      .set({ name: input.name, currentVersion: version, updatedAt: new Date() })
      .where(eq(workflowsTable.id, input.id))
      .returning();
    await syncSchedule(tx, context.ownerId, input.id, input.def, now);
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
  await find(context.db, context.ownerId, input.id);
  const now = (context.now ?? (() => new Date()))();
  await context.db.transaction(async (tx) => {
    const [s] = await tx.select().from(schedules).where(eq(schedules.workflowId, input.id)).for("update");
    if (!s) throw new ORPCError("NOT_FOUND", { message: "This workflow has no schedule" });
    if (s.enabled === input.enabled) return;
    const resumed = input.enabled ? { nextFireAt: nextFireAfter(s.cron, s.timezone, now), lastCheckedAt: now } : {};
    await tx.update(schedules).set({ enabled: input.enabled, ...resumed }).where(eq(schedules.workflowId, input.id));
  });
});

const remove = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  await find(context.db, context.ownerId, input.id);
  await context.db.transaction(async (tx) => {
    await lockSchedule(tx, input.id);
    // Locked: a run starting now (which locks it to share) waits, then finds no workflow.
    await tx.select({ id: workflowsTable.id }).from(workflowsTable).where(eq(workflowsTable.id, input.id)).for("update");
    const [active] = await tx
      .select({ n: count() })
      .from(runsTable)
      .where(and(eq(runsTable.workflowId, input.id), inArray(runsTable.status, ["running", "waiting"])));
    if (active && active.n > 0) throw new ORPCError("CONFLICT", { message: "A run of this workflow is still going" });
    await tx.delete(workflowsTable).where(eq(workflowsTable.id, input.id));
  });
});

const list = owner.handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(workflowsTable)
    .where(eq(workflowsTable.ownerId, context.ownerId))
    .orderBy(desc(workflowsTable.updatedAt), asc(workflowsTable.id));
  return rows.map((w) => ({ id: w.id, name: w.name, version: w.currentVersion, updatedAt: w.updatedAt }));
});

/** The workflow with its current definition, or the definition of `version` (what a run started on). */
const get = owner.input(z.object({ id: z.string(), version: z.number().int().min(1).optional() })).handler(async ({ input, context }) => {
  const row = await find(context.db, context.ownerId, input.id);
  const version = input.version ?? row.currentVersion;
  if (version > row.currentVersion) throw new ORPCError("NOT_FOUND");
  return { ...(await withSchedule(context.db, toWorkflow(row, await defOf(context.db, row.id, version)))), version };
});

export const workflows = { create, update, delete: remove, list, get, setScheduleEnabled };

// Runs

async function requireRun(db: Db, ownerId: string, runId: string) {
  const [row] = await db
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

/**
 * A question as a run shows it. A pending Approval of a proposal carries the proposal as its owner
 * reads it (`proposalView`), so the chat shows its items whole and can offer Approve; any other, or
 * once answered, `proposal` is null.
 */
async function runQuestion(db: Db, ownerId: string, q: ReturnType<typeof questionView>) {
  return { ...q, proposal: q.proposalId && q.status === "pending" ? await proposalView(db, ownerId, q.proposalId) : null };
}

/** The run as it is now: every row read here, so a stream's snapshot can't be older than its subscription. */
async function snapshot(db: Db, ownerId: string, runId: string) {
  const [[run], steps, transcript, asked] = await Promise.all([
    db.select().from(runsTable).where(eq(runsTable.id, runId)),
    db.select().from(stepRuns).where(eq(stepRuns.runId, runId)),
    db.select().from(messages).where(eq(messages.runId, runId)).orderBy(asc(messages.position)),
    db.select().from(questions).where(eq(questions.runId, runId)).orderBy(asc(questions.createdAt)),
  ]);
  return {
    run: runView(run!),
    steps: steps.map(stepView),
    messages: transcript.map(messageView),
    questions: await Promise.all(asked.map((q) => runQuestion(db, ownerId, questionView(q)))),
  };
}

export function engineError(err: unknown): never {
  if (!(err instanceof EngineError)) throw err;
  const code = { NOT_FOUND: "NOT_FOUND", INVALID: "BAD_REQUEST", CLOSED: "CONFLICT", NOT_PENDING: "CONFLICT", STOPPED: "CONFLICT" }[err.code];
  throw new ORPCError(code, { message: err.message });
}

const start = owner.input(z.object({ workflowId: z.string() })).handler(async ({ input, context }) => {
  const workflow = await find(context.db, context.ownerId, input.workflowId);
  const def = await defOf(context.db, workflow.id, workflow.currentVersion);
  const [issue] = await runIssues(context.db, context.ownerId, def);
  if (issue) throw new ORPCError("BAD_REQUEST", { message: `Fix the workflow first: ${issue.message}` });
  await requireAgents(context.db, context.ownerId, def);
  const runId = await context.engine.startRun(workflow.id).catch(engineError);
  if (def.trigger.field.type !== "chat") return { runId };
  const [chat] = await context.db
    .select({ sessionId: stepRuns.sessionId })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, def.trigger.field.id)));
  return { runId, ...(chat?.sessionId ? { chatSessionId: chat.sessionId } : {}) };
});

const sendChat = owner
  .input(z.object({ runId: z.string(), text: StorableText(100_000).trim().min(1) }))
  .handler(async ({ input, context }) => {
    await requireRun(context.db, context.ownerId, input.runId);
    await context.engine.sendChat(input.runId, input.text).catch(engineError);
  });

/** Stops a run or a Job still going: its open steps fail with "Stopped" and its sessions end. */
const stop = owner.input(z.object({ runId: z.string() })).handler(async ({ input, context }) => {
  await requireRun(context.db, context.ownerId, input.runId);
  await context.engine.stopRun(input.runId).catch(engineError);
});

const getRun = owner.input(z.object({ runId: z.string() })).handler(async ({ input, context }) => {
  await requireRun(context.db, context.ownerId, input.runId);
  return snapshot(context.db, context.ownerId, input.runId);
});

/** The run as it is, then every change to it while the client listens. */
const stream = owner.input(z.object({ runId: z.string() })).handler(async function* ({ input, context, signal }) {
  // The earlier lookup only authorizes: the snapshot reads the run again after subscribing.
  await requireRun(context.db, context.ownerId, input.runId);
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
    yield { type: "snapshot" as const, ...(await snapshot(context.db, context.ownerId, input.runId)) };
    while (!signal?.aborted) {
      if (behind) {
        behind = false;
        yield { type: "snapshot" as const, ...(await snapshot(context.db, context.ownerId, input.runId)) };
      } else if (queue.length > 0) {
        const change = queue.shift()! satisfies RunEvent;
        yield change.type === "question" ? { ...change, question: await runQuestion(context.db, context.ownerId, change.question) } : change;
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
 * conversation's first message, null before it has one.
 */
const listRuns = owner.input(z.object({ workflowId: z.string().optional(), agentId: z.string().optional(), triggerId: z.string().optional(), kind: z.literal("chat").optional() })).handler(async ({ input, context }) => {
  if (input.triggerId) {
    const [trigger] = await context.db
      .select({ id: triggers.id })
      .from(triggers)
      .where(and(eq(triggers.id, input.triggerId), eq(triggers.ownerId, context.ownerId)));
    if (!trigger) throw new ORPCError("NOT_FOUND");
  }
  if (input.workflowId) await find(context.db, context.ownerId, input.workflowId);
  if (input.agentId) {
    const [agent] = await context.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.ownerId, context.ownerId)));
    if (!agent) throw new ORPCError("NOT_FOUND");
  }
  const rows = await context.db
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.ownerId, context.ownerId),
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
  return rows.map((r) => ({ ...runView(r), queued: queued.has(r.id), title: titles.get(r.id) ?? null }));
});

export const runs = { start, sendChat, stop, get: getRun, stream, list: listRuns };
