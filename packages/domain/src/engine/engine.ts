import { invokedSnapshot } from "../assistant/invoke.ts";
import type { CloudEvent } from "../messages/record-result.ts";
import { offerForQuestion, remember, toolAnswerPermission } from "../agents/remember.ts";
import { EventPublisher } from "@orpc/server";
import {
  type Answer,
  type HarnessEvent,
  SESSION_ALREADY_RUNNING,
  SESSION_NOT_RUNNING,
  PERMISSION_INPUT,
  storable,
  TEXT,
} from "@dispand/runner-protocol";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import {
  agentConsults,
  agents,
  attachments,
  chatQueue,
  eventFires,
  events,
  harnesses,
  runners,
  messages,
  questions,
  roots,
  runs,
  stepRuns,
  triggers,
  workflows,
  workflowVersions,
  type AgentSnapshot,
  type AnsweredBy,
  type EventActor,
  type JobCause,
  type MessageFile,
  type PendingAction,
  type QueueClass,
  type RootKind,
  type RunStatus,
  type RunTrigger,
  type StepStatus,
  type TurnStatus,
} from "../db/schema.ts";
import { newId } from "../ids.ts";
import { errorKind, logError } from "../log.ts";
import type { DataEvents } from "../data/events.ts";
import { loadTableSchemas } from "../data/tables.ts";
import { takeChatFiles } from "../data/files.ts";
import { loadToolSchemas, noToolSteps, type ToolExecutor } from "../tools/executor.ts";
import { tableIdsOf } from "../workflows/data-steps.ts";
import { deriveExpectedOutputs } from "../workflows/derive.ts";
import { loopOf, nodesOf, type WorkflowDef, type WorkflowNode } from "../workflows/model.ts";
import { renderTemplate } from "../workflows/template.ts";
import { toolIdsOf } from "../workflows/tool-steps.ts";
import { CLOUD_SOURCE, type ConsultTarget, type Harness, type HarnessAdapter, type InterruptOutcome, isCloud, type StartParams } from "./harness.ts";
import { runDataStep } from "./data-step.ts";
import { sessionTooling } from "./tooling.ts";
import { runnerGrantCurrent, stopAsking } from "../platform/exposed.ts";
import { annotate, currentTraceId, inJobTrace, markSpan, meter, recordError, spanEvent, tracer, withJob } from "../telemetry/index.ts";
import { CONSULT, REQUEST_APPROVAL } from "../cloud/builtins.ts";
import { attachProposal, settleProposal, withdrawProposal } from "../platform/proposals.ts";
import { issueJobToken } from "../platform/token.ts";
import type { SecretBox } from "../secrets.ts";
import { consultOutputs, jobDef, jobSystemPrompt } from "./job-def.ts";
import { closeStemJob, PLUGIN_UPDATE } from "../plugins/resolve.ts";
import { agentName, approvalOf, consultEnd, consultProblem, DECLINED, deliveryProblem, failed, FLAGGED, lockConsults, TOO_LONG } from "./consults.ts";
import { nextActions, outputsFor, toolValues, valuesFor } from "./next-actions.ts";
import { consultsOf, type ConsultEntry } from "../agents/consults.ts";
import { skillsAndTools } from "../agents/skills-and-tools.ts";
import { next, take } from "./slots.ts";
import { checkpointOf, newRoot, pause, pausedGauge, ROOT_STOPPED, rootGoing } from "./roots.ts";
import { recordInteraction, recordInteractions } from "./interactions.ts";
import { recordJobEvent } from "./jobs-events.ts";
import { recordAudit, recordAuditAfter } from "../audit/record.ts";
import type { AuditActor } from "../audit/model.ts";
import { message, plainText, stored, storedText } from "../messages/index.ts";
import { type MessageRow, messageView, type Out, type QuestionRow, questionView, queuedView, continuationNode, type RunEvent, type RunRow, runView, type StepRow, stepView } from "./views.ts";
import { answerText, earlierConversation, resumePrompt } from "./answers.ts";
import { EngineError, RUNNER_REVOKED, STOPPED, TOOL_RESTARTED } from "./errors.ts";
import { runIssues, startProblem } from "./problems.ts";
import { agentHarnesses, defOf, deliveredTranscript, expireApprovals, openIteration, pushStep, release, rootGoingLocked, skip, startLoop, undeliveredMessages } from "./step-rows.ts";
import { lostScope, withMemory } from "./job-reads.ts";
import { runnerForRun, sessionHarness, sessionSource } from "./session-harness.ts";

const traces = tracer("engine");
const counts = meter("engine");

const ACTIVE_RUN: RunStatus[] = ["running", "waiting"];

/** Why a Job was stopped, as its `job.failed` Audit row says: a person, a declined checkpoint, a consult taken back. */
type StopReason = "stopped" | "stopped-checkpoint" | "consult-revoked";

/** Who made a Job, for its `job.created` row: the person who started it, the asking Job of a consult, else the scheduler that fired it. */
function creatorOf(ownerId: string, cause: JobCause): AuditActor {
  if (cause.kind === "user") return { type: "user", userId: ownerId };
  if (cause.kind === "consult") return { type: "job", runId: cause.jobId };
  if (cause.kind === "stem") return { type: "user", userId: ownerId };
  return { type: "scheduler" };
}
const ACTIVE_STEP: StepStatus[] = ["running", "waiting"];
const OPEN_STEP: StepStatus[] = ["pending", "running", "waiting"];

/** Events after which a chat may be idle, its queue to drain. */
const SETTLING = new Set<HarnessEvent["type"]>(["turn-end", "steer-result", "interrupt-result", "session-ended", "result", "outputs-accepted", "error"]);

/** The run an event is about, which `publish` sends it to. */
function runOf(e: RunEvent): string {
  if (e.type === "run") return e.run.id;
  if (e.type === "step") return e.step.runId;
  if (e.type === "message") return e.message.runId;
  if (e.type === "queued") return e.queued.runId;
  return e.question.runId;
}


/**
 * Whether the step's session may get answers and chat messages now: it holds a slot (or has no
 * harness to charge). Every path that sends them to a session it may not have reached goes
 * through here; what may not go stays undelivered, sent when the step is handed a slot (`handOver`).
 */
function holdsSlot(step: Pick<StepRow, "working" | "harnessId">): boolean {
  return step.working || !step.harnessId;
}

/**
 * The consulted agent of a consult row, for its Audit rows: its id only when it names an agent of
 * the owner, since the asking agent wrote it.
 */
async function consultedAgent(tx: Tx, q: QuestionRow): Promise<{ agentId?: string }> {
  if (q.payload.kind !== "consult") return {};
  const [row] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, q.payload.agentId), eq(agents.ownerId, q.ownerId)));
  return row ? { agentId: row.id } : {};
}

/** A consult ended, in `tx`: how, and how long its asker waited (never its question or its answer). `by`: the consulted Job that answered. */
async function consultEnded(tx: Tx, q: QuestionRow, outcome: "answered" | "refused" | "failed" | "stopped", by?: AnsweredBy | null) {
  await recordAudit(tx, {
    ownerId: q.ownerId,
    actor: { type: "job", runId: by?.type === "agent" ? by.runId : q.runId },
    jobId: q.runId,
    action: "consult.ended",
    resource: { type: "consult", id: q.id },
    result: outcome === "answered" ? "ok" : outcome === "refused" ? "refused" : "failed",
    details: {
      ...(await consultedAgent(tx, q)),
      ...(q.consultRunId ? { consultedJobId: q.consultRunId } : {}),
      outcome,
    },
  });
  counts.counter("dispand.consults.ended").add(1, { "dispand.consult.outcome": outcome });
  counts.histogram("dispand.consult.wait", { unit: "ms", description: "From a consult to its answer, or its end" }).record(Date.now() - q.createdAt.getTime(), { "dispand.consult.outcome": outcome });
}

/** The agents `entries` names that `agentId` may still consult, with their names and descriptions as they are now. */
async function consultTargets(db: Db, entries: ConsultEntry[], agentId: string): Promise<ConsultTarget[]> {
  const now = new Set((await consultsOf(db, agentId)).map((e) => e.agentId));
  const ids = entries.map((e) => e.agentId).filter((id) => now.has(id));
  if (ids.length === 0) return [];
  const rows = await db.select({ agentId: agents.id, name: agents.name, description: agents.description }).from(agents).where(inArray(agents.id, ids)).orderBy(asc(agents.name));
  return rows;
}

/**
 * Runs workflows (spec 7.4). Runs, step runs, transcripts and questions are rows, so a run
 * survives restarts and can wait days. Harness events arrive through `onHarnessEvent`, which only
 * writes and returns: nothing in it waits on a runner or on the owner.
 *
 * Idempotency: the hub delivers each runner event at least once. Every step run records the
 * highest runner seq it handled (`event_seq`), raised in the same transaction as the event's
 * effects, so a replayed event changes nothing.
 */
export class Engine {
  /** Changes per run id, for `runs.stream`. */
  readonly events = new EventPublisher<Record<string, RunEvent>>({ maxBufferedEvents: 1000 });
  /** Pings whenever a question is asked, answered or expires, for `questions.stream`. */
  readonly questionChanges = new EventPublisher<{ changed: true }>({ maxBufferedEvents: 1 });
  /** Starts, answers and chat messages handed to the adapter and not settled yet: never sent twice at once. */
  private readonly inFlight = new Set<string>();
  /** Reconciles under way: answers and chat messages wait for them (see `deliverAnswer`). */
  private reconciling = 0;
  private readonly deferred: (() => void)[] = [];
  /** Times each session was found lost: a delivery written before the last one doesn't count. */
  private readonly losses = new Map<string, number>();
  /** Starts and deliveries running without being awaited, until they settle: `stop()` waits for them. */
  private readonly background = new Set<Promise<void>>();
  /** Aborted by `stop()`: tool calls under way are cut, and their steps left for `recover` to fail. */
  private readonly stopping = new AbortController();
  /** The Tool step calls under way, by step id: `stopRun` cuts its run's. */
  private readonly toolCalls = new Map<string, AbortController>();
  /** Checkpoint Approvals asked in transactions not known to have committed, with when: `announceCheckpoints` publishes those that did. */
  private readonly checkpointed = new Map<string, number>();

  constructor(
    readonly db: Db,
    private readonly adapter: HarnessAdapter,
    /** Sessions run in this process (`CloudRunner`), reconciled on `recover()` under `CLOUD_SOURCE`. */
    private readonly cloud?: { recover(going: (runId: string) => Promise<boolean>): Promise<string[]>; resumeQueued?(sessionId: string): void },
    /** Where data steps publish the rows they write (`rows.stream`). */
    private readonly dataEvents?: DataEvents,
    /** Runs Tool steps (`connectorToolExecutor`); without one, they fail. */
    private readonly toolSteps: ToolExecutor = noToolSteps,
    /** Seals each Job's token; without one, Jobs get no token (and no Job endpoint). */
    private readonly secrets?: SecretBox,
  ) {}

  /** Revoke grants in every live session of this agent, including workflow steps. */
  async narrowSessions(agentId: string, db: Db = this.db, runId?: string): Promise<void> {
    const sessions = await db.select({ sessionId: stepRuns.sessionId }).from(stepRuns)
      .innerJoin(runs, eq(runs.id, stepRuns.runId))
      .where(and(inArray(runs.status, ACTIVE_RUN), inArray(stepRuns.status, ACTIVE_STEP), isNotNull(stepRuns.sessionId), runId ? eq(runs.id, runId) : undefined));
    for (const { sessionId } of sessions) {
      if ((await sessionTooling(db, sessionId!)).agentId === agentId) await this.adapter.narrowPermissions?.(sessionId!, db);
    }
    spanEvent("session.permissions.narrowed", { "agent.id": agentId });
  }

  /** Workspace changes revoke grants for explicit and conversation-only tool holders alike. */
  async narrowOwnerSessions(ownerId: string, db: Db = this.db): Promise<void> {
    const owned = await db.select({ id: agents.id }).from(agents).where(eq(agents.ownerId, ownerId));
    for (const agent of owned) await this.narrowSessions(agent.id, db);
  }

  /** Starts a run of the workflow's current version and returns its id. */
  async startRun(workflowId: string): Promise<string> {
    const runId = await this.db.transaction((tx) => this.createRun(tx, workflowId, { type: "manual" }));
    await this.continueRun(runId);
    return runId;
  }

  /**
   * Inserts a run of the workflow's current version and its steps, in `tx`, without starting
   * anything: `continueRun` does once `tx` commits (or `recover`, after a restart).
   */
  async createRun(tx: Tx, workflowId: string, trigger: RunTrigger): Promise<string> {
    // Shared with other starts, exclusive with a delete: the run never outlives its workflow.
    const [workflow] = await tx.select().from(workflows).where(eq(workflows.id, workflowId)).for("share");
    // A deleted workflow (archived) never runs again.
    if (!workflow || workflow.archivedAt) throw new EngineError("NOT_FOUND", message("workflows.notFound"));
    const [version] = await tx
      .select({ def: workflowVersions.def })
      .from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, workflow.currentVersion)));
    const def = version!.def;
    const [issue] = await runIssues(tx, workflow.ownerId, def);
    if (issue) throw new EngineError("INVALID", message(issue.message.key, issue.message.values));
    const runId = newId("run");
    await tx.insert(runs).values({ id: runId, workspaceId: workflow.workspaceId, ownerId: workflow.ownerId, workflowId, version: workflow.currentVersion, status: "running", trigger, traceId: currentTraceId() ?? null });
    counts.counter("dispand.runs.created").add(1, { "dispand.run.source": "workflow", "dispand.run.trigger": trigger.type });
    // A loop's body gets its rows when each iteration opens.
    const top = nodesOf(def).filter((n) => n.loopId === undefined);
    const harnessOf = await agentHarnesses(tx, workflow.ownerId, top);
    await tx.insert(stepRuns).values(top.map((n) => ({ id: newId("step"), ownerId: workflow.ownerId, runId, nodeId: n.id, harnessId: harnessOf(n), status: "pending" as const })));
    return runId;
  }

  /** Starts a Job of the owner's trigger (a manual start) and returns its id. */
  async startJob(triggerId: string, ownerId: string, timezone?: string, skillId?: string): Promise<string> {
    const runId = await this.db.transaction(async (tx) => {
      const [trigger] = await tx
        .select({ agentId: triggers.agentId })
        .from(triggers)
        .where(and(eq(triggers.id, triggerId), eq(triggers.ownerId, ownerId)));
      if (!trigger) throw new EngineError("NOT_FOUND", message("triggers.notFound"));
      const id = await this.createJob(tx, { ownerId, agentId: trigger.agentId, triggerId, cause: { kind: "user", depth: 0 }, firing: { type: "manual", ...(timezone ? { timezone } : {}) } });
      if (skillId) {
        const [run] = await tx.select().from(runs).where(eq(runs.id, id));
        if (!run?.snapshot || run.def?.trigger.field.type !== "chat") throw new EngineError("INVALID", message("engine.skillChatOnly"));
        const selected = await invokedSnapshot(tx, ownerId, run.snapshot, skillId);
        await tx.update(runs).set({ snapshot: selected.snapshot }).where(eq(runs.id, id));
      }
      return id;
    });
    await this.announceCheckpoints();
    await this.continueRun(runId);
    return runId;
  }

  /**
   * Publishes the checkpoint Approvals `createJob` asked whose transaction committed. One not
   * found yet may be another transaction's, still under way: it is looked for again next time,
   * for a minute (a rolled-back one never shows up).
   */
  async announceCheckpoints(): Promise<void> {
    const ids = [...this.checkpointed.keys()];
    if (ids.length === 0) return;
    const asked = await this.db.select().from(questions).where(inArray(questions.id, ids));
    for (const q of asked) {
      this.checkpointed.delete(q.id);
      this.publish([{ type: "question", question: questionView(q) }]);
    }
    for (const [id, at] of this.checkpointed) if (Date.now() - at > 60_000) this.checkpointed.delete(id);
  }

  /**
   * Inserts a Job (a run of the agent, for one firing of its trigger) and its steps, in `tx`,
   * without starting anything, like `createRun`. The Job keeps the agent and the trigger as
   * they are now: later edits don't change it. Every Job is made here, and counted against its
   * root cause (`rootId`, or a new root of its own): the root's row stays locked until `tx`
   * commits, so Jobs of one root are counted one after the other, and the Job that reaches the
   * workspace's checkpoint pauses the root and asks a person (`roots.ts`). A paused root still
   * gets the Jobs of a claim already under way; a stopped one gets none.
   */
  async createJob(
    tx: Tx,
    input: { ownerId: string; agentId: string; triggerId?: string; cause: JobCause; firing: RunTrigger; rootId?: string },
  ): Promise<string> {
    const { ownerId, agentId, triggerId, cause, firing } = input;
    const runId = newId("run");
    // An existing root first, then the trigger and the agent (`roots.ts`); a new one is no one else's yet.
    const lockRoot = async (rootId: string) => {
      const [root] = await tx.select().from(roots).where(and(eq(roots.id, rootId), eq(roots.ownerId, ownerId))).for("update");
      if (!root) throw new EngineError("NOT_FOUND", message("engine.rootNotFound"));
      if (root.state === "stopped") throw new EngineError("STOPPED", message("engine.stoppedAtCheckpoint"));
      return root;
    };
    const given = input.rootId ? await lockRoot(input.rootId) : undefined;
    // Shared with other starts, exclusive with a delete: a delete sees this Job and stops it, or
    // this start finds no agent. The trigger first, then the agent: the order the scheduler and a
    // delete take them in (`deleteAgents`), so none of them waits on another.
    // A consulted Job has no trigger: its firing is the consult, and its root the asking Job's.
    const [trigger] = triggerId
      ? await tx
          .select()
          .from(triggers)
          .where(and(eq(triggers.id, triggerId), eq(triggers.agentId, agentId), eq(triggers.ownerId, ownerId)))
          .for("share")
      : [];
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
      .for("share");
    if (!agent) throw new EngineError("NOT_FOUND", message("agent.notFound"));
    // A consult's and a Stem Job's firing is no trigger: the consult's root is the asking Job's; a Stem Job's, the owner's hand-off.
    if (firing.type === "consult" ? triggerId || !given : firing.type === "stem" ? !!triggerId : !trigger || !trigger.enabled) throw new EngineError("NOT_FOUND", message("triggers.notFound"));
    const root = given ?? (await lockRoot(await newRoot(tx, ownerId, cause.kind === "stem" ? "user" : (cause.kind as RootKind), runId)));
    const rootId = root.id;
    // A Stem Job decides the fields handed to it and nothing else: no skill, tool, bundle, memory or consult, and one tool of Dispand's.
    const stem = firing.type === "stem";
    const { skills, tools } = stem ? { skills: [], tools: [] } : await skillsAndTools(tx, agentId);
    const snapshot: AgentSnapshot = {
      id: agent.id,
      name: agent.name,
      harnessId: agent.harnessId,
      systemPrompt: jobSystemPrompt(agent),
      ...(agent.model ? { model: agent.model } : {}),
      skills,
      tools: tools.map(({ toolId, name }) => ({ toolId, name })),
      bundles: stem ? [] : agent.bundles,
      tables: stem ? [] : agent.dataTables,
      selfLearning: stem ? [] : agent.selfLearning,
      consults: stem ? [] : await consultsOf(tx, agentId),
      ...(stem ? { only: ["plugin_decide"] } : {}),
      revision: agent.revision,
    };
    const def = jobDef({ agent: snapshot, trigger: trigger ?? null, stem });
    const token = this.secrets ? issueJobToken(this.secrets, runId) : undefined;
    // The Job's own span, in the trigger's or the request's trace: all its later work hangs under it (`inJobTrace`).
    // Under its own id: a consulted Job is made inside its asking Job's work.
    const span = withJob(runId, () => markSpan(traces, "engine.job", { "dispand.job.id": runId, "dispand.agent.id": agentId, "dispand.run.trigger": firing.type }));
    await tx.insert(runs).values({
      id: runId,
      workspaceId: agent.workspaceId,
      ownerId,
      source: "agent",
      ...(token ? { tokenHash: token.hash, tokenSealed: token.sealed } : {}),
      version: 0,
      agentId,
      triggerId: triggerId ?? null,
      def,
      snapshot,
      cause,
      rootId,
      status: "running",
      trigger: firing,
      traceId: span?.traceId ?? null,
      spanId: span?.spanId ?? null,
    });
    counts.counter("dispand.runs.created").add(1, { "dispand.run.source": "agent", "dispand.run.trigger": firing.type });
    await recordJobEvent(tx, { id: runId, ownerId, agentId, triggerId: triggerId ?? null, cause, status: "running", rootId }, "created");
    const creator = creatorOf(ownerId, cause);
    // In the Job's trace, which is a new one when nothing was traced around its creation (a recovery).
    await inJobTrace(span ?? {}, () => recordAudit(tx, {
      ownerId,
      actor: creator,
      // A consult's row is its asking Job's; any other is filed under the Job's agent.
      ...(creator.type === "job" ? {} : { agentId }),
      jobId: runId,
      action: "job.created",
      resource: { type: "job", id: runId },
      details: {
        agentId,
        agentName: agent.name,
        ...(trigger ? { triggerId: trigger.id, triggerName: trigger.name } : {}),
        rootId,
        causeKind: cause.kind,
        firing: firing.type,
        ...(cause.kind === "event" ? { eventId: cause.eventId } : {}),
      },
    }));
    await tx
      .insert(stepRuns)
      .values(nodesOf(def).map((n) => ({ id: newId("step"), ownerId, runId, nodeId: n.id, harnessId: n.agentId ? snapshot.harnessId : null, status: "pending" as const })));
    const jobs = root.jobs + 1;
    const [counted] = await tx
      .update(roots)
      .set({ jobs, runId: root.runId ?? runId })
      .where(eq(roots.id, rootId))
      .returning();
    if (root.state === "going" && !root.dontAsk && jobs - root.countedFrom >= (await checkpointOf(tx, ownerId))) {
      this.checkpointed.set(await pause(tx, counted!, jobs, runId), Date.now());
    }
    return runId;
  }

  /**
   * Stops a run by hand: every step still open fails with `STOPPED` (a step that never started
   * too, so nothing of the run is left open), its pending questions expire, the run fails, and
   * its sessions are told to end. A stop that doesn't reach a runner is sent again when the
   * runner is back with the session (`reconcile`).
   */
  async stopRun(runId: string): Promise<void> {
    const out: Out[] = [];
    const sessions = await this.db.transaction(async (tx) => {
      // The root before the run, the order the paths that lock a root `FOR UPDATE` take them in (a chat, a consult): the run's end event references the root.
      const [rooted] = await tx.select({ rootId: runs.rootId }).from(runs).where(eq(runs.id, runId));
      if (rooted?.rootId) await tx.select({ id: roots.id }).from(roots).where(eq(roots.id, rooted.rootId)).for("key share");
      const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).for("update");
      if (!run) throw new EngineError("NOT_FOUND", message("workflows.runNotFound"));
      if (!ACTIVE_RUN.includes(run.status)) throw new EngineError("CLOSED", message("engine.runOver"));
      return this.stopIn(tx, runId, out);
    });
    this.publish(out);
    this.endSessions(sessions);
    // Its queued messages can't go any more: they fail, saying so.
    for (const step of sessions) if (step.start?.interactive) await this.drainQueue(step.id);
  }

  /** Stops the reported turn, without ending its Job or treating a pending question as approved. */
  async interruptChat(runId: string, turnId: string): Promise<{ outcome: InterruptOutcome }> {
    return traces.startActiveSpan("engine.interrupt", { attributes: { "dispand.run.id": runId, "dispand.turn.id": turnId } }, async (span): Promise<{ outcome: InterruptOutcome }> => {
      try {
        const [run] = await this.db.select().from(runs).where(eq(runs.id, runId));
        if (!run) throw new EngineError("NOT_FOUND", message("workflows.runNotFound"));
        const [step] = await this.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.turnId, turnId), eq(stepRuns.turnStatus, "running"), eq(stepRuns.interruptible, true), inArray(stepRuns.status, ACTIVE_STEP)));
        if (!ACTIVE_RUN.includes(run.status) || !step?.start?.interactive || !step.sessionId) return { outcome: "stale" };
        const [lastInput] = await this.db.select({ position: messages.position }).from(messages).where(and(eq(messages.stepRunId, step.id), eq(messages.role, "user"))).orderBy(desc(messages.position)).limit(1);
        const [target] = await this.db.update(stepRuns).set({ interruptAfterPosition: lastInput?.position ?? -1 }).where(and(eq(stepRuns.id, step.id), eq(stepRuns.sessionId, step.sessionId), eq(stepRuns.turnId, turnId), eq(stepRuns.interruptible, true), eq(stepRuns.turnStatus, "running"), inArray(stepRuns.status, ACTIVE_STEP))).returning();
        if (!target) return { outcome: "stale" };
        let outcome: InterruptOutcome;
        try {
          outcome = await this.adapter.interrupt?.(step.sessionId, turnId) ?? "failed";
        } catch {
          outcome = "failed";
        }
        span.setAttribute("dispand.result", outcome);
        const out: Out[] = [];
        await this.db.transaction(async (tx) => {
          if (run.rootId) await tx.select({ id: roots.id }).from(roots).where(eq(roots.id, run.rootId)).for("key share");
          await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for("update");
          if (run.source === "agent") await recordAudit(tx, { ownerId: run.ownerId, actor: { type: "user", userId: run.ownerId }, agentId: run.agentId, jobId: runId, action: "job.turnInterrupt", resource: { type: "job", id: runId }, details: { status: outcome } });
          if (outcome !== "requested") return;
          await this.withdrawTurn(tx, step, turnId, out);
        });
        this.publish(out);
        await this.drainQueue(step.id);
        return { outcome };
      } finally {
        span.end();
      }
    });
  }

  private async withdrawTurn(tx: Tx, step: StepRow, turnId: string, out: Out[]) {
    const [current] = await tx.update(stepRuns).set({ interruptible: false }).where(and(eq(stepRuns.id, step.id), eq(stepRuns.sessionId, step.sessionId!), eq(stepRuns.turnId, turnId), inArray(stepRuns.status, ACTIVE_STEP))).returning();
    if (!current) return;
    out.push({ type: "step", step: stepView(current) });
    await this.expire(tx, eq(questions.stepRunId, step.id), out, "stopped");
    await this.syncWaiting(tx, step.id, step.runId, out);
    if (current.turnStatus === "idle" && await this.interruptedInputFinished(tx, current)) {
      // Consume the cleanup boundary before a continuation can claim another slot or queue position.
      await tx.update(stepRuns).set({ interruptAfterPosition: null }).where(eq(stepRuns.id, current.id));
      await release(tx, current, out);
    }
  }

  private async interruptedInputFinished(tx: Tx, step: StepRow): Promise<boolean> {
    if (step.interruptAfterPosition === null) return false;
    if (step.harness?.kind === "codex") return true;
    const [newer] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.stepRunId, step.id), eq(messages.role, "user"), sql`${messages.position} > ${step.interruptAfterPosition}`)).limit(1);
    return !newer;
  }

  /** Fails every open step of the run, and the run, in `tx`; returns the steps, whose sessions end once it commits (`endSessions`). */
  private async stopIn(tx: Tx, runId: string, out: Out[], reason: StopReason = "stopped"): Promise<StepRow[]> {
    const open = await tx
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, runId), inArray(stepRuns.status, OPEN_STEP)));
    for (const step of open) await this.fail(tx, step, STOPPED, out, reason);
    // A run with no step open (between two steps) is closed here.
    await this.finishRun(tx, runId, "failed", STOPPED, out, reason);
    return open;
  }

  /**
   * The sessions of steps just stopped are told to end. One the process doesn't reach (it stops
   * first) is ended by its runner's next reconcile: no step still going waits on it.
   */
  private endSessions(sessions: StepRow[]) {
    for (const step of sessions) {
      // A Tool step's call under way is cut: it must not act after the stop.
      this.toolCalls.get(step.id)?.abort();
      if (step.sessionId && step.runnerId && ACTIVE_STEP.includes(step.status)) this.stopSession(step.sessionId, step.runnerId);
    }
  }

  /** Tells the harness to end a session, without waiting for it. */
  private stopSession(sessionId: string, source: string) {
    this.keep(
      this.adapter
        .stop(sessionId, source)
        .then(() => undefined)
        .catch((err: unknown) => logError("session stop failed", err, { ref: sessionId })),
    );
  }

  /** Runs what is ready in the run (the trigger completes, first steps start). */
  async continueRun(runId: string): Promise<void> {
    await this.advance(runId);
  }

  /**
   * The owner's next chat message to the run's chat session. While the chat is busy (a turn under
   * way or about to start, or messages queued before it) it is queued instead (`chat_queue`), and
   * sent once the chat is idle (`drainQueue`); returns its id then.
   */
  async sendChat(runId: string, text: string, skillId?: string, attachmentIds: string[] = [], continueChat = false): Promise<{ queuedId?: string }> {
    return this.chatInput(runId, { text, skillId, attachmentIds, continueChat });
  }

  /**
   * Sends one message to the run's chat: the owner's (`text`), or a queued one (`queuedId`), which
   * goes only while it is still pending and the chat is idle: its claim and its message are one
   * transaction, under the chat step's lock, so an edit or removal and this dispatch have one
   * winner, and a dispatched item is written once.
   */
  private async chatInput(runId: string, input: { text: string; skillId?: string; attachmentIds: string[]; continueChat: boolean } | { queuedId: string }): Promise<{ queuedId?: string; sent?: boolean; skipped?: "busy" | "gone" }> {
    const steps = await this.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    const candidate = steps.find((s) => s.start?.interactive && s.sessionId) ?? (await this.unstartedChat(runId, steps, "continueChat" in input && input.continueChat));
    if (!candidate) throw new EngineError("CLOSED", message("engine.chatOver"));
    const out: Out[] = [];
    const result = await this.db.transaction(async (tx) => {
      // Lock the root before the chat step, as checkpoint answers do. Completion and this
      // message serialize on the step: a message racing completion either sends or reopens.
      let going = await rootGoingLocked(tx, runId);
      let [chat] = await tx.select().from(stepRuns).where(eq(stepRuns.id, candidate.id)).for("update");
      if (!chat) throw new EngineError("CLOSED", message("engine.chatOver"));
      let text: string, skillId: string | undefined, files: MessageFile[] | undefined, id: string | undefined;
      if ("queuedId" in input) {
        if (await this.chatBusy(tx, chat, false)) return { skipped: "busy" as const };
        // Locked, read as an edit committed it: an edit or removal still to come finds it dispatched.
        const [item] = await tx.select().from(chatQueue).where(and(eq(chatQueue.id, input.queuedId), eq(chatQueue.stepRunId, chat.id), eq(chatQueue.state, "pending"))).for("update");
        if (!item) return { skipped: "gone" as const };
        // Its words and files are the message's now.
        const [dispatched] = await tx.update(chatQueue).set({ state: "dispatched", text: "", files: null, updatedAt: new Date() }).where(eq(chatQueue.id, item.id)).returning();
        out.push({ type: "queued", queued: queuedView(dispatched!) });
        spanEvent("engine.queue", { "dispand.queue.action": "dispatch", "dispand.step.id": chat.id });
        ({ id, text } = item);
        skillId = item.skillId ?? undefined;
        files = item.files ?? [];
      } else {
        ({ text, skillId } = input);
        if (await this.chatBusy(tx, chat, true)) {
          const taken = await takeChatFiles(tx, chat.ownerId, runId, input.attachmentIds);
          const [item] = await tx.insert(chatQueue).values({ id: newId("msg"), ownerId: chat.ownerId, runId, stepRunId: chat.id, text, skillId: skillId ?? null, ...(taken.length ? { files: taken } : {}) }).returning();
          out.push({ type: "queued", queued: queuedView(item!) });
          spanEvent("engine.queue", { "dispand.queue.action": "enqueue", "dispand.step.id": chat.id });
          return { queuedId: item!.id };
        }
      }
      const previous = chat;
      if (!OPEN_STEP.includes(chat.status)) {
        chat = await this.reopen(tx, chat, out, "continueChat" in input && input.continueChat);
        going = true;
      } else if (going) {
        await tx.update(runs).set({ rootId: await newRoot(tx, chat.ownerId, "chat", runId) }).where(eq(runs.id, runId));
      }
      let refresh = false;
      if (skillId) {
        const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
        if (!run?.snapshot || run.def?.trigger.field.type !== "chat") throw new EngineError("INVALID", message("engine.skillChatOnly"));
        const selected = await invokedSnapshot(tx, run.ownerId, run.snapshot, skillId, chat.runnerId === CLOUD_SOURCE ? null : chat.runnerId ?? undefined);
        refresh = !run.snapshot.skills.some((s) => s.packageId === selected.packageId) || selected.snapshot.tools.some((t) => !run.snapshot!.tools.some((old) => old.toolId === t.toolId));
        if (refresh && OPEN_STEP.includes(previous.status) && chat.sessionId && (chat.working || !chat.cliSessionId)) throw new EngineError("INVALID", message("engine.skillWait"));
        await tx.update(runs).set({ snapshot: selected.snapshot }).where(eq(runs.id, runId));
        // CLI invocations retain their native name; cloud sessions use the skill loader.
        const args = text.replace(/^\/\S+/, "");
        if (chat.runnerId === CLOUD_SOURCE) text = `Use the ${selected.invocation} skill.${args}`;
      }
      if (refresh && chat.sessionId && !chat.resumeAfterSession && chat.cliSessionId && chat.start) {
        const sessionId = newId("ses");
        const [updated] = await tx.update(stepRuns).set({ sessionId, turnStatus: "unknown", turnId: null, interruptible: false, interruptAfterPosition: null, codexInputId: null, start: { ...chat.start, sessionId }, startDeliveredAt: null, lastActivityAt: null, eventSeq: 0, working: false, queuedAt: null, queueClass: null, pendingAction: { kind: "resume" }, resumeAfterSession: { sessionId: chat.sessionId, ended: false } }).where(eq(stepRuns.id, chat.id)).returning();
        chat = updated!;
      }
      // Files held for the owner become the Job's with the message that carries them.
      files ??= await takeChatFiles(tx, chat.ownerId, runId, "attachmentIds" in input ? input.attachmentIds : []);
      const [row] = await tx.insert(messages).values({ id: id ?? newId("msg"), ownerId: chat.ownerId, runId, stepRunId: chat.id, role: "user", text, ...(files.length ? { files } : {}) }).returning();
      out.push({ type: "message", message: messageView(row!) });
      if (chat.resumeAfterSession) return { row: row!, working: false, chat };
      if (!chat.sessionId) return { row: row!, working: true, chat, restart: !OPEN_STEP.includes(previous.status), previous };
      // Codex followups stay in the database until the current turn gives its slot back.
      if (chat.harness?.kind === "codex" && (chat.turnStatus !== "idle" || chat.codexInputId)) return { row: row!, working: false, chat };
      if (!going) {
        await this.hold(tx, chat.id, { kind: "deliver" }, out);
        return { row: row!, working: false, chat };
      }
      if (!chat.harnessId) return { row: row!, working: true, chat };
      const got = await this.takeChatSlot(tx, chat, out);
      return { row: row!, working: got === "working", chat };
    });
    this.publish(out);
    if ("skipped" in result) return { skipped: result.skipped };
    if ("queuedId" in result) return result;
    const { row, working, chat } = result;
    if (chat.resumeAfterSession) {
      await this.resume(chat);
      return { sent: true };
    }
    if (chat.sessionId) {
      if (working) this.deliverMessage(chat, row);
      return { sent: true };
    }
    if (result.restart) {
      if (result.previous.sessionId && result.previous.runnerId) this.stopSession(result.previous.sessionId, result.previous.runnerId);
      await this.advance(runId);
      return { sent: true };
    }
    // Queued for its start: the start sends what is stored by then. If it was written meanwhile,
    // this one goes as any message to a started chat (its first turn may be over by now), unless
    // the start's flush sent it already.
    const [now] = await this.db.select().from(stepRuns).where(eq(stepRuns.id, chat.id));
    if (!now?.sessionId || !now.startDeliveredAt) return { sent: true };
    const late: Out[] = [];
    const going = await this.db.transaction(async (tx) => {
      if (!(await rootGoing(tx, runId))) {
        await this.hold(tx, now.id, { kind: "deliver" }, late);
        return false;
      }
      return (await this.takeChatSlot(tx, now, late)) === "working";
    });
    this.publish(late);
    if (going) await this.redeliverMessage(row.id);
    return { sent: true };
  }

  /**
   * Whether a message to the chat waits: its turn is under way, or a message sent to it hasn't seen
   * a turn end since (not acknowledged); for the owner's new one, also when others are queued
   * before it. A closed chat is no turn: what goes to it reopens it, or fails saying why.
   */
  private async chatBusy(tx: Tx, chat: StepRow, owner: boolean): Promise<boolean> {
    const open = OPEN_STEP.includes(chat.status);
    if (open && chat.turnStatus === "running") return true;
    if (!open && !owner) return false;
    const inFlight = or(eq(chatQueue.state, "steering"), and(eq(chatQueue.state, "dispatched"), isNull(chatQueue.ackedAt)));
    const waiting = open && owner ? or(eq(chatQueue.state, "pending"), inFlight) : open ? inFlight : eq(chatQueue.state, "pending");
    const [row] = await tx.select({ id: chatQueue.id }).from(chatQueue).where(and(eq(chatQueue.stepRunId, chat.id), waiting)).limit(1);
    return !!row;
  }

  /**
   * Sends the chat's oldest queued message once it is idle: one per turn, the next at that turn's
   * end. One it can't send (the chat is over, its skill can't be used) fails, and the next one is
   * tried. Called wherever a chat may have become idle; a dispatch that finds it busy changes nothing.
   */
  private async drainQueue(stepId: string): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      const [item] = await this.db.select({ id: chatQueue.id, runId: chatQueue.runId }).from(chatQueue)
        .where(and(eq(chatQueue.stepRunId, stepId), eq(chatQueue.state, "pending"))).orderBy(asc(chatQueue.position)).limit(1);
      if (!item || tried.has(item.id)) return;
      tried.add(item.id);
      try {
        // Removed meanwhile: the next one is tried.
        if ((await this.chatInput(item.runId, { queuedId: item.id })).skipped !== "gone") return;
      } catch (err) {
        if (!(err instanceof EngineError)) return logError("queued chat message dispatch failed", err, { ref: item.id });
        const [failed] = await this.db.update(chatQueue).set({ state: "failed", error: JSON.stringify(err.data), updatedAt: new Date() })
          .where(and(eq(chatQueue.id, item.id), eq(chatQueue.state, "pending"))).returning();
        if (failed) {
          spanEvent("engine.queue", { "dispand.queue.action": "fail", "dispand.step.id": stepId });
          this.publish([{ type: "queued", queued: queuedView(failed) }]);
        }
      }
    }
  }

  /**
   * Sends a pending queued message now, into the turn running (`HarnessAdapter.steer`). Its claim
   * is the dispatch's (one transaction under the chat step's lock, the item locked while pending),
   * so it, an edit, a removal and the normal dispatch have one winner. The harness delivers it once
   * either way: joined to the turn, or as the next message when the turn ended first; the item stays
   * `steering` (in flight) until its `steer-result` or the turn's end says which.
   */
  async steerQueued(runId: string, queuedId: string): Promise<void> {
    const steps = await this.db.select({ id: stepRuns.id, start: stepRuns.start, sessionId: stepRuns.sessionId }).from(stepRuns).where(eq(stepRuns.runId, runId));
    const candidate = steps.find((s) => s.start?.interactive && s.sessionId);
    const out: Out[] = [];
    const { chat, row, turnId } = await this.db.transaction(async (tx) => {
      const going = await rootGoingLocked(tx, runId);
      const [chat] = candidate ? await tx.select().from(stepRuns).where(eq(stepRuns.id, candidate.id)).for("update") : [];
      const [item] = await tx.select().from(chatQueue).where(and(eq(chatQueue.id, queuedId), eq(chatQueue.runId, runId), eq(chatQueue.state, "pending"))).for("update");
      if (!item || !chat || item.stepRunId !== chat.id) throw new EngineError("NOT_PENDING", message("engine.queuedGone"));
      // Only into a turn under way that the harness can take it in; a skill may replace the session, so it waits.
      const live = going && OPEN_STEP.includes(chat.status) && chat.turnStatus === "running" && chat.turnId && !chat.resumeAfterSession && chat.interruptAfterPosition === null;
      if (!live || !chat.harness || item.skillId) throw new EngineError("CLOSED", message("engine.steerUnavailable"));
      const [steered] = await tx.update(chatQueue).set({ state: "steering", text: "", files: null, updatedAt: new Date() }).where(eq(chatQueue.id, item.id)).returning();
      out.push({ type: "queued", queued: queuedView(steered!) });
      const [row] = await tx.insert(messages).values({ id: item.id, ownerId: chat.ownerId, runId, stepRunId: chat.id, role: "user", text: item.text, ...(item.files?.length ? { files: item.files } : {}) }).returning();
      out.push({ type: "message", message: messageView(row!) });
      spanEvent("engine.queue", { "dispand.queue.action": "steer", "dispand.step.id": chat.id });
      return { chat, row: row!, turnId: chat.turnId! };
    });
    this.publish(out);
    this.deliverMessage(chat, row, turnId);
  }

  /** Changes a queued message's words, only while it is pending: once dispatched, it is the conversation's. */
  async editQueued(runId: string, queuedId: string, text: string): Promise<void> {
    const [item] = await this.db.update(chatQueue).set({ text, updatedAt: new Date() })
      .where(and(eq(chatQueue.id, queuedId), eq(chatQueue.runId, runId), eq(chatQueue.state, "pending"))).returning();
    if (!item) throw new EngineError("NOT_PENDING", message("engine.queuedGone"));
    spanEvent("engine.queue", { "dispand.queue.action": "edit", "dispand.step.id": item.stepRunId });
    this.publish([{ type: "queued", queued: queuedView(item) }]);
  }

  /**
   * Takes a queued message back, pending or failed; its words are not kept, and its files are the
   * Job's no more: held again, the sweep removes them as it does a message's never sent.
   */
  async removeQueued(runId: string, queuedId: string): Promise<void> {
    const item = await this.db.transaction(async (tx) => {
      const [before] = await tx.select({ files: chatQueue.files }).from(chatQueue)
        .where(and(eq(chatQueue.id, queuedId), eq(chatQueue.runId, runId), inArray(chatQueue.state, ["pending", "failed"]))).for("update");
      if (!before) return undefined;
      const ids = (before.files ?? []).map((f) => f.id);
      if (ids.length) await tx.update(attachments).set({ jobId: null }).where(and(inArray(attachments.id, ids), eq(attachments.jobId, runId), isNull(attachments.tableId)));
      const [removed] = await tx.update(chatQueue).set({ state: "removed", text: "", files: null, updatedAt: new Date() }).where(eq(chatQueue.id, queuedId)).returning();
      return removed;
    });
    if (!item) throw new EngineError("NOT_PENDING", message("engine.queuedGone"));
    spanEvent("engine.queue", { "dispand.queue.action": "remove", "dispand.step.id": item.stepRunId });
    this.publish([{ type: "queued", queued: queuedView(item) }]);
  }

  /** A new turn in the same run, keeping its transcript but replacing its session (and a Job's token). */
  private async reopen(tx: Tx, step: StepRow, out: Out[], continueChat: boolean): Promise<StepRow> {
    const [run] = await tx.select().from(runs).where(eq(runs.id, step.runId));
    const def = run && (await defOf(run, tx));
    if (!run || !def || continuationNode(run, def) !== step.nodeId || step.status !== run.status || (run.tokenSealed && !this.secrets)) throw new EngineError("CLOSED", message("engine.chatOver"));
    // Retain automatic continuation for a successful chat with history. A failure racing an
    // initial send needs a new submission from the owner before starting work again.
    if (!continueChat && !(run.status === "succeeded" && step.cliSessionId)) throw new EngineError("CLOSED", message("engine.chatOver"));
    let harness = step.harness;
    let sameHarness = true;
    if (continueChat) {
      const node = nodesOf(def).find((n) => n.id === step.nodeId)!;
      const current = await sessionHarness(tx, run, node, step);
      if ("problem" in current) {
        const reason = storedText(current.problem);
        if ("key" in reason) throw new EngineError("CLOSED", message(reason.key, reason.values));
        throw new EngineError("CLOSED", message("engine.chatRunnerGone"));
      }
      harness = current.harness;
      sameHarness = harness.id === step.harness?.id && harness.kind === step.harness.kind && (isCloud(harness) || harness.runnerId === step.runnerId);
    }
    if (sameHarness && step.runnerId && step.runnerId !== CLOUD_SOURCE) {
      const [runner] = await tx.select({ revokedAt: runners.revokedAt }).from(runners).where(and(eq(runners.id, step.runnerId), eq(runners.ownerId, run.ownerId), eq(runners.workspaceId, run.workspaceId))).for("share");
      if (!runner || runner.revokedAt) throw new EngineError("CLOSED", message("engine.chatRunnerGone"));
    }
    const job = run.source === "agent";
    const token = job && this.secrets ? issueJobToken(this.secrets, run.id) : null;
    const [reopened] = await tx.update(runs).set({ status: "running", error: null, finishedAt: null, ...(job ? { rootId: await newRoot(tx, run.ownerId, "chat", run.id) } : {}), ...(token ? { tokenHash: token.hash, tokenSealed: token.sealed } : {}) }).where(and(eq(runs.id, run.id), eq(runs.status, run.status))).returning();
    if (!reopened) throw new EngineError("CLOSED", message("engine.chatOver"));
    const sessionId = newId("ses");
    // A resume the runner got but that failed before any activity: its transcript is taken as gone,
    // and the next send starts fresh, told the conversation so far (`openSession`).
    // shortcut: no runner signal says a transcript is gone, so a refusal before the CLI launched
    // (an MCP config error) also starts fresh; add a structured reason to the protocol if that bites.
    const missingTranscript = step.start?.resumeCliSessionId && step.startDeliveredAt && !step.lastActivityAt && step.status === "failed";
    const next = sameHarness && !missingTranscript && harness && step.sessionId && step.start ? {
      status: "running" as const, sessionId, harness, start: { ...step.start, sessionId, ...(step.cliSessionId ? { resumeCliSessionId: step.cliSessionId } : {}) },
      pendingAction: { kind: "resume" as const }, resumeAfterSession: { sessionId: step.sessionId, ended: false },
    } : {
      status: "pending" as const, sessionId: null, harness: null, start: null, runnerId: harness ? (isCloud(harness) ? CLOUD_SOURCE : harness.runnerId) : null,
      cliSessionId: null, pendingAction: null, resumeAfterSession: null,
    };
    if (!next.sessionId) {
      // A fresh session hasn't had the owner's messages since the agent's last answer: they go to
      // it as messages again (with their files); what came before is told in its start prompt.
      const [answer] = await tx.select({ position: messages.position }).from(messages).where(and(eq(messages.stepRunId, step.id), eq(messages.role, "assistant"))).orderBy(desc(messages.position)).limit(1);
      await tx.update(messages).set({ deliveredAt: null }).where(and(eq(messages.stepRunId, step.id), eq(messages.role, "user"), isNotNull(messages.deliveredAt), answer ? sql`${messages.position} > ${answer.position}` : undefined));
    }
    const [chat] = await tx.update(stepRuns).set({ ...next, error: null, outputs: null, turnStatus: "unknown", turnId: null, interruptible: false, interruptAfterPosition: null, codexInputId: null, finishedAt: null, startDeliveredAt: null, lastActivityAt: null, eventSeq: 0, working: false, queuedAt: null, queueClass: null }).where(eq(stepRuns.id, step.id)).returning();
    // A failed workflow's steps after the chat that never started (closed by the stop or failure)
    // wait for it again; a finished one's stay as they ended (a skipped branch is not reconsidered).
    const waiting = job || run.status !== "failed" ? [] : await tx.update(stepRuns).set({ status: "pending", error: null, finishedAt: null, queuedAt: null, queueClass: null, pendingAction: null })
      .where(and(eq(stepRuns.runId, run.id), ne(stepRuns.id, step.id), isNull(stepRuns.startedAt), inArray(stepRuns.status, ["failed", "skipped"]))).returning();
    for (const row of waiting) out.push({ type: "step", step: stepView(row) });
    if (job) await recordAudit(tx, { ownerId: run.ownerId, actor: { type: "user", userId: run.ownerId }, agentId: run.agentId, jobId: run.id, action: "job.reopened", resource: { type: "job", id: run.id } });
    spanEvent("engine.reopen", { "dispand.job.id": run.id, "dispand.step.id": step.id, ...(next.sessionId ? { "dispand.session.id": next.sessionId } : {}) });
    out.push({ type: "run", run: runView(reopened, def) }, { type: "step", step: stepView(chat!) });
    return chat!;
  }

  /** A process-ended acknowledgement, or a hello without that process, releases its resume. */
  private async retired(sessionId: string, runnerId: string) {
    const rows = await this.db.update(stepRuns).set({ resumeAfterSession: { sessionId, ended: true } }).where(and(sessionSource(this.db, runnerId), inArray(stepRuns.status, ACTIVE_STEP), sql`${stepRuns.resumeAfterSession}->>'sessionId' = ${sessionId}`, sql`${stepRuns.resumeAfterSession}->>'ended' = 'false'`)).returning();
    for (const step of rows) await this.resume(step);
  }

  /** Sends the answers and chat messages that wait for the step's session (it holds a slot). */
  private async flush(step: StepRow) {
    const { id: stepId, sessionId } = step;
    for (const q of await this.undeliveredAnswers(sessionId!)) this.deliverAnswer(q);
    for (const m of await undeliveredMessages(this.db, stepId)) this.deliverMessage(step, m);
  }

  /**
   * A step handed a slot does what it waited to do (`pending_action`): its start goes as its run
   * advances; its waiting answers and messages go, or its lost session resumes. Cleared as it goes:
   * the rows it sends stay undelivered until they reach the session, and every reconcile of a
   * step holding a slot sends those again.
   */
  /** Cloud input may already be delivered when an approval releases its slot. Its next turn still waits its place. */
  async claimCloudTurn(sessionId: string): Promise<boolean> {
    const [step] = await this.db.select().from(stepRuns).where(and(eq(stepRuns.sessionId, sessionId), eq(stepRuns.runnerId, CLOUD_SOURCE)));
    if (!step?.harnessId) return false;
    const out: Out[] = [];
    const working = await this.db.transaction(async (tx) => {
      const going = await rootGoingLocked(tx, step.runId);
      const [current] = await tx.select().from(stepRuns).where(and(eq(stepRuns.id, step.id), eq(stepRuns.sessionId, sessionId))).for("update");
      if (!current || !ACTIVE_STEP.includes(current.status)) return false;
      if (!going) {
        await this.hold(tx, step.id, { kind: "deliver" }, out);
        return false;
      }
      const got = await this.takeChatSlot(tx, current, out);
      return got === "working";
    });
    this.publish(out);
    return working;
  }

  /** Cloud and native followups join the person's queue; audit only a new queue entry. */
  private async takeChatSlot(tx: Tx, step: StepRow, out: Out[]): Promise<"working" | "queued"> {
    const [current] = await tx.select().from(stepRuns).where(eq(stepRuns.id, step.id)).for("update");
    if (!current || !ACTIVE_STEP.includes(current.status)) return "queued";
    if (!current.harnessId) return "working";
    const got = await take(tx, { id: current.id, harnessId: current.harnessId }, "person", { kind: "deliver" });
    if (got === "queued" && !current.queuedAt) {
      await pushStep(tx, current.id, out);
      const [job] = await tx.select({ agentId: runs.agentId, harnessName: harnesses.name }).from(runs)
        .innerJoin(harnesses, eq(harnesses.id, current.harnessId)).where(and(eq(runs.id, current.runId), eq(runs.source, "agent")));
      if (job) await recordAudit(tx, { ownerId: current.ownerId, actor: { type: "job", runId: current.runId }, agentId: job.agentId, jobId: current.runId, resource: { type: "job", id: current.runId }, action: "job.queued", details: { harnessId: current.harnessId, harnessName: job.harnessName } });
    }
    return got;
  }

  private async handOver(stepId: string) {
    const [step] = await this.db.select().from(stepRuns).where(eq(stepRuns.id, stepId));
    if (!step?.working || !step.pendingAction) return;
    if (step.resumeAfterSession) return this.resume(step);
    // Its root paused at a checkpoint meanwhile: the slot goes back, what it waited to do waits on.
    if (!(await rootGoing(this.db, step.runId))) {
      return this.holdNow(stepId, step.pendingAction);
    }
    if (step.pendingAction.kind === "start") {
      // A session whose start was never written (its runner was away): it goes again.
      if (step.sessionId && !step.startDeliveredAt && ACTIVE_STEP.includes(step.status)) {
        const [claimed] = await this.db
          .update(stepRuns)
          .set({ pendingAction: null })
          .where(and(eq(stepRuns.id, stepId), isNotNull(stepRuns.pendingAction)))
          .returning();
        if (claimed && !this.inFlight.has(`start:${claimed.sessionId}`) && !(await this.refusedForScope(claimed))) {
          await this.launch(claimed.harness!, claimed.start!, claimed);
          for (const m of await undeliveredMessages(this.db, claimed.id)) this.deliverMessage(claimed, m);
        }
        return;
      }
      return this.advance(step.runId);
    }
    const [claimed] = await this.db
      .update(stepRuns)
      .set({ pendingAction: null })
      .where(and(eq(stepRuns.id, stepId), isNotNull(stepRuns.pendingAction), inArray(stepRuns.status, ACTIVE_STEP)))
      .returning();
    if (!claimed?.sessionId) return;
    if (step.pendingAction.kind === "resume") await this.resume(claimed);
    else {
      await this.flush(claimed);
      if (claimed.runnerId === CLOUD_SOURCE) this.cloud?.resumeQueued?.(claimed.sessionId);
    }
  }

  /** The run's chat step queued for a slot of its harness, or handed one (or held) and not started yet. */
  private async unstartedChat(runId: string, steps: StepRow[], continueChat: boolean): Promise<StepRow | undefined> {
    const [run] = await this.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) return undefined;
    const def = await defOf(run, this.db);
    if (!ACTIVE_RUN.includes(run.status)) return continueChat ? steps.find((s) => s.nodeId === continuationNode(run, def)) : undefined;
    const { field } = def.trigger;
    if (field.type !== "chat") return undefined;
    // Held, too, while its root is paused at a checkpoint (`hold`).
    return steps.find((s) => s.nodeId === field.id && s.status === "pending" && (s.queuedAt || s.working || s.pendingAction || continueChat));
  }

  /** Records the owner's answer (once) and sends it to the session. */
  async answer(questionId: string, answer: Answer, by?: AnsweredBy): Promise<void> {
    const asked = await this.answerable(questionId, answer, by);
    const out: Out[] = [];
    const settled = await this.db.transaction(async (tx) => {
      // A consult's Approval may make a Job in the asking Job's root: that root is locked first (`applyEvent`).
      if (asked?.consultId) {
        await lockConsults(tx, asked.ownerId);
        await rootGoingLocked(tx, asked.runId);
      }
      const recorded = await this.recordAnswer(tx, questionId, answer, by);
      if (!recorded) return undefined;
      const { q, actor } = recorded;
      // A checkpoint's Approval: no session waits on it, its root does.
      if (q.rootId) {
        out.push({ type: "question", question: questionView(q) });
        return { q, step: null, root: await this.settleRoot(tx, q, answer, actor) };
      }
      // A consult's Approval: no session asked it, so none is sent its answer; the consult goes on or ends.
      if (q.consultId) {
        Object.assign(q, (await tx.update(questions).set({ deliveredAt: new Date() }).where(eq(questions.id, q.id)).returning())[0]);
        out.push({ type: "question", question: questionView(q) });
        await this.consultApproved(tx, q, answer, by, out);
        return { q, step: null };
      }
      await this.grantFromAnswer(tx, q, answer, by);
      return { q, step: await this.toSession(tx, q, out) };
    });
    const { q, step } = settled ?? {};
    const root = settled && "root" in settled ? settled.root : undefined;
    if (!q) throw new EngineError("NOT_PENDING", message("questions.answer.notPending"));
    await this.answered(q);
    this.publish(out);
    if (step) await this.flush(step);
    if (root?.stopped) {
      for (const events of root.stopped.outs.values()) this.publish(events);
      this.endSessions(root.stopped.sessions);
    }
    if (root?.goOn) await this.goOn(root.goOn);
  }

  /** What `answer` refuses before its transaction; the question as it was read, if any. */
  private async answerable(questionId: string, answer: Answer, by?: AnsweredBy) {
    // Any answer may have to go as words (its session lost and resumed): those must fit a message.
    const [asked] = await this.db.select({ payload: questions.payload, kind: questions.kind, ownerId: questions.ownerId, runId: questions.runId, consultId: questions.consultId }).from(questions).where(eq(questions.id, questionId));
    // Nothing answers in a consulted agent's place: only its Job does (`answerConsult`).
    if (asked?.kind === "consult") throw new EngineError("NOT_FOUND", message("questions.notFound"));
    // A plugin update's Approval is answered item by item (`plugins.resolveConflict`), never whole.
    if (asked?.payload.kind === "permission" && asked.payload.toolName === PLUGIN_UPDATE) throw new EngineError("INVALID", message("questions.answer.itemByItem"));
    if (asked) {
      const words = answerText({ payload: asked.payload, answer, answeredBy: by ?? null });
      if (words.length > TEXT || !storable(words)) throw new EngineError("INVALID", message("questions.answer.tooLong", { max: TEXT - 100 }));
    }
    return asked;
  }

  /** In `tx`, the question locked: the answer recorded once, with what it remembers; undefined when it is no longer pending. */
  private async recordAnswer(tx: Tx, questionId: string, answer: Answer, by?: AnsweredBy) {
    const [pending] = await tx.select().from(questions).where(and(eq(questions.id, questionId), eq(questions.status, "pending"))).for("update");
    if (!pending) return undefined;
    if (answer.kind === "permission" && answer.decision === "allow-always" && (pending.remember || (pending.payload.kind === "permission" && pending.payload.toolName.startsWith("mcp__")))) throw new EngineError("INVALID", message("questions.answer.chooseScope"));
    if (answer.kind === "permission" && answer.remember) {
      if (answer.decision === "allow-always" || !by || !(await remember(tx, { questionId, decision: answer.decision, scope: answer.remember, by }))) throw new EngineError("INVALID", message("questions.answer.cannotRemember"));
    }
    const [q] = await tx
      .update(questions)
      .set({ status: "answered", answer, answeredAt: new Date(), answeredBy: by ?? null, ...(answer.kind === "permission" && answer.remember && answer.decision === "allow" ? { consumedAt: new Date() } : {}) })
      .where(and(eq(questions.id, questionId), eq(questions.status, "pending")))
      .returning();
    if (!q) return undefined;
    // An agent's answer is its Job's write.
    const actor: Exclude<EventActor, { type: "step" }> = by?.type === "agent" ? { type: "job", runId: by.runId } : (by ?? { type: "user", userId: q.ownerId });
    await recordInteraction(tx, q, "answered", actor);
    return { q, actor };
  }

  /** What a session's answer grants, in `tx`, before it goes to the session: an action that stops asking, or a proposal's items. */
  private async grantFromAnswer(tx: Tx, q: QuestionRow, answer: Answer, by?: AnsweredBy) {
    // A person's "always allow" to a CLI session's approval of one of its agent's tools: that
    // action stops asking on the agent, with the answer that was just taken (an answer that
    // came second grants nothing). The answer is used up as it is given: the call it is for
    // needs no approval any more, and it must not stay for a later one. When the name stands
    // for nothing the agent chose, nothing is granted and the answer allows this call only:
    // the runner must not stop prompting for a call the endpoint would still refuse, nor for
    // an action of a runner tool the agent doesn't let run unasked.
    if (by?.type === "user" && answer.kind === "permission" && answer.decision === "allow-always" && q.payload.kind === "permission" && q.payload.toolName.startsWith("mcp__")) {
      const stopped = await stopAsking(tx as unknown as Db, q.runId, q.payload.toolName, q.about);
      const [settled] = await tx
        .update(questions)
        .set(stopped ? { consumedAt: new Date() } : { answer: { ...answer, decision: "allow" } })
        .where(eq(questions.id, q.id))
        .returning();
      Object.assign(q, settled);
    }
    // The Approval of a proposal: a person's yes approves its items, a no declines it, once.
    if (q.proposalId && answer.kind === "permission" && (answer.decision === "deny" || by?.type === "user")) {
      await settleProposal(tx as unknown as Db, q.id, answer.decision !== "deny");
    }
  }

  /** Once an answer committed: its metrics, and the sessions a remembered denial narrows. */
  private async answered(q: QuestionRow) {
    const decision = q.answer?.kind === "permission" ? q.answer.decision : q.answer?.kind ?? "none";
    counts.counter("dispand.questions.answered").add(1, { "dispand.question.kind": q.kind, "dispand.answer.decision": decision, "dispand.answer.by": q.answeredBy?.type ?? "user" });
    counts.histogram("dispand.question.wait", { unit: "ms", description: "From a question to its answer" }).record(q.answeredAt!.getTime() - q.createdAt.getTime(), { "dispand.question.kind": q.kind });
    if (q.remember?.subject.kind === "tool" && q.answer?.kind === "permission" && q.answer.remember && q.answer.decision === "deny") await this.narrowSessions(q.remember.subject.agentId, this.db, q.answer.remember === "run" ? q.runId : undefined);
  }

  /**
   * An answer was recorded, in `tx`: the step stops waiting when nothing else of it is pending, and
   * its session goes back to work once it holds a slot. Until then, and while another question is
   * pending, the answers given stay undelivered. Returns the step when it holds one now: its
   * answers go once `tx` commits.
   */
  private async toSession(tx: Tx, q: QuestionRow, out: Out[]): Promise<StepRow | null> {
    out.push({ type: "question", question: questionView(q) });
    await this.syncWaiting(tx, q.stepRunId!, q.runId, out);
    const [step] = await tx.select().from(stepRuns).where(eq(stepRuns.id, q.stepRunId!));
    if (step?.status !== "running" || !step.sessionId) return null;
    // Its root paused at a checkpoint: the answer is kept, and goes once the root goes on.
    if (!(await rootGoing(tx, step.runId))) {
      await this.hold(tx, step.id, { kind: "deliver" }, out);
      return null;
    }
    if (step.harnessId && (await take(tx, { id: step.id, harnessId: step.harnessId }, "resume", { kind: "deliver" })) === "queued") {
      await pushStep(tx, step.id, out);
      return null;
    }
    return step;
  }

  /**
   * A consult was asked, in the transaction that recorded its row: refused (answered `failed` at
   * once, with no Job), put to the owner first when its entry is flagged (`askApproval`; their yes
   * opens it again), left pending while its root is paused (`goOn` opens it), or its consulted Job
   * is made, in the asking Job's root, and starts once `tx` commits.
   */
  private async openConsult(tx: Tx, q: QuestionRow, out: Out[]): Promise<void> {
    if (q.payload.kind !== "consult") return;
    const consultedId = q.payload.agentId;
    const approval = await approvalOf(tx, q.id);
    const problem = await consultProblem(tx, q.runId, consultedId, approval !== undefined);
    if (problem === FLAGGED) return this.askApproval(tx, q, out);
    if (problem) return this.settleConsult(tx, q.id, failed(problem), null, out, "refused");
    if (approval?.status === "pending") return;
    const [asker] = await tx.select().from(runs).where(eq(runs.id, q.runId));
    const [root] = await tx.select({ state: roots.state }).from(roots).where(eq(roots.id, asker!.rootId!)).for("update");
    if (root?.state !== "going") return;
    const askingAgent = asker!.snapshot?.name ?? (await agentName(tx, asker!.agentId!));
    let runId: string;
    try {
      runId = await this.createJob(tx, {
        ownerId: q.ownerId,
        agentId: consultedId,
        cause: { kind: "consult", questionId: q.id, jobId: q.runId, depth: (asker!.cause?.depth ?? 0) + 1 },
        firing: { type: "consult", questionId: q.id, outputs: consultOutputs({ question: q.payload.question, askingAgent, askingJobId: q.runId }) },
        rootId: asker!.rootId!,
      });
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      return this.settleConsult(tx, q.id, failed(`The consulted Job couldn't be created: ${err.message}`), null, out, "failed");
    }
    await tx.update(questions).set({ consultRunId: runId }).where(eq(questions.id, q.id));
    out.push({ type: "job", runId });
  }

  /**
   * A consult of a flagged entry: one Approval asks the owner, showing the question whole, before
   * any Job is made. It is the consult's, not the session's: no session asked it, and its answer
   * goes to no session (`consultApproved`), only the consult's does.
   */
  private async askApproval(tx: Tx, q: QuestionRow, out: Out[]): Promise<void> {
    if (q.payload.kind !== "consult") return;
    const input = { agent: await agentName(tx, q.payload.agentId), question: q.payload.question };
    if (JSON.stringify(input).length > PERMISSION_INPUT) return this.settleConsult(tx, q.id, failed(TOO_LONG), null, out, "refused");
    const [row] = await tx
      .insert(questions)
      .values({
        id: newId("q"),
        ownerId: q.ownerId,
        runId: q.runId,
        stepRunId: q.stepRunId,
        placement: q.placement,
        kind: "approval",
        payload: { kind: "permission", toolName: CONSULT, input, canAlwaysAllow: true },
        status: "pending",
        consultId: q.id,
      })
      .returning();
    await recordInteraction(tx, row!, "created");
    counts.counter("dispand.questions.opened").add(1, { "dispand.question.kind": "approval" });
    out.push({ type: "question", question: questionView(row!) });
  }

  /**
   * The owner answered a consult's Approval (`askApproval`), in `tx` with the asking Job's root
   * locked: a no answers the consult `failed`; a yes opens it, and a person's "don't ask again"
   * also takes the flag off the entry, on the agent and in this Job's snapshot.
   */
  private async consultApproved(tx: Tx, approval: QuestionRow, answer: Answer, by: AnsweredBy | undefined, out: Out[]): Promise<void> {
    const [q] = await tx
      .select()
      .from(questions)
      .where(and(eq(questions.id, approval.consultId!), eq(questions.status, "pending")))
      .for("update");
    if (q?.payload.kind !== "consult" || answer.kind !== "permission") return;
    if (answer.decision === "deny") return this.settleConsult(tx, q.id, failed(DECLINED), null, out, "refused");
    if (answer.decision === "allow-always" && by?.type === "user") {
      const consultedId = q.payload.agentId;
      const [asker] = await tx.select().from(runs).where(eq(runs.id, q.runId)).for("update");
      await tx
        .update(agentConsults)
        .set({ ask: false })
        .where(and(eq(agentConsults.agentId, asker!.agentId!), eq(agentConsults.consultedId, consultedId)));
      const snapshot = asker!.snapshot!;
      const consults = snapshot.consults?.map((e) => (e.agentId === consultedId ? { ...e, ask: false } : e));
      await tx.update(runs).set({ snapshot: { ...snapshot, consults } }).where(eq(runs.id, asker!.id));
    }
    await this.openConsult(tx, q, out);
  }

  /**
   * The consulted run ended, in the transaction that ended it: its consult is answered with its
   * result, or with why it has none; or with why the asker may no longer have it, when a right
   * was taken back since.
   */
  private async answerConsult(tx: Tx, run: RunRow, out: Out[]): Promise<void> {
    if (run.trigger.type !== "consult") return;
    const [q] = await tx.select().from(questions).where(and(eq(questions.id, run.trigger.questionId), eq(questions.status, "pending")));
    if (!q) return;
    const problem = await deliveryProblem(tx, q);
    const answer = problem ? failed(problem) : await consultEnd(tx, run);
    const by: AnsweredBy = { type: "agent", agentId: run.agentId!, runId: run.id, name: run.snapshot?.name ?? (await agentName(tx, run.agentId!)) };
    await this.settleConsult(tx, q.id, answer, by, out, answer.outcome === "answered" ? "answered" : run.error === STOPPED ? "stopped" : "failed");
  }

  /** Records a consult's answer (once: a row no longer pending is left as it is) and sends it on, like `answer` does in its transaction. */
  private async settleConsult(tx: Tx, questionId: string, answer: Answer, by: AnsweredBy | null, out: Out[], outcome: "answered" | "refused" | "failed" | "stopped") {
    const [q] = await tx
      .update(questions)
      .set({ status: "answered", answer, answeredAt: new Date(), answeredBy: by })
      .where(and(eq(questions.id, questionId), eq(questions.status, "pending")))
      .returning();
    if (!q) return;
    await consultEnded(tx, q, outcome, by);
    await expireApprovals(tx, [q.id], out);
    const step = await this.toSession(tx, q, out);
    // It holds a slot: its answers go once `tx` commits, as a step handed one does (`handOver`).
    if (step) {
      await tx.update(stepRuns).set({ pendingAction: { kind: "deliver" } }).where(eq(stepRuns.id, step.id));
      out.push({ type: "slot", runId: step.runId, stepId: step.id });
    }
  }

  /**
   * Expires the pending questions `where` selects (a checkpoint's Approval excepted, which is its
   * root's), in `tx`. A consult that ends so, with no answer, stops its consulted run, and so on
   * down its chain of consults.
   */
  private async expire(tx: Tx, where: SQL, out: Out[], stop?: StopReason): Promise<void> {
    // The consulted runs first, then the consults: the order a consulted run's end takes them in (`answerConsult`).
    const consulted = tx.select({ id: questions.consultRunId }).from(questions).where(and(where, eq(questions.status, "pending"), isNull(questions.rootId)));
    await tx.select({ id: runs.id }).from(runs).where(inArray(runs.id, consulted)).for("update");
    const expired = await tx
      .update(questions)
      .set({ status: "expired" })
      .where(and(where, eq(questions.status, "pending"), isNull(questions.rootId)))
      .returning();
    await recordInteractions(tx, expired.filter((q) => q.kind !== "consult"), "expired");
    for (const q of expired) {
      if (q.proposalId) await withdrawProposal(tx, q.id);
      out.push({ type: "question", question: questionView(q) });
    }
    await expireApprovals(tx, expired.filter((q) => q.kind === "consult").map((q) => q.id), out);
    for (const q of expired) {
      if (q.kind !== "consult") continue;
      await consultEnded(tx, q, "stopped");
      if (!q.consultRunId) continue;
      const [going] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.id, q.consultRunId), inArray(runs.status, ACTIVE_RUN))).for("update");
      // Stopped for the reason its asker was, if any (a declined checkpoint, a consult taken back).
      if (going) out.push({ type: "end", steps: await this.stopIn(tx, going.id, out, stop) });
    }
  }

  /**
   * A right was taken back from these agents (an entry removed, a flag added, a bundle change
   * that breaks the `configure` rule), in the transaction that took it: every consult with one of
   * them on either side that the pair no longer allows (`deliveryProblem`), pending or answered
   * and not delivered yet, ends now with the reason. Its consulted run still going stops (and so
   * on down its chain), and an answer recorded and not delivered is replaced by the reason. What
   * it returns goes once `tx` commits (`settled`). The caller took the owner's consult lock
   * (`lockConsults`) first in `tx`.
   */
  async endConsults(tx: Tx, ownerId: string, agentIds: string[]): Promise<Out[]> {
    const out: Out[] = [];
    const asking = tx.select({ id: runs.id }).from(runs).where(and(eq(runs.ownerId, ownerId), inArray(runs.agentId, agentIds)));
    const inFlight = await tx
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, ownerId),
          eq(questions.kind, "consult"),
          or(eq(questions.status, "pending"), and(eq(questions.status, "answered"), isNull(questions.deliveredAt))),
          or(inArray(questions.runId, asking), inArray(sql`${questions.payload}->>'agentId'`, agentIds)),
        ),
      );
    const ended: { q: QuestionRow; problem: string }[] = [];
    for (const q of inFlight) {
      const problem = await deliveryProblem(tx, q);
      if (problem) ended.push({ q, problem });
    }
    // The consulted runs first, then the consults: the order a consulted run's end takes them in (`answerConsult`).
    const consulted = ended.flatMap(({ q }) => (q.status === "pending" && q.consultRunId ? [q.consultRunId] : []));
    const going = consulted.length
      ? await tx.select({ id: runs.id }).from(runs).where(and(inArray(runs.id, consulted), inArray(runs.status, ACTIVE_RUN))).for("update")
      : [];
    // Each stops as a person's stop does; its end answers its consult with the reason (`answerConsult`).
    for (const { id } of going) out.push({ type: "end", steps: await this.stopIn(tx, id, out, "consult-revoked") });
    for (const { q, problem } of ended) {
      if (q.status === "pending") await this.settleConsult(tx, q.id, failed(problem), null, out, "stopped");
      else {
        const [replaced] = await tx
          .update(questions)
          .set({ answer: failed(problem) })
          .where(and(eq(questions.id, q.id), isNull(questions.deliveredAt)))
          .returning();
        if (replaced) out.push({ type: "question", question: questionView(replaced) });
      }
    }
    if (ended.length) spanEvent("engine.consults.ended", { "dispand.consults.count": ended.length });
    return out;
  }

  /**
   * Deletes these agents of the owner in `tx`, and keeps their Jobs. Their triggers, then the
   * agents, are locked (the order the scheduler and a Job's creation take them in), so a Job being
   * created is seen here or then finds no agent. Each of their Jobs still going stops as a person's
   * stop does; every Job of theirs keeps the agent's name as it is now (`runs.agent_name`) as its
   * link is cleared, and never runs again. Their triggers and entries (skills, tools, consults)
   * go with them, and each consult in flight that loses its entry ends with the reason
   * (`endConsults`). What it returns goes once `tx` commits (`settled`).
   */
  async deleteAgents(tx: Tx, ownerId: string, agentIds: string[]): Promise<Out[]> {
    if (agentIds.length === 0) return [];
    // First, as for any change of an agent's consults: a consult opened meanwhile is either seen by `endConsults` or sees this change.
    await lockConsults(tx, ownerId);
    await tx.select({ id: triggers.id }).from(triggers).where(inArray(triggers.agentId, agentIds)).for("update");
    const deleted = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), inArray(agents.id, agentIds)))
      .for("update");
    const ids = deleted.map((a) => a.id);
    if (ids.length === 0) return [];
    const out: Out[] = [];
    const going = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(inArray(runs.agentId, ids), inArray(runs.status, ACTIVE_RUN)))
      .for("update");
    for (const { id } of going) out.push({ type: "end", steps: await this.stopIn(tx, id, out) });
    for (const a of deleted) await tx.update(runs).set({ agentName: a.name }).where(eq(runs.agentId, a.id));
    // Their Jobs stay, their link cleared (`runs.agent_id` sets null).
    await tx.delete(agents).where(inArray(agents.id, ids));
    out.push(...(await this.endConsults(tx, ownerId, ids)));
    spanEvent("engine.agents.deleted", { "dispand.agents.count": ids.length, "dispand.jobs.count": going.length });
    return out;
  }

  /** Sends on what a transaction that ended consults left to do (`endConsults`), once it committed. */
  settled(out: Out[]): void {
    this.publish(out);
  }

  /**
   * A person answered a root's checkpoint, in `tx` with the root locked: approved, it goes on to
   * the next checkpoint; "don't ask again" (`allow-always`), it goes on with no more checkpoints;
   * declined, it stops for good: its held events are processed with no Job, its deferred fires
   * close as `stopped`, and its unfinished Jobs stop as a person's stop does, all in `tx`, so
   * nothing of it is left going if the process stops right after (their sessions are told to end
   * once it commits, or by the next reconcile). A stopped root makes no Job (`createJob`), and none of its sessions works
   * again (`rootGoing`), so nothing of it is replayed after a reconnect or a restart.
   */
  private async settleRoot(
    tx: Tx,
    q: QuestionRow,
    answer: Answer,
    actor: AuditActor,
  ): Promise<{ stopped?: { outs: Map<string, Out[]>; sessions: StepRow[] }; goOn?: string }> {
    const rootId = q.rootId!;
    const decision = answer.kind === "permission" ? answer.decision : "deny";
    const answered = decision === "allow-always" ? "dont-ask" : decision === "allow" ? "approve" : "decline";
    counts.counter("dispand.checkpoints.answered").add(1, { "dispand.checkpoint.answer": answered });
    // `NO KEY UPDATE`: a Job ending meanwhile (its run locked) still writes events referencing the root, so the decline's wait on its runs can't deadlock with it.
    const [root] = await tx.select().from(roots).where(eq(roots.id, rootId)).for("no key update");
    if (!root || root.state !== "paused") return {};
    // The root's row, besides its Approval's `question.answered`: on a decline, with what it stopped.
    const audited = (details: { events?: number; jobs?: number } = {}) =>
      recordAudit(tx, {
        ownerId: root.ownerId,
        actor,
        jobId: q.runId,
        action: "checkpoint.answered",
        resource: { type: "root", id: rootId },
        details: { questionId: q.id, decision: answered, ...details },
      });
    if (decision !== "deny") {
      await audited();
      await tx
        .update(roots)
        .set({ state: "going", countedFrom: root.jobs, ...(decision === "allow-always" ? { dontAsk: true } : {}) })
        .where(eq(roots.id, rootId));
      await pausedGauge(tx);
      return { goOn: rootId };
    }
    await tx.update(roots).set({ state: "stopped" }).where(eq(roots.id, rootId));
    await pausedGauge(tx);
    const now = new Date();
    const held = tx.select({ id: events.id }).from(events).where(eq(events.rootId, rootId));
    await tx
      .update(eventFires)
      .set({ status: "stopped", message: ROOT_STOPPED })
      .where(and(eq(eventFires.status, "deferred"), inArray(eventFires.eventId, held)));
    const dropped = await tx
      .update(events)
      .set({ processedAt: now })
      .where(and(eq(events.rootId, rootId), isNull(events.processedAt)))
      .returning({ id: events.id });
    const going = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.rootId, rootId), inArray(runs.status, ACTIVE_RUN)))
      .for("update");
    await audited({ events: dropped.length, jobs: going.length });
    const outs = new Map<string, Out[]>();
    const sessions: StepRow[] = [];
    for (const { id } of going) {
      const out: Out[] = [];
      sessions.push(...(await this.stopIn(tx, id, out, "stopped-checkpoint")));
      outs.set(id, out);
    }
    return { stopped: { outs, sessions } };
  }

  /**
   * A root went on after its checkpoint: what its Jobs held while it was paused goes now, in the
   * order the slots allow. Each held step takes a slot (or queues) for what it waits to do (its
   * start, its answers and messages, its resume); steps not started yet start as their runs advance.
   */
  private async goOn(rootId: string) {
    const going = await this.db.select({ id: runs.id }).from(runs).where(and(eq(runs.rootId, rootId), inArray(runs.status, ACTIVE_RUN)));
    await this.openWaitingConsults(going.map((r) => r.id));
    for (const { id } of going) {
      const steps = await this.db
        .select()
        .from(stepRuns)
        .where(and(eq(stepRuns.runId, id), inArray(stepRuns.status, ACTIVE_STEP), isNotNull(stepRuns.sessionId)));
      for (const step of steps) await this.wake(step);
      await this.advance(id);
    }
  }

  /**
   * The consults of these runs asked while their root was paused, which have no Job yet: each is
   * opened now (`openConsult`), unless its root is paused again. Also on boot, for a root that
   * went on before the process could open them.
   */
  private async openWaitingConsults(runIds: string[]) {
    if (runIds.length === 0) return;
    const waiting = await this.db
      .select({ id: questions.id, ownerId: questions.ownerId })
      .from(questions)
      .where(and(inArray(questions.runId, runIds), eq(questions.kind, "consult"), eq(questions.status, "pending"), isNull(questions.consultRunId)));
    for (const { id, ownerId } of waiting) {
      const out: Out[] = [];
      await this.db.transaction(async (tx) => {
        await lockConsults(tx, ownerId);
        const [q] = await tx.select().from(questions).where(and(eq(questions.id, id), eq(questions.status, "pending"), isNull(questions.consultRunId))).for("update");
        if (q) await this.openConsult(tx, q, out);
      });
      this.publish(out);
    }
    await this.announceCheckpoints();
  }

  /** A held step takes a slot for what it waits to do, and does it once it holds one (`handOver`). */
  private async wake(step: StepRow) {
    if (step.resumeAfterSession) return this.resume(step);
    const undelivered = async () => (await this.undeliveredAnswers(step.sessionId!)).length > 0 || (await undeliveredMessages(this.db, step.id)).length > 0;
    const action: PendingAction | null = !step.startDeliveredAt
      ? { kind: "start" }
      : (step.pendingAction ?? (step.status === "running" && (await undelivered()) ? { kind: "deliver" } : null));
    // An answer waits until no question of the step is pending; a resume carries what the session missed.
    if (!action || (action.kind === "deliver" && step.status !== "running")) return;
    const out: Out[] = [];
    const got = await this.db.transaction(async (tx) => {
      const got = action.kind === "deliver" ? await this.takeChatSlot(tx, step, out)
        : step.harnessId ? await take(tx, { id: step.id, harnessId: step.harnessId }, "resume", action) : "working";
      if (got === "working") await tx.update(stepRuns).set({ pendingAction: action }).where(and(eq(stepRuns.id, step.id), inArray(stepRuns.status, ACTIVE_STEP)));
      else if (action.kind !== "deliver") await pushStep(tx, step.id, out);
      return got;
    });
    this.publish(out);
    if (got === "working") await this.handOver(step.id);
  }

  /**
   * The root's paused: what the step would do now waits, holding no slot (given back, or out of
   * the queue), in `pending_action`, done once the root goes on (`goOn`). A resume already
   * waiting stays: it carries the rest.
   */
  private async hold(tx: Tx, stepId: string, action: PendingAction, out: Out[]) {
    const [step] = await tx.select().from(stepRuns).where(eq(stepRuns.id, stepId)).for("update");
    if (!step || !OPEN_STEP.includes(step.status)) return;
    // A chat message arriving during a turn: the turn goes on with its slot, given back at its end
    // (`turn-end`). A slot just handed for what the step waited to do (`pending_action` set) is no turn.
    const turning = action.kind === "deliver" && step.working && step.status === "running" && !!step.startDeliveredAt && !step.pendingAction;
    if (!turning) await release(tx, step, out);
    await tx
      .update(stepRuns)
      .set({ pendingAction: step.pendingAction?.kind === "resume" ? step.pendingAction : action })
      .where(eq(stepRuns.id, stepId));
    spanEvent("engine.slot", { "dispand.slot.action": "hold", "dispand.step.id": stepId });
  }

  /** One event of a session, from the runner `from.runnerId` (events for another runner's session are ignored). */
  async onHarnessEvent(sessionId: string, event: HarnessEvent, from: { runnerId: string; seq: number }): Promise<void> {
    // The runner lost the session: answers and chat messages wait until the resume has carried
    // what it missed, as during a reconcile, or they would go to the lost session (which the runner
    // reports only once) and be marked delivered.
    if (event.type === "error" && event.message === SESSION_NOT_RUNNING) await this.holdingDeliveries(() => this.handleEvent(sessionId, event, from));
    else await this.handleEvent(sessionId, event, from);
    // The chat may be idle now (a replay too, if the process stopped before): its next queued message goes.
    if (SETTLING.has(event.type)) {
      const [step] = await this.db.select({ id: stepRuns.id }).from(stepRuns).where(and(eq(stepRuns.sessionId, sessionId), sessionSource(this.db, from.runnerId)));
      if (step) await this.drainQueue(step.id);
    }
  }

  /** Only the in-process cloud runner can supply authorized record snapshots. */
  async onCloudEvent(sessionId: string, event: CloudEvent, seq: number): Promise<void> {
    const from = { runnerId: CLOUD_SOURCE, seq };
    if (event.type === "record-start" || event.type === "record-result") return this.handleEvent(sessionId, event, from);
    return this.onHarnessEvent(sessionId, event, from);
  }

  private async handleEvent(sessionId: string, event: CloudEvent, from: { runnerId: string; seq: number }): Promise<void> {
    counts.counter("dispand.harness.events").add(1, { "dispand.event.type": event.type });
    // Words stream as many small events: those are counted, the others traced one by one.
    if (event.type === "text") return this.applyEvent(sessionId, event, from);
    // In its Job's trace: the runner message's own span is linked from it.
    const [job] = await this.db.select({ traceId: runs.traceId, spanId: runs.spanId }).from(stepRuns).innerJoin(runs, eq(runs.id, stepRuns.runId)).where(eq(stepRuns.sessionId, sessionId));
    return inJobTrace(job ?? {}, () => traces.startActiveSpan("engine.event", { attributes: { "dispand.event.type": event.type, "dispand.session.id": sessionId, "dispand.runner.id": from.runnerId } }, async (span) => {
      try {
        await this.applyEvent(sessionId, event, from);
      } catch (err) {
        recordError(span, errorKind(err));
        throw err;
      } finally {
        span.end();
      }
    }));
  }

  private async applyEvent(sessionId: string, event: CloudEvent, from: { runnerId: string; seq: number }): Promise<void> {
    if (event.type === "session-ended") await this.retired(sessionId, from.runnerId);
    const out: Out[] = [];
    const result = await this.db.transaction(async (tx) => {
      // A consult makes a Job in the asking Job's root: that root is locked first, as a
      // checkpoint's answer locks it before the runs and steps it stops.
      if (event.type === "question" && event.payload.kind === "consult") {
        const [asking] = await tx.select({ ownerId: stepRuns.ownerId }).from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
        if (asking) await lockConsults(tx, asking.ownerId);
        await tx
          .select({ id: roots.id })
          .from(stepRuns)
          .innerJoin(runs, eq(runs.id, stepRuns.runId))
          .innerJoin(roots, eq(roots.id, runs.rootId))
          .where(and(eq(stepRuns.sessionId, sessionId), sessionSource(tx, from.runnerId)))
          .for("update", { of: roots });
      }
      const [step] = await tx
        .update(stepRuns)
        .set({ eventSeq: from.seq, ...(event.type === "error" || event.type === "session-ended" ? {} : { lastActivityAt: new Date() }) })
        .where(and(eq(stepRuns.sessionId, sessionId), sessionSource(tx, from.runnerId), lt(stepRuns.eventSeq, from.seq)))
        .returning();
      if (!step) return null;
      annotate({ "dispand.job.id": step.runId, "dispand.step.id": step.id });
      return { step, next: await this.apply(tx, step, event, out, from.runnerId === CLOUD_SOURCE) };
    });
    if (!result) {
      // A replay of an event already applied: what it started may not have finished (advance
      // failed after the commit, and the hub didn't ack), so advancing again is the retry.
      await this.retryAdvance(sessionId, from.runnerId);
      return;
    }
    this.publish(out);
    if (result.next === "advance") await this.advance(result.step.runId);
    if (result.next === "wake") {
      const [step] = await this.db.select().from(stepRuns).where(eq(stepRuns.id, result.step.id));
      if (step) await this.wake(step);
    }
    // Only database work is awaited: the start itself goes out without waiting.
    if (result.next === "resume" && !this.inFlight.has(`start:${sessionId}`)) await this.resume(result.step);
  }

  private async retryAdvance(sessionId: string, runnerId: string) {
    const [row] = await this.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.sessionId, sessionId), sessionSource(this.db, runnerId)));
    if (row?.status === "succeeded") await this.advance(row.runId);
    else if (row?.harness?.kind === "codex" && row.turnStatus === "idle" && !row.codexInputId) await this.wake(row);
  }

  /** A runner was revoked: its open sessions never come back, so their steps (and runs) fail. */
  async runnerRevoked(runnerId: string): Promise<void> {
    const open = await this.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runnerId, runnerId), inArray(stepRuns.status, ACTIVE_STEP)));
    for (const step of open) {
      await this.failNow(step, RUNNER_REVOKED);
    }
  }

  /**
   * On boot: active runs continue (steps whose predecessors are done start). A Tool step left
   * running was calling its tool when Dispand stopped: it fails, and is never called again.
   * Sessions are reconciled per runner.
   */
  async recover(): Promise<void> {
    // Queued messages whose chat went idle before the process could send them: sent last, below.
    const queued = await this.db.selectDistinct({ stepRunId: chatQueue.stepRunId }).from(chatQueue).where(eq(chatQueue.state, "pending"));
    // Free slots go to the queued steps first, in the queue's order. The steps handed one, now or
    // just before the process stopped (`pending_action`), start as their runs advance below.
    const queuedOn = await this.db.selectDistinct({ harnessId: stepRuns.harnessId }).from(stepRuns).where(isNotNull(stepRuns.queuedAt));
    for (const { harnessId } of queuedOn) if (harnessId) await this.db.transaction((tx) => next(tx, harnessId));
    const active = await this.db.select({ id: runs.id }).from(runs).where(inArray(runs.status, ACTIVE_RUN));
    for (const { id } of active) {
      await this.failInterruptedTools(id);
      await this.advance(id);
    }
    // Steps handed a slot to deliver answers and messages, or to resume, before the process stopped.
    const handed = await this.db
      .select({ id: stepRuns.id })
      .from(stepRuns)
      .where(and(eq(stepRuns.working, true), sql`${stepRuns.pendingAction}->>'kind' in ('deliver', 'resume')`));
    for (const { id } of handed) await this.handOver(id);
    // Steps held while their root was paused, whose root went on before the process could hand
    // them back (`goOn`): they take a slot now. Those of a root still paused stay held.
    const held = await this.db
      .select({ step: stepRuns })
      .from(stepRuns)
      .innerJoin(runs, eq(runs.id, stepRuns.runId))
      .innerJoin(roots, eq(roots.id, runs.rootId))
      .where(
        and(
          eq(roots.state, "going"),
          inArray(stepRuns.status, ACTIVE_STEP),
          isNotNull(stepRuns.sessionId),
          isNotNull(stepRuns.pendingAction),
          eq(stepRuns.working, false),
          isNull(stepRuns.queuedAt),
        ),
      );
    for (const { step } of held) await this.wake(step);
    // Consults whose consulted run ended before the process could answer them, and consults of a
    // root that went on before the process could open them.
    const unanswered = await this.db
      .select({ run: runs })
      .from(questions)
      .innerJoin(runs, eq(runs.id, questions.consultRunId))
      .where(and(eq(questions.kind, "consult"), eq(questions.status, "pending"), inArray(runs.status, ["succeeded", "failed"])));
    for (const { run } of unanswered) {
      const out: Out[] = [];
      await this.db.transaction((tx) => this.answerConsult(tx, run, out));
      this.publish(out);
    }
    await this.openWaitingConsults(active.map((r) => r.id));
    // A cloud session of a paused root isn't run again here: reconciled as lost, it is held to resume.
    if (this.cloud) await this.reconcile(CLOUD_SOURCE, await this.cloud.recover((runId) => rootGoing(this.db, runId)));
    for (const { stepRunId } of queued) await this.drainQueue(stepRunId);
  }

  /**
   * Sets a harness's limit and, in the same transaction, gives its queued steps the slots that
   * frees, in the queue's order (no start in between takes one first); they start once it commits.
   */
  async setLimit(harnessId: string, maxWorking: number): Promise<void> {
    const handed = await this.db.transaction(async (tx) => {
      await tx.update(harnesses).set({ maxWorking }).where(eq(harnesses.id, harnessId));
      return next(tx, harnessId);
    });
    if (handed.length === 0) return;
    const rows = await this.db.select({ id: stepRuns.id, runId: stepRuns.runId }).from(stepRuns).where(inArray(stepRuns.id, handed));
    for (const r of rows) this.publish([{ type: "slot", runId: r.runId, stepId: r.id }]);
  }

  /**
   * On shutdown, once nothing starts new work (the hub and the scheduler are stopped): waits for
   * the starts and deliveries under way, so the database can close after them.
   */
  async stop(): Promise<void> {
    this.stopping.abort();
    // Work that settles can start more: a redelivery reads its row, then starts the delivery.
    while (this.background.size) await Promise.allSettled(this.background);
  }

  /**
   * A runner is back and its earlier events are handled (the hub calls this on every `hello`,
   * once caught up), so a session that ended meanwhile is already closed here. For each session
   * still open on this runner: live → what didn't reach it goes now; lost after its start was
   * written → it resumes from its CLI session, told what it missed; start never written → sent
   * once. Throws on failure: the hub then drops the connection and the next `hello` retries.
   */
  async reconcile(runnerId: string, liveSessions: string[]): Promise<void> {
    await this.holdingDeliveries(async () => {
      const steps = await this.db
        .select({ step: stepRuns, placed: runnerId === CLOUD_SOURCE ? sql<boolean>`true` : runnerForRun(this.db, runnerId) })
        .from(stepRuns)
        .innerJoin(runs, eq(runs.id, stepRuns.runId))
        .where(and(eq(stepRuns.runnerId, runnerId), inArray(runs.status, ACTIVE_RUN), inArray(stepRuns.status, ACTIVE_STEP)));
      for (const { step: row, placed } of steps) {
        if (!placed) {
          await this.failNow(row, RUNNER_REVOKED);
          continue;
        }
        let step = row;
        const sessionId = step.sessionId!;
        if (this.inFlight.has(`start:${sessionId}`)) continue;
        if (step.resumeAfterSession) {
          if (liveSessions.includes(sessionId)) {
            await this.db.update(stepRuns).set({ resumeAfterSession: null, pendingAction: null, startDeliveredAt: new Date() }).where(eq(stepRuns.id, step.id));
            await this.adapter.narrowPermissions?.(sessionId);
            if (holdsSlot(step)) await this.flush(step);
          } else if (!liveSessions.includes(step.resumeAfterSession.sessionId)) {
            if (step.resumeAfterSession.ended) await this.resume(step);
            else await this.retired(step.resumeAfterSession.sessionId, runnerId);
          } else this.stopSession(step.resumeAfterSession.sessionId, runnerId);
          continue;
        }
        if (liveSessions.includes(sessionId)) await this.adapter.narrowPermissions?.(sessionId);
        // Its events came (its CLI session id among them): the start reached the runner, though the
        // server stopped before recording its write. Resending it would hit the folder it made.
        if (!step.startDeliveredAt && (step.cliSessionId || step.lastActivityAt)) {
          const startDeliveredAt = step.startedAt ?? new Date(0);
          await this.db.update(stepRuns).set({ startDeliveredAt }).where(eq(stepRuns.id, step.id));
          step = { ...step, startDeliveredAt };
        }
        // Its root paused at a checkpoint: nothing goes to it (a turn under way finishes); what it
        // would do now waits for the root to go on (`goOn`), a lost session's resume included.
        if (!(await rootGoing(this.db, step.runId))) {
          const lost = !!step.startDeliveredAt && !liveSessions.includes(sessionId);
          if (lost) await this.unconfirmNow(step);
          if (!step.startDeliveredAt || lost) {
            await this.holdNow(step.id, { kind: lost ? "resume" : "start" });
          }
          continue;
        }
        if (!step.startDeliveredAt) {
          // Queued again after its root was paused: it goes when handed a slot (`handOver`).
          if (!holdsSlot(step)) continue;
          if (await this.refusedForScope(step)) continue;
          await this.launch(step.harness!, step.start!, step);
          // Chat messages sent before the start ever reached the runner go right after it.
          for (const m of await undeliveredMessages(this.db, step.id)) this.deliverMessage(step, m);
        } else if (!liveSessions.includes(sessionId)) {
          await this.unconfirmNow(step);
          await this.resume(step);
        }
        // Live: what it missed goes now, if it holds a slot; otherwise once it is handed one.
        else if (holdsSlot(step)) await this.flush(step);
        else if (step.harness?.kind === "codex" && step.turnStatus === "idle") await this.wake(step);
      }
      // Sessions it still runs that no step still going is waiting on are ended: a stop that
      // never reached it, or a run deleted since (with its workflow or its agent). Decided from
      // the steps as they are now, not from the rows of the finished ones, which may be gone.
      const going = new Set(steps.filter(({ placed }) => placed).map(({ step }) => step.sessionId));
      for (const sessionId of liveSessions) {
        if (!going.has(sessionId) && !this.inFlight.has(`start:${sessionId}`)) this.stopSession(sessionId, runnerId);
      }
    });
  }

  /** Runs `work` with answers and chat messages held; those asked for meanwhile go after it, against the rows it left. */
  private async holdingDeliveries<T>(work: () => Promise<T>): Promise<T> {
    this.reconciling++;
    try {
      return await work();
    } finally {
      if (--this.reconciling === 0) for (const retry of this.deferred.splice(0)) retry();
    }
  }

  /**
   * The runner lost the session after its start was written: it starts again from its CLI
   * session, told what it missed. Its pending questions are orphaned first (their answer now
   * goes as a message), then the answers and messages it missed are read: an answer racing this
   * lands in one or the other.
   */
  private async resume(step: StepRow) {
    const sessionId = step.sessionId!;
    if (step.resumeAfterSession && !step.resumeAfterSession.ended) {
      this.stopSession(step.resumeAfterSession.sessionId, step.runnerId!);
      return;
    }
    if (this.inFlight.has(`start:${sessionId}`)) return;
    const out: Out[] = [];
    // Its root paused at a checkpoint: it resumes once the root goes on (`goOn`).
    if (!(await rootGoing(this.db, step.runId))) {
      await this.db.transaction((tx) => this.hold(tx, step.id, { kind: "resume" }, out));
      return this.publish(out);
    }
    // A resume is a turn: it takes a slot first, or queues and resumes once handed one.
    if (step.harnessId) {
      const harnessId = step.harnessId;
      const got = await this.db.transaction(async (tx) => {
        const got = await take(tx, { id: step.id, harnessId }, "resume", { kind: "resume" });
        if (got === "queued") await pushStep(tx, step.id, out);
        return got;
      });
      if (got === "queued") return this.publish(out);
    }
    const waiting = await this.db
      .update(questions)
      .set({ orphaned: true })
      .where(and(eq(questions.sessionId, sessionId), eq(questions.status, "pending")))
      .returning();
    for (const q of waiting) out.push({ type: "question", question: questionView(q) });
    this.publish(out);
    // Deliveries still under way are carried too (they never mark a lost session's rows delivered).
    const answered = await this.undeliveredAnswers(sessionId);
    const unsent = await undeliveredMessages(this.db, step.id);
    const { prompt, answers, messages: carried, laterAnswers, laterMessages } = resumePrompt(
      step.cliSessionId ? null : step.start!.prompt,
      answered,
      step.harness?.kind === "codex" ? unsent.slice(0, 1) : unsent,
      waiting,
    );
    if (step.harness?.kind === "codex") {
      laterMessages.push(...unsent.slice(1));
      await this.db.update(stepRuns).set({ codexInputId: carried[0]?.id ?? null }).where(eq(stepRuns.id, step.id));
    }
    let start: StartParams;
    if (step.cliSessionId) start = { ...step.start!, prompt, resumeCliSessionId: step.cliSessionId };
    else {
      // Nothing to resume (the CLI never reported its session): start afresh, in a new folder,
      // since the runner may have created the first one before it stopped.
      const runKey = `${step.runId}-${step.id}-${Date.now().toString(36)}`;
      await this.db.update(stepRuns).set({ start: { ...step.start!, runKey } }).where(eq(stepRuns.id, step.id));
      start = { ...step.start!, runKey, prompt };
    }
    // What the prompt carries is held, so no separate delivery sends it too.
    const held = [...answers.map((q) => `q:${q.id}`), ...carried.map((m) => `m:${m.id}`)];
    // Its run may have been stopped since the step was read: a stopped run never starts again.
    // Read right before the launch, so a stop is either seen here or sent after this start.
    const [now] = await this.db.select({ status: stepRuns.status }).from(stepRuns).where(eq(stepRuns.id, step.id));
    if (!now || !ACTIVE_STEP.includes(now.status)) return;
    if (await this.refusedForScope(step)) return;
    await this.auditResume(step);
    await this.launch(step.harness!, start, step, held, async () => {
      const now = new Date();
      if (answers.length) await this.db.update(questions).set({ deliveredAt: now }).where(inArray(questions.id, answers.map((q) => q.id)));
      if (carried.length) await this.db.update(messages).set({ deliveredAt: now }).where(inArray(messages.id, carried.map((m) => m.id)));
      if (step.resumeAfterSession) {
        await this.db.update(stepRuns).set({ resumeAfterSession: null, pendingAction: null }).where(and(eq(stepRuns.id, step.id), eq(stepRuns.sessionId, sessionId)));
        await this.flush(step);
      }
    });
    // What didn't fit follows as messages, after the start on the same connection. The resumed
    // session doesn't know the old question ids: those answers go as words too (orphaned).
    if (laterAnswers.length) {
      const orphaned = await this.db
        .update(questions)
        .set({ orphaned: true })
        .where(inArray(questions.id, laterAnswers.map((q) => q.id)))
        .returning();
      for (const q of orphaned) this.deliverAnswer(q);
    }
    // A reopened session is new: its written callback flushes overflow after the start.
    if (!step.resumeAfterSession) for (const m of laterMessages) this.deliverMessage(step, m);
  }

  /** A Job's session resumed: its `job.started` row, `resumed`, with the harness and runner it runs on. */
  private async auditResume(step: StepRow) {
    const [run] = await this.db.select({ ownerId: runs.ownerId, source: runs.source, agentId: runs.agentId }).from(runs).where(eq(runs.id, step.runId));
    if (run?.source !== "agent") return;
    const harnessId = step.harness?.id ?? step.harnessId;
    const [h] = harnessId ? await this.db.select({ name: harnesses.name }).from(harnesses).where(eq(harnesses.id, harnessId)) : [];
    const runnerId = step.harness && !isCloud(step.harness) ? step.harness.runnerId : null;
    const [runner] = runnerId ? await this.db.select({ name: runners.name }).from(runners).where(eq(runners.id, runnerId)) : [];
    await recordAuditAfter(this.db, {
      ownerId: run.ownerId,
      actor: { type: "job", runId: step.runId },
      agentId: run.agentId,
      jobId: step.runId,
      action: "job.started",
      resource: { type: "job", id: step.runId },
      details: {
        status: "resumed",
        ...(harnessId ? { harnessId } : {}),
        ...(h ? { harnessName: h.name } : {}),
        ...(runnerId ? { runnerId } : {}),
        ...(runner ? { runnerName: runner.name } : {}),
      },
    });
  }

  /**
   * The session is gone. A write to the socket isn't a delivery to the session, and no event
   * proves which writes it read (one received after a write may have been sent before it): every
   * answer and chat message written since its start (or last resume) was written is marked
   * undelivered (answers orphaned, so they go as words), and the resume carries them again, even
   * those it saw: a duplicate beats a loss. Every path that resumes a lost session goes through
   * here first.
   */
  private async unconfirmNow(step: StepRow) {
    const out: Out[] = [];
    await this.db.transaction((tx) => this.unconfirm(tx, step, out));
    this.publish(out);
  }

  /**
   * Steers whose session is gone, so no `steer-result` will settle them: ordinary messages now, in
   * flight until a turn ends after them. Codex may not have taken one: it is sent again.
   */
  private async dropSteers(tx: Tx, step: StepRow) {
    const dropped = await tx.update(chatQueue).set({ state: "dispatched", updatedAt: new Date() }).where(and(eq(chatQueue.stepRunId, step.id), eq(chatQueue.state, "steering"))).returning({ id: chatQueue.id });
    if (dropped.length && step.harness?.kind === "codex") await tx.update(messages).set({ deliveredAt: null }).where(inArray(messages.id, dropped.map((d) => d.id)));
  }

  private async unconfirm(tx: Tx, step: StepRow, out: Out[]) {
    await this.turn(tx, step, "unknown", out);
    await this.dropSteers(tx, step);
    // A write under way went to the lost session: it won't mark its row delivered.
    this.losses.set(step.sessionId!, (this.losses.get(step.sessionId!) ?? 0) + 1);
    // The new session of a reopened chat has not received any old transcript messages.
    if (step.resumeAfterSession && !step.startDeliveredAt) return;
    const since = step.startDeliveredAt ?? new Date(0);
    // Codex admits one input at a time: completed turns must not be replayed on reconnect.
    await tx
      .update(messages)
      .set({ deliveredAt: null })
      .where(and(eq(messages.stepRunId, step.id), eq(messages.role, "user"), gte(messages.deliveredAt, since),
        step.harness?.kind === "codex" ? eq(messages.id, step.codexInputId ?? "") : undefined));
    await tx
      .update(questions)
      .set({ deliveredAt: null, orphaned: true })
      .where(and(eq(questions.sessionId, step.sessionId!), eq(questions.status, "answered"), gte(questions.deliveredAt, since)));
  }

  private async undeliveredAnswers(sessionId: string) {
    const rows = await this.db
      .select()
      .from(questions)
      .where(and(eq(questions.sessionId, sessionId), eq(questions.status, "answered"), isNull(questions.deliveredAt)))
      .orderBy(asc(questions.answeredAt));
    return Promise.all(rows.map((q) => this.checkedAnswer(q)));
  }

  /**
   * A consult's answer, as its asker may get it now: when a right was taken back since it was
   * recorded, its recorded answer is replaced by the reason, for good, and never sent. Every
   * path that sends answers reads them through here (`undeliveredAnswers`, `redeliverAnswer`).
   */
  private async checkedAnswer(q: QuestionRow): Promise<QuestionRow> {
    if (q.remember && q.answer?.kind === "permission" && q.answer.decision === "allow") {
      const current = await toolAnswerPermission(this.db, q);
      if (current === "deny") return { ...q, answer: { kind: "permission", decision: "deny", message: "This tool permission changed before the answer was delivered." } };
      if (q.answer.remember && current === "once") { const { remember: _scope, ...answer } = q.answer; void _scope; return { ...q, answer }; }
    }
    if (q.about?.toolId && q.payload.kind === "permission" && q.answer?.kind === "permission" && q.answer.decision === "allow-always" && !(await runnerGrantCurrent(this.db, q.runId, q.payload.toolName, q.about))) return { ...q, answer: { ...q.answer, decision: "allow" } };
    if (q.kind !== "consult" || q.answer?.kind !== "consult") return q;
    // A failure too: its reason may quote the consulted Job's error.
    const problem = await deliveryProblem(this.db, q);
    if (!problem || (q.answer.outcome === "failed" && q.answer.text === failed(problem).text)) return q;
    const [replaced] = await this.db
      .update(questions)
      .set({ answer: failed(problem) })
      .where(and(eq(questions.id, q.id), isNull(questions.deliveredAt)))
      .returning();
    return replaced ?? q;
  }

  /** Execution reports own activity; receiving work or holding a slot does not prove a turn started. */
  private async turn(tx: Tx, step: StepRow, status: TurnStatus, out: Out[], activity?: { turnId: string; interruptible: boolean }) {
    if (!step.start?.interactive || !step.sessionId) return;
    const turnId = activity?.turnId ?? (status === "unknown" ? null : step.turnId);
    const interruptible = activity?.interruptible ?? false;
    const [changed] = await tx.update(stepRuns).set({ turnStatus: status, turnId, interruptible, ...(status === "unknown" || (activity && activity.turnId !== step.turnId) ? { interruptAfterPosition: null } : {}) })
      .where(and(eq(stepRuns.id, step.id), eq(stepRuns.sessionId, step.sessionId), inArray(stepRuns.status, OPEN_STEP), or(sql`${stepRuns.turnStatus} <> ${status}`, sql`${stepRuns.turnId} IS DISTINCT FROM ${turnId}`, sql`${stepRuns.interruptible} <> ${interruptible}`))).returning();
    if (!changed) return;
    out.push({ type: "step", step: stepView(changed) });
    spanEvent("engine.turn", { "dispand.step.id": step.id, "dispand.run.id": step.runId, "dispand.turn.status": status });
    const [run] = await tx.select({ source: runs.source, agentId: runs.agentId }).from(runs).where(eq(runs.id, step.runId));
    if (run?.source === "agent") await recordAudit(tx, {
      ownerId: step.ownerId,
      actor: { type: "job", runId: step.runId },
      agentId: run.agentId,
      jobId: step.runId,
      action: "job.turn",
      resource: { type: "job", id: step.runId },
      details: { status },
    });
  }

  /**
   * Applies one new event inside its transaction. "advance": a step completed (the run may go
   * on); "resume": the runner lost its session; "wake": a native chat turn released its slot.
   */
  /** `own`: the event is Dispand's own (the cloud runner's), so its error message may be a stored one; a runner's words are stored as they came. */
  private async apply(tx: Tx, step: StepRow, event: CloudEvent, out: Out[], own = false): Promise<"advance" | "resume" | "wake" | null> {
    // A closed step keeps its transcript and questions as they were.
    if (!OPEN_STEP.includes(step.status)) return null;
    switch (event.type) {
      case "record-start": {
        if (!own || (step.start?.interactive && step.turnId !== event.turnId)) return null;
        const { toolCallId, turnId, args } = event;
        const [row] = await tx.insert(messages).values({
          id: newId("msg"), ownerId: step.ownerId, runId: step.runId, stepRunId: step.id,
          role: "tool", text: "rows_get", toolCall: { toolCallId, turnId, args },
        }).returning();
        out.push({ type: "message", message: messageView(row!) });
        return null;
      }
      case "record-result": {
        if (!own || (step.start?.interactive && step.turnId !== event.turnId)) return null;
        const { toolCallId, turnId, args, record } = event;
        const [row] = await tx.update(messages).set({ result: { toolCallId, turnId, args, record } }).where(and(
          eq(messages.stepRunId, step.id), eq(messages.role, "tool"),
          sql`${messages.toolCall}->>'toolCallId' = ${toolCallId}`,
          sql`${messages.toolCall}->>'turnId' = ${turnId}`,
        )).returning();
        if (row) out.push({ type: "message", message: messageView(row) });
        return null;
      }
      case "session-ended":
        await this.turn(tx, step, "unknown", out);
        await this.dropSteers(tx, step);
        return null;
      case "turn-start":
        // Provider activity proves the admitted input arrived, even if its socket write is still settling.
        if (step.harness?.kind === "codex" && step.codexInputId) {
          await tx.update(messages).set({ deliveredAt: new Date() }).where(eq(messages.id, step.codexInputId));
          await tx.update(questions).set({ deliveredAt: new Date() }).where(eq(questions.id, step.codexInputId));
        }
        if (step.turnId && step.turnId !== event.turnId) {
          await this.expire(tx, eq(questions.stepRunId, step.id), out, "stopped");
          await this.syncWaiting(tx, step.id, step.runId, out);
        }
        await this.turn(tx, step, "running", out, event);
        return null;
      case "steer-result": {
        // It joined the turn: acknowledged (that turn's end may have come first). Went as the next
        // message instead: in flight until the end of the turn it starts (the harness reports no end
        // of the turn it missed while it waits), Codex's input of that turn like an admitted one.
        const steered = event.outcome === "steered";
        const [item] = await tx.update(chatQueue).set({ state: "dispatched", ...(steered ? { ackedAt: new Date() } : {}), updatedAt: new Date() })
          .where(and(eq(chatQueue.id, event.requestId), eq(chatQueue.stepRunId, step.id), steered ? or(eq(chatQueue.state, "steering"), and(eq(chatQueue.state, "dispatched"), isNull(chatQueue.ackedAt))) : eq(chatQueue.state, "steering")))
          .returning({ id: chatQueue.id });
        if (item && !steered && step.harness?.kind === "codex") await tx.update(stepRuns).set({ codexInputId: item.id }).where(eq(stepRuns.id, step.id));
        spanEvent("engine.queue", { "dispand.queue.action": event.outcome === "steered" ? "steered" : "steer-queued", "dispand.step.id": step.id });
        return null;
      }
      case "interrupt-result":
        if (event.outcome === "requested" && event.turnId === step.turnId) await this.withdrawTurn(tx, step, event.turnId, out);
        return null;
      case "cli-session":
        await tx.update(stepRuns).set({ cliSessionId: event.cliSessionId }).where(eq(stepRuns.id, step.id));
        return null;
      case "text": {
        const [last] = await tx
          .select({ id: messages.id, role: messages.role })
          .from(messages)
          .where(eq(messages.stepRunId, step.id))
          .orderBy(desc(messages.position))
          .limit(1);
        const [row] =
          last?.role === "assistant"
            ? await tx
                .update(messages)
                .set({ text: sql`${messages.text} || ${event.delta}` })
                .where(eq(messages.id, last.id))
                .returning()
            : await tx
                .insert(messages)
                .values({ id: newId("msg"), ownerId: step.ownerId, runId: step.runId, stepRunId: step.id, role: "assistant", text: event.delta })
                .returning();
        out.push({ type: "message", message: messageView(row!) });
        return null;
      }
      case "tool": {
        if (event.status !== "started") return null;
        const [row] = await tx
          .insert(messages)
          .values({ id: newId("msg"), ownerId: step.ownerId, runId: step.runId, stepRunId: step.id, role: "tool", text: event.name })
          .returning();
        out.push({ type: "message", message: messageView(row!) });
        return null;
      }
      case "question": {
        // A call of one of the Job's exposed tools is asked under a short name, a runner tool's
        // under its session server's: say which tool and action it is.
        const offer = await offerForQuestion(tx, { ownerId: step.ownerId, sessionId: step.sessionId!, questionId: event.questionId, payload: event.payload, harness: step.harness?.kind });
        const [row] = await tx
          .insert(questions)
          .values({
            id: newId("q"),
            ownerId: step.ownerId,
            runId: step.runId,
            stepRunId: step.id,
            sessionId: step.sessionId!,
            runnerQuestionId: event.questionId,
            placement: step.start?.interactive ? "chat" : "notifications",
            kind: event.payload.kind === "permission" ? "approval" : event.payload.kind === "consult" ? "consult" : "question",
            about: offer?.about ?? null,
            remember: offer?.remember ?? null,
            payload: event.payload.kind === "permission" && (offer || event.payload.toolName.startsWith("mcp__")) ? { ...event.payload, canAlwaysAllow: false } : event.payload,
            status: "pending",
          })
          .onConflictDoNothing()
          .returning();
        if (row) {
          counts.counter("dispand.questions.opened").add(1, { "dispand.question.kind": row.kind });
          // A consult asks nothing of a person: it is no interaction, and no Inbox item.
          if (row.kind !== "consult") await recordInteraction(tx, row, "created");
          // A request for approval that names a proposal of this run: the question is for that proposal.
          if (event.payload.kind === "permission" && event.payload.toolName === REQUEST_APPROVAL) {
            row.proposalId = await attachProposal(tx as unknown as Db, { runId: step.runId, ownerId: step.ownerId }, row.id, event.payload.input);
            if (row.proposalId) await tx.update(questions).set({ proposalId: row.proposalId }).where(eq(questions.id, row.id));
          }
          out.push({ type: "question", question: questionView(row) });
          // The resumed session asks for itself now: questions of the session it replaced expire.
          await this.expire(tx, and(eq(questions.stepRunId, step.id), eq(questions.orphaned, true))!, out);
          if (row.kind === "consult") {
            await recordAudit(tx, {
              ownerId: row.ownerId,
              actor: { type: "job", runId: row.runId },
              jobId: row.runId,
              action: "consult.asked",
              resource: { type: "consult", id: row.id },
              details: await consultedAgent(tx, row),
            });
            counts.counter("dispand.consults.asked").add(1);
            await this.openConsult(tx, row, out);
          }
        }
        await this.syncWaiting(tx, step.id, step.runId, out);
        return null;
      }
      case "turn-end": {
        if (event.turnId ? event.turnId !== step.turnId : step.turnId !== null) return null;
        await this.turn(tx, step, "idle", out);
        // The messages sent before it are acknowledged: the next queued one may go.
        await tx.update(chatQueue).set({ ackedAt: new Date() }).where(and(eq(chatQueue.stepRunId, step.id), eq(chatQueue.state, "dispatched"), isNull(chatQueue.ackedAt)));
        if (step.start?.interactive && step.harness?.kind === "codex") {
          if (step.turnId && step.interruptAfterPosition !== null) await this.withdrawTurn(tx, step, step.turnId, out);
          else await release(tx, step, out);
          await tx.update(stepRuns).set({ codexInputId: null, turnId: null }).where(eq(stepRuns.id, step.id));
          return "wake";
        }
        // The durable boundary also covers a crash after the harness stopped but before its acknowledgment.
        if (step.turnId && step.interruptAfterPosition !== null) {
          await this.withdrawTurn(tx, step, step.turnId, out);
          return null;
        }
        // A chat between turns waits for the owner's next message: it holds no slot meanwhile. A
        // message sent before this was applied (the last of the transcript) started its next turn
        // on the slot it holds: that turn's end gives it back.
        if (!step.start?.interactive || !step.working) return null;
        const [last] = await tx.select({ role: messages.role }).from(messages).where(eq(messages.stepRunId, step.id)).orderBy(desc(messages.position)).limit(1);
        // A message held by a paused root (`hold`) started no turn: the slot goes back too.
        if (last?.role !== "user" || !(await rootGoing(tx, step.runId))) await release(tx, step, out);
        return null;
      }
      case "outputs-accepted":
        // Outside a chat, without expected outputs, the `result` that follows completes the step with
        // the agent's last message: a runner's `submit_outputs` called with nothing to hand back changes nothing.
        if (!step.start?.interactive && !step.start?.expectedOutputs.length) return null;
        return (await this.complete(tx, step, event.values, out)) ? "advance" : null;
      case "result":
        // With expected outputs, only `outputs-accepted` completes a step.
        if (step.start?.expectedOutputs.length) {
          await this.fail(tx, step, stored("engine.fail.noOutputs"), out);
          return null;
        }
        return (await this.complete(tx, step, { result: event.text }, out)) ? "advance" : null;
      case "error":
        // A start resent to a session the runner still has: it is live, nothing failed.
        if (event.message === SESSION_ALREADY_RUNNING) {
          await tx.update(stepRuns).set({ startDeliveredAt: new Date() }).where(eq(stepRuns.id, step.id));
          return null;
        }
        if (event.message === SESSION_NOT_RUNNING) {
          await this.unconfirm(tx, step, out);
          return "resume";
        }
        await this.fail(tx, step, own ? event.message : plainText(event.message), out);
        return null;
    }
  }

  /** Applies `nextActions` (starts, completes, skips, fails, loop iterations, finish) until nothing changes. */
  private async advance(runId: string): Promise<void> {
    for (;;) {
      const [run] = await this.db.select().from(runs).where(eq(runs.id, runId));
      if (!run || !ACTIVE_RUN.includes(run.status)) return;
      const def = await defOf(run, this.db);
      const steps = await this.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
      const nodes = new Map(nodesOf(def).map((n) => [n.id, n]));
      let changed = false;
      const scheduledFor = run.trigger.type === "schedule" ? new Date(run.trigger.scheduledFor) : run.createdAt;
      const outputs = run.trigger.type === "event" || run.trigger.type === "poll" || run.trigger.type === "consult" || run.trigger.type === "stem" ? run.trigger.outputs : undefined;
      for (const action of nextActions(def, steps, { scheduledFor, ...(outputs ? { outputs } : {}) })) {
        const out: Out[] = [];
        if (action.type === "finish") {
          await this.db.transaction((tx) => this.finishRun(tx, runId, action.status, null, out));
          this.publish(out);
          return;
        }
        if (action.type === "open-iteration") {
          changed = (await openIteration(this.db, run, def, action.loopId, action.iteration, out)) || changed;
          this.publish(out);
          continue;
        }
        const step = steps.find((s) => s.nodeId === action.nodeId && s.iteration === action.iteration)!;
        if (action.type === "complete") changed = (await this.db.transaction((tx) => this.complete(tx, step, action.outputs, out))) || changed;
        else if (action.type === "skip") changed = (await skip(this.db, step, out)) || changed;
        else if (action.type === "data") {
          const ran = await this.runData(run, def, steps, step, out);
          this.publish(out);
          if (ran === "failed") return;
          changed = ran === "succeeded" || changed;
          continue;
        }
        else if (action.type === "tool") await this.startTool(run, def, steps, step, out);
        else if (action.type === "fail") {
          // The run fails with the step: nothing else of it starts.
          await this.db.transaction((tx) => this.fail(tx, step, action.error, out));
          this.publish(out);
          return;
        } else if (nodes.get(action.nodeId)!.type === "loop") changed = (await startLoop(this.db, step, out)) || changed;
        else await this.startSession(run, def, steps, nodes.get(action.nodeId)!, step);
        this.publish(out);
      }
      if (!changed) return;
    }
  }

  /**
   * Runs a ready data step in one transaction: claimed (pending → running, so a retried or
   * concurrent advance finds nothing to do), run, then completed or failed with the run. The rows
   * it wrote are published once that commits. Nothing to claim: null.
   */
  private async runData(run: RunRow, def: WorkflowDef, steps: StepRow[], step: StepRow, out: Out[]): Promise<"succeeded" | "failed" | null> {
    const node = def.steps.find((s) => s.id === step.nodeId);
    if (node?.type !== "data") return null;
    // Each succeeded node's outputs it sees, by node id: what the step's sources read.
    const values = outputsFor(def, steps, step.nodeId, step.iteration);
    const result = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(stepRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
        .returning();
      if (!claimed) return null;
      const ran = await runDataStep(tx, { ownerId: run.ownerId, step: node, values, actor: { type: "step", runId: run.id, stepId: step.id } });
      if ("error" in ran) await this.fail(tx, claimed, ran.error, out);
      else await this.complete(tx, claimed, ran.outputs, out);
      return ran;
    });
    if (!result) return null;
    if ("error" in result) return "failed";
    if (result.changed) this.dataEvents?.publish({ type: "rows", ...result.changed });
    return "succeeded";
  }

  /**
   * Starts a ready Tool step: claimed (pending → running, so a retried or concurrent advance calls
   * nothing), then its call goes out without being awaited, so nothing that advances the run waits
   * on a tool. Once it settles the step completes (and the run goes on) or fails with the run. A
   * call cut by `stop()` writes nothing: the next start's `recover` fails the step.
   */
  private async startTool(run: RunRow, def: WorkflowDef, steps: StepRow[], step: StepRow, out: Out[]) {
    const node = def.steps.find((s) => s.id === step.nodeId);
    if (node?.type !== "tool") return;
    const [claimed] = await this.db
      .update(stepRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
      .returning();
    if (!claimed) return;
    out.push({ type: "step", step: stepView(claimed) });
    const values = toolValues(def, steps, step.nodeId, step.iteration);
    // Cut by `stop()` (the process ends) or by `stopRun` (this run only).
    const cut = new AbortController();
    this.toolCalls.set(claimed.id, cut);
    const signal = AbortSignal.any([this.stopping.signal, cut.signal]);
    const call = this.track(`tool:${claimed.id}`, async () => {
      const result = await this.toolSteps.run(run.ownerId, node, values, signal).catch((err: unknown) => {
        logError("tool step failed", err, { ref: claimed.id });
        return { ok: false as const, error: stored("engine.fail.toolFailed") };
      });
      if (signal.aborted) return;
      const settled: Out[] = [];
      await this.db.transaction(async (tx) => {
        if (result.ok) await this.complete(tx, claimed, result.outputs, settled);
        else await this.fail(tx, claimed, result.error, settled);
      });
      this.publish(settled);
      if (result.ok) await this.advance(run.id);
    })
      .catch((err: unknown) => logError("tool step failed", err, { ref: claimed.id }))
      .finally(() => this.toolCalls.delete(claimed.id));
    this.keep(call);
  }

  /** The run's Tool steps left running with no call under way in this process: each fails (with the run). */
  private async failInterruptedTools(runId: string) {
    const [run] = await this.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) return;
    const def = await defOf(run, this.db);
    const running = await this.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, "running")));
    for (const step of running) {
      if (def.steps.find((s) => s.id === step.nodeId)?.type !== "tool" || this.inFlight.has(`tool:${step.id}`)) continue;
      await this.failNow(step, TOOL_RESTARTED);
    }
  }

  /** A step's session, started in its own span (inside the Job's, for a Job). */
  private startSession(run: RunRow, def: WorkflowDef, steps: StepRow[], node: WorkflowNode, step: StepRow): Promise<void> {
    const traced = () =>
      traces.startActiveSpan("engine.session.start", { attributes: { "dispand.run.id": run.id, "dispand.step.id": step.id, "dispand.node.id": node.id } }, async (span) => {
        try {
          await this.openSession(run, def, steps, node, step);
        } catch (err) {
          recordError(span, errorKind(err));
          throw err;
        } finally {
          span.end();
        }
      });
    return run.source === "agent" ? inJobTrace(run, () => withJob(run.id, traced)) : traced();
  }

  private async openSession(run: RunRow, def: WorkflowDef, steps: StepRow[], node: WorkflowNode, step: StepRow) {
    // Queued: it starts when it is handed a slot (`slots.ts`), not before.
    if (step.queuedAt) return;
    const resolved = await sessionHarness(this.db, run, node, step);
    if ("problem" in resolved) return this.failNow(step, resolved.problem);
    const { systemPrompt, h, harness, runnerRow } = resolved;
    const values = valuesFor(def, steps, node.id, step.iteration);
    const prompt = renderTemplate(node.prompt ?? "", values);
    // A chat started again without its transcript (gone, or its harness changed) is told the
    // conversation so far: a session's own transcript is the only history it reads.
    const earlier = node.kind === "trigger" ? earlierConversation(await deliveredTranscript(this.db, step.id), TEXT - prompt.length - 2) : "";
    const start: StartParams = {
      sessionId: newId("ses"),
      // One folder per session: the run and the step (a resume reuses its own).
      runKey: step.startedAt ? `${run.id}-${step.id}-${newId("ses")}` : `${run.id}-${step.id}`,
      // A Job's memory joins it when the start is sent (`launch`).
      systemPrompt,
      prompt: earlier ? [prompt, earlier].filter(Boolean).join("\n\n") : prompt,
      expectedOutputs:
        deriveExpectedOutputs(def, await loadTableSchemas(this.db, run.ownerId, tableIdsOf(def)), await loadToolSchemas(this.db, run.ownerId, toolIdsOf(def)))[node.id] ?? [],
      interactive: node.kind === "trigger",
      ...(run.snapshot?.only ? { restricted: true as const } : {}),
    };
    // A Job's session consults the agents of its snapshot that its agent still has (each call is
    // checked again, `consultProblem`); a workflow's agent step has no such tool.
    const consults = run.snapshot ? await consultTargets(this.db, run.snapshot.consults ?? [], run.agentId!) : [];
    // A runner session lists as many as the protocol carries (sorted by name), and offers only those.
    if (consults.length) start.consults = isCloud(harness) ? consults : consults.slice(0, 50);
    if (await this.refusedForScope(step)) return;
    // A person waits on a manual run; the other starts are new work.
    const cls: QueueClass = run.trigger.type === "manual" ? "person" : "new";
    const held: Out[] = [];
    const [started, queued] = await this.db.transaction(async (tx) => {
      // The step's row first, then its harness's (`slots.ts`): a step no longer pending takes nothing.
      const [open] = await tx
        .select({ id: stepRuns.id })
        .from(stepRuns)
        .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
        .for("update");
      if (!open) return [];
      // Its root paused at a checkpoint: it starts once the root goes on (`goOn`).
      if (!(await rootGoing(tx, run.id))) {
        await this.hold(tx, step.id, { kind: "start" }, held);
        return [];
      }
      const life = { ownerId: run.ownerId, actor: { type: "job", runId: run.id }, agentId: run.agentId, jobId: run.id, resource: { type: "job", id: run.id } } as const;
      if ((await take(tx, { id: step.id, harnessId: h.id }, cls)) === "queued") {
        if (run.source === "agent") await recordAudit(tx, { ...life, action: "job.queued", details: { harnessId: h.id, harnessName: h.name } });
        return [undefined, (await tx.select().from(stepRuns).where(eq(stepRuns.id, step.id)))[0]];
      }
      const begun = await tx
        .update(stepRuns)
        .set({ status: "running", sessionId: start.sessionId, harness, runnerId: isCloud(harness) ? CLOUD_SOURCE : harness.runnerId, start, startedAt: new Date(), pendingAction: null })
        .where(eq(stepRuns.id, step.id))
        .returning();
      if (run.source === "agent") {
        await recordAudit(tx, {
          ...life,
          action: "job.started",
          details: { harnessId: h.id, harnessName: h.name, ...(runnerRow ? { runnerId: runnerRow.id, runnerName: runnerRow.name } : {}) },
        });
      }
      return begun;
    });
    this.publish(held);
    if (queued) this.publish([{ type: "step", step: stepView(queued) }]);
    if (!started) return;
    annotate({ "dispand.harness.kind": harness.kind, "dispand.session.id": start.sessionId });
    this.publish([{ type: "step", step: stepView(started) }]);
    // Chat messages sent while it was queued go once the start is written (an unwritten one is
    // resent with them by the runner's reconcile).
    await this.launch(harness, start, started, [], start.interactive ? () => this.flush(started) : undefined);
  }

  /**
   * Hands a session start to the harness, with a Job's memory as it is now (`withMemory`), without
   * waiting for it to arrive: every start, first or sent again, goes this way.
   */
  private async launch(harness: Harness, start: StartParams, step: StepRow, held: string[] = [], written?: () => Promise<void>) {
    const sent = await withMemory(this.db, harness, step, start);
    // Stopped while its memory was read: it never starts. A stop committed after this read is sent
    // after the start, on the same connection.
    const [now] = await this.db.select({ status: stepRuns.status }).from(stepRuns).where(eq(stepRuns.id, step.id));
    if (!now || !ACTIVE_STEP.includes(now.status)) return;
    this.dispatch(harness, sent, step, held, written);
  }

  /**
   * Hands a start as it is to the harness without waiting for it to arrive. Once written, the
   * step records it (and `written` runs); unwritten, the runner's next reconcile sends it again.
   */
  private dispatch(harness: Harness, start: StartParams, step: StepRow, held: string[] = [], written?: () => Promise<void>) {
    // How the start ended, once it has: delivered, waiting for its runner, refused, or failed.
    const outcome = (result: string) => counts.counter("dispand.sessions.started").add(1, { "dispand.harness.kind": harness.kind, "dispand.result": result });
    // Out of the protocol's bounds, the runner would refuse it and every reconcile would resend it.
    const problem = isCloud(harness) ? null : startProblem(harness, start);
    if (problem) {
      outcome("refused");
      const out: Out[] = [];
      const failed = this.db
        .transaction((tx) => this.fail(tx, step, problem, out))
        .then(() => this.publish(out))
        .catch((err: unknown) => logError("session start failed", err, { ref: step.id }));
      this.keep(failed);
      return;
    }
    for (const key of held) this.inFlight.add(key);
    const sent = this.track(`start:${start.sessionId}`, async () => {
      if (!(await this.adapter.start(harness, start))) return outcome("offline");
      await this.db.update(stepRuns).set({ startDeliveredAt: new Date() }).where(eq(stepRuns.id, step.id));
      await written?.();
      // Last: a failure above is counted once, as failed.
      outcome("ok");
    })
      .finally(() => {
        for (const key of held) this.inFlight.delete(key);
      })
      .catch(async (err: unknown) => {
      outcome("failed");
      logError("session start failed", err, { ref: step.id });
      await this.failNow(step, stored("engine.fail.sessionNotStarted"));
    });
    this.keep(sent);
  }

  /**
   * Rights shrink at once: a Job told of a row's change never gets it once its agent may no
   * longer read that table, nor a Job told of a poll's item once its agent lost the tool or the
   * action stopped being pollable, however long its start waited (a runner offline, a resume).
   * Called right before each start of its session is sent; fails the step and says so when it must not go.
   */
  private async refusedForScope(step: StepRow): Promise<boolean> {
    const problem = await lostScope(this.db, step.runId, step.runnerId);
    if (!problem) return false;
    await this.failNow(step, problem);
    return true;
  }

  /** An answer reaches the session as an answer, or, for a question its lost session asked, as a message. */
  private deliverAnswer(q: QuestionRow) {
    // A reconcile may be resuming this session: deliver once it is done, against the row as it left it.
    if (this.reconciling > 0) {
      this.deferred.push(() => this.keep(this.redeliverAnswer(q.id)));
      return;
    }
    // Only a session's questions are delivered (a checkpoint's Approval has none).
    const sessionId = q.sessionId!;
    const losses = this.losses.get(sessionId) ?? 0;
    const sent = this.track(`q:${q.id}`, async () => {
      q = await this.checkedAnswer(q);
      if (q.orphaned && !(await this.admitCodexInput(sessionId, q.id))) return;
      // Who answered goes with the answer itself: an agent's is never shown as the owner's.
      const ok = q.orphaned
        ? await this.adapter.send(sessionId, answerText(q))
        : q.answeredBy?.type === "agent"
          ? await this.adapter.answer(sessionId, q.runnerQuestionId!, q.answer!, q.answeredBy)
          : await this.adapter.answer(sessionId, q.runnerQuestionId!, q.answer!);
      if (ok && (this.losses.get(sessionId) ?? 0) === losses) await this.db.update(questions).set({ deliveredAt: new Date() }).where(eq(questions.id, q.id));
    }).catch((err: unknown) => logError("answer delivery failed", err, { ref: q.id }));
    this.keep(sent);
  }

  /** `steer`: the turn it joins while that turn runs (`steerQueued`); a redelivery sends it as any message. */
  private deliverMessage(step: StepRow, m: MessageRow, steer?: string) {
    const sessionId = step.sessionId!;
    if (this.reconciling > 0) {
      this.deferred.push(() => this.keep(this.redeliverMessage(m.id)));
      return;
    }
    const losses = this.losses.get(sessionId) ?? 0;
    const sent = this.track(`m:${m.id}`, async () => {
      if (!steer && step.harness?.kind === "codex" && !(await this.admitCodexInput(sessionId, m.id))) return;
      const files = m.files ?? [];
      const delivered = steer && this.adapter.steer ? await this.adapter.steer(sessionId, steer, m.id, m.text, files) : await this.adapter.send(sessionId, m.text, files);
      if (delivered && (this.losses.get(sessionId) ?? 0) === losses) {
        await this.db.update(messages).set({ deliveredAt: new Date() }).where(eq(messages.id, m.id));
      }
      // Sent as any message (a redelivery), or a steer that never reached the harness (it goes
      // again as any message): no steer-result will settle it.
      if (!steer || !delivered) await this.db.update(chatQueue).set({ state: "dispatched", updatedAt: new Date() }).where(and(eq(chatQueue.id, m.id), eq(chatQueue.state, "steering")));
    }).catch((err: unknown) => logError("chat message delivery failed", err, { ref: m.id }));
    this.keep(sent);
  }

  /** Only one native input is admitted per turn, including the gap before turn-start arrives. */
  private async admitCodexInput(sessionId: string, inputId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [step] = await tx.select().from(stepRuns).where(eq(stepRuns.sessionId, sessionId)).for("update");
      if (step?.harness?.kind !== "codex" || !step.start?.interactive) return true;
      if (!step.working || !ACTIVE_STEP.includes(step.status) || !(await rootGoing(tx, step.runId))) return false;
      const [answer] = await tx.select().from(questions).where(and(eq(questions.sessionId, sessionId), eq(questions.status, "answered"), eq(questions.orphaned, true), isNull(questions.deliveredAt))).orderBy(asc(questions.answeredAt)).limit(1);
      const first = answer ?? (await undeliveredMessages(tx, step.id))[0];
      if (first?.id !== inputId) return false;
      if (step.codexInputId) return step.codexInputId === inputId;
      if (step.turnStatus !== "idle") return false;
      await tx.update(stepRuns).set({ codexInputId: inputId }).where(eq(stepRuns.id, step.id));
      return true;
    });
  }

  private async redeliverAnswer(id: string) {
    const [row] = await this.db
      .select({ q: questions, step: stepRuns })
      .from(questions)
      .innerJoin(stepRuns, eq(stepRuns.id, questions.stepRunId))
      .where(eq(questions.id, id));
    if (row?.q.status === "answered" && !row.q.deliveredAt && holdsSlot(row.step)) this.deliverAnswer(await this.checkedAnswer(row.q));
  }

  private async redeliverMessage(id: string) {
    const [row] = await this.db
      .select({ m: messages, step: stepRuns })
      .from(messages)
      .innerJoin(stepRuns, eq(stepRuns.id, messages.stepRunId))
      .where(eq(messages.id, id));
    if (row && !row.m.deliveredAt && row.step.sessionId && holdsSlot(row.step)) this.deliverMessage(row.step, row.m);
  }

  /** Keeps `work` in `background` until it settles; a rejection still surfaces, as it would unkept. */
  private keep(work: Promise<void>): void {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  /** Runs `work` unless the same delivery is already under way. */
  private async track(key: string, work: () => Promise<void>): Promise<void> {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      await work();
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Completes the step; its questions still pending (orphaned ones included) expire. */
  private async complete(tx: Tx, step: StepRow, outputs: Record<string, string>, out: Out[]): Promise<boolean> {
    const [row] = await tx
      .update(stepRuns)
      .set({ status: "succeeded", turnStatus: "idle", turnId: null, interruptible: false, interruptAfterPosition: null, codexInputId: null, outputs, finishedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), inArray(stepRuns.status, OPEN_STEP)))
      .returning();
    if (!row) return false;
    out.push({ type: "step", step: stepView(row) });
    await release(tx, row, out);
    // A checkpoint's Approval asked in a chat is the root's, not the step's: it stays.
    await this.expire(tx, eq(questions.stepRunId, step.id), out);
    await this.syncWaiting(tx, step.id, step.runId, out);
    return true;
  }

  /** `fail` in a transaction of its own, then its events. */
  private async failNow(step: StepRow, error: string) {
    const out: Out[] = [];
    await this.db.transaction((tx) => this.fail(tx, step, error, out));
    this.publish(out);
  }

  /** `hold` in a transaction of its own, then its events. */
  private async holdNow(stepId: string, action: PendingAction) {
    const out: Out[] = [];
    await this.db.transaction((tx) => this.hold(tx, stepId, action, out));
    this.publish(out);
  }

  /** Fails the step and its run; the run's pending questions expire. */
  private async fail(tx: Tx, step: StepRow, error: string, out: Out[], stop?: StopReason) {
    const [row] = await tx
      .update(stepRuns)
      .set({ status: "failed", turnStatus: "idle", turnId: null, interruptible: false, interruptAfterPosition: null, codexInputId: null, error, finishedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), inArray(stepRuns.status, OPEN_STEP)))
      .returning();
    if (!row) return;
    out.push({ type: "step", step: stepView(row) });
    // A failed iteration fails its loop too: nothing else would close the loop's row.
    if (step.iteration > 0) {
      const [run] = await tx
        .select({ workflowId: runs.workflowId, version: runs.version, def: runs.def })
        .from(runs)
        .where(eq(runs.id, step.runId));
      const loopId = run && loopOf(await defOf(run, tx), step.nodeId);
      const [loop] = loopId
        ? await tx
            .update(stepRuns)
            .set({ status: "failed", error, finishedAt: new Date() })
            .where(and(eq(stepRuns.runId, step.runId), eq(stepRuns.nodeId, loopId), eq(stepRuns.iteration, 0), inArray(stepRuns.status, OPEN_STEP)))
            .returning()
        : [];
      if (loop) out.push({ type: "step", step: stepView(loop) });
    }
    // A checkpoint's Approval asked on this run is its root's: it stays.
    await this.expire(tx, eq(questions.runId, step.runId), out, stop);
    await this.finishRun(tx, step.runId, "failed", error, out, stop);
    // Nothing more of the run starts or resumes: its steps queued (to start, for an answer or a
    // message, or to resume) or handed a slot leave the queue. Its steps waiting on a question
    // (expired above) never go on: one still holding a slot gives it back.
    const waiting = await tx
      .select()
      .from(stepRuns)
      .where(
        and(
          eq(stepRuns.runId, step.runId),
          inArray(stepRuns.status, OPEN_STEP),
          or(isNotNull(stepRuns.queuedAt), and(inArray(stepRuns.status, ["pending", "waiting"]), eq(stepRuns.working, true))),
        ),
      );
    for (const s of waiting) await release(tx, s, out);
    // Last, once its run is over: none of the run's steps is handed the slot.
    await release(tx, row, out);
  }

  /**
   * Ends the run, in `tx`; a consulted run's consult is answered with it (`answerConsult`). A
   * Job's end is audited with why it failed (`stop`, else `failed`), never its error's words.
   */
  private async finishRun(tx: Tx, runId: string, status: "succeeded" | "failed", error: string | null, out: Out[], stop?: StopReason) {
    const [row] = await tx
      .update(runs)
      .set({ status, error, finishedAt: new Date() })
      .where(and(eq(runs.id, runId), inArray(runs.status, ACTIVE_RUN)))
      .returning();
    if (row) {
      // A workflow run keeps no def: its version's says whether its chat can continue.
      out.push({ type: "run", run: runView(row, await defOf(row, tx)) });
      const attributes = { "dispand.run.source": row.source, "dispand.run.status": status };
      counts.counter("dispand.runs.finished").add(1, attributes);
      counts.histogram("dispand.run.duration", { unit: "ms", description: "From a run's creation to its end" }).record(row.finishedAt!.getTime() - row.createdAt.getTime(), attributes);
      if (row.source === "agent") {
        await recordJobEvent(tx, row, status === "succeeded" ? "finished" : "failed");
        await inJobTrace(row, () => recordAudit(tx, {
          ownerId: row.ownerId,
          actor: { type: "job", runId: row.id },
          agentId: row.agentId,
          jobId: row.id,
          action: status === "succeeded" ? "job.finished" : "job.failed",
          resource: { type: "job", id: row.id },
          result: status === "succeeded" ? "ok" : "failed",
          ...(status === "failed" ? { details: { reason: stop ?? (error === STOPPED ? "stopped" : "failed") } } : {}),
        }));
      }
      await this.answerConsult(tx, row, out);
      // A Stem Job's conflicts it didn't decide are the owner's again, however it ended; its merged values wait in one Inbox Approval.
      const approval = row.trigger.type === "stem" ? await closeStemJob(tx, row.id) : null;
      if (approval) out.push({ type: "question", question: questionView(approval) });
    }
  }

  /** A step, and its run, wait while one of their questions is pending (a checkpoint's is its root's); a step waiting holds no slot. */
  private async syncWaiting(tx: Tx, stepId: string, runId: string, out: Out[]) {
    const pending = async (column: typeof questions.stepRunId | typeof questions.runId, id: string) => {
      const [row] = await tx
        .select({ n: count() })
        .from(questions)
        .where(and(eq(column, id), eq(questions.status, "pending"), isNull(questions.rootId)));
      return (row?.n ?? 0) > 0;
    };
    const stepStatus = (await pending(questions.stepRunId, stepId)) ? "waiting" : "running";
    const [step] = await tx
      .update(stepRuns)
      .set({ status: stepStatus })
      .where(and(eq(stepRuns.id, stepId), inArray(stepRuns.status, ACTIVE_STEP), sql`${stepRuns.status} <> ${stepStatus}`))
      .returning();
    if (step) out.push({ type: "step", step: stepView(step) });
    if (stepStatus === "waiting") {
      const [held] = await tx
        .select()
        .from(stepRuns)
        .where(and(eq(stepRuns.id, stepId), eq(stepRuns.status, "waiting"), eq(stepRuns.working, true)));
      if (held) await release(tx, held, out);
    }
    const runStatus = (await pending(questions.runId, runId)) ? "waiting" : "running";
    const [run] = await tx
      .update(runs)
      .set({ status: runStatus })
      .where(and(eq(runs.id, runId), inArray(runs.status, ACTIVE_RUN), sql`${runs.status} <> ${runStatus}`))
      .returning();
    if (run) out.push({ type: "run", run: runView(run) });
    // A Job's run turning `waiting` (not each question: those have rows of their own).
    if (run?.status === "waiting" && run.source === "agent") {
      const [asked] = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(and(eq(questions.runId, runId), eq(questions.status, "pending"), isNull(questions.rootId)))
        .orderBy(desc(questions.createdAt))
        .limit(1);
      await recordAudit(tx, {
        ownerId: run.ownerId,
        actor: { type: "job", runId },
        agentId: run.agentId,
        jobId: runId,
        action: "job.waiting",
        resource: { type: "job", id: runId },
        details: asked ? { questionId: asked.id } : {},
      });
    }
  }

  private publish(out: Out[]) {
    for (const e of out) {
      // A step handed a slot does what it waited to do (`handOver`).
      if (e.type === "slot") this.keep(this.handOver(e.stepId).catch((err: unknown) => logError("slot hand-over failed", err, { ref: e.stepId })));
      else if (e.type === "job") {
        const started = this.announceCheckpoints().then(() => this.continueRun(e.runId));
        this.keep(started.catch((err: unknown) => logError("consulted Job start failed", err, { ref: e.runId })));
      } else if (e.type === "end") this.endSessions(e.steps);
      else this.events.publish(runOf(e), e);
    }
    if (out.some((e) => e.type === "question")) this.questionChanges.publish("changed", true);
  }
}
