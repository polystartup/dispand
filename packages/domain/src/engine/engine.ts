import { EventPublisher } from "@orpc/server";
import {
  type Answer,
  type HarnessEvent,
  type QuestionPayload,
  SESSION_ALREADY_RUNNING,
  SESSION_NOT_RUNNING,
  SessionStart,
  PERMISSION_INPUT,
  storable,
  TEXT,
} from "@dispand/runner-protocol";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import {
  agentConsults,
  agents,
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
  type JobCause,
  type PendingAction,
  type QueueClass,
  type RootKind,
  type RunStatus,
  type RunTrigger,
  type StepStatus,
} from "../db/schema.ts";
import { newId } from "../ids.ts";
import { errorKind, logError } from "../log.ts";
import type { DataEvents } from "../data/events.ts";
import { loadTableSchemas } from "../data/tables.ts";
import { loadToolSchemas, noToolSteps, type ToolExecutor } from "../tools/executor.ts";
import { tableIdsOf, validateDataSteps } from "../workflows/data-steps.ts";
import { deriveExpectedOutputs, validateWorkflow, type WorkflowIssue } from "../workflows/derive.ts";
import { loopOf, nodesOf, type WorkflowDef, type WorkflowNode } from "../workflows/model.ts";
import { renderTemplate } from "../workflows/template.ts";
import { toolIdsOf, validateToolSteps } from "../workflows/tool-steps.ts";
import type { CloudKind } from "../harnesses/cloud.ts";
import { CLOUD_SOURCE, type CliHarness, type ConsultTarget, type Harness, type HarnessAdapter, isCloud, type StartParams } from "./harness.ts";
import { runDataStep } from "./data-step.ts";
import { aboutExposed, isExposedName, stopAsking } from "../platform/exposed.ts";
import { annotate, currentTraceId, meter, recordError, spanEvent, tracer, withJob } from "../telemetry/index.ts";
import { CONSULT, REQUEST_APPROVAL } from "../cloud/builtins.ts";
import { attachProposal, settleProposal } from "../platform/proposals.ts";
import { issueJobToken } from "../platform/token.ts";
import type { SecretBox } from "../secrets.ts";
import { consultOutputs, jobDef, jobSystemPrompt } from "./job-def.ts";
import { jobMemoryPrompt } from "../memory/read.ts";
import { deletedAgent } from "../jobs/agent-name.ts";
import { agentName, approvalOf, consultEnd, consultProblem, DECLINED, deliveryProblem, failed, FLAGGED, lockConsults, TOO_LONG } from "./consults.ts";
import { nextActions, outputsFor, toolValues, valuesFor } from "./next-actions.ts";
import { consultsOf, type ConsultEntry } from "../agents/consults.ts";
import { skillsAndTools } from "../agents/skills-and-tools.ts";
import { pollProblem } from "../tools/pollable.ts";
import { give, next, take } from "./slots.ts";
import { checkpointOf, newRoot, pause, pausedGauge, ROOT_STOPPED, rootGoing } from "./roots.ts";
import { recordInteraction, recordInteractions } from "./interactions.ts";
import { recordAudit, recordAuditAfter } from "../audit/record.ts";
import type { AuditActor } from "../audit/model.ts";
import { jobScope, startable } from "../questions/inbox-scope.ts";
import { INTERACTION } from "../triggers/model.ts";

type RunRow = typeof runs.$inferSelect;
type StepRow = typeof stepRuns.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type QuestionRow = typeof questions.$inferSelect;
type RunnerRow = typeof runners.$inferSelect;

const traces = tracer("engine");
const counts = meter("engine");

const ACTIVE_RUN: RunStatus[] = ["running", "waiting"];

/** Why a Job was stopped, as its `job.failed` Audit row says: a person, a declined checkpoint, a consult taken back. */
type StopReason = "stopped" | "stopped-checkpoint" | "consult-revoked";

/** Who made a Job, for its `job.created` row: the person who started it, the asking Job of a consult, else the scheduler that fired it. */
function creatorOf(ownerId: string, cause: JobCause): AuditActor {
  if (cause.kind === "user") return { type: "user", userId: ownerId };
  if (cause.kind === "consult") return { type: "job", runId: cause.jobId };
  return { type: "scheduler" };
}
const ACTIVE_STEP: StepStatus[] = ["running", "waiting"];
const OPEN_STEP: StepStatus[] = ["pending", "running", "waiting"];

/** Why a Tool step that was calling its tool when Dispand stopped fails (it is never called again). */
export const TOOL_RESTARTED = "Dispand restarted during this tool call: check the tool before running again";

/** Why the steps of a run stopped by hand failed, and the run with them. */
export const STOPPED = "Stopped";

/** Sent as the first message of a session resumed after its runner lost it. */
export const RESUME_PROMPT = "Dispand reconnected after an interruption. Continue where you left off.";

export function runView(r: RunRow) {
  const { id, source, workflowId, version, agentId, triggerId, status, trigger, error, createdAt, finishedAt } = r;
  // A Job whose agent was deleted names it as it kept it: "Order drafter (Deleted)".
  const deletedAgentName = agentId === null && r.agentName !== null ? deletedAgent(r.agentName) : null;
  return { id, source, workflowId, version, agentId, deletedAgentName, triggerId, status, trigger, error, createdAt, finishedAt };
}
export function stepView(s: StepRow) {
  const { id, runId, nodeId, iteration, status, outputs, error, startedAt, finishedAt, queuedAt } = s;
  // prompt: as the step got it, values filled in (for the owner to debug a run); null until started.
  return { id, runId, nodeId, iteration, status, outputs, error, startedAt, finishedAt, queuedAt, interactive: s.start?.interactive ?? false, prompt: s.start?.prompt ?? null };
}
export function messageView(m: MessageRow) {
  const { id, runId, stepRunId, role, text, createdAt } = m;
  return { id, runId, stepRunId, role, text, createdAt };
}
export function questionView(q: QuestionRow) {
  // `rootId`: a checkpoint's Approval (`roots.ts`), and `consultId` a consult's, each told apart by it and never by its tool name.
  const { id, runId, stepRunId, placement, payload, status, answer, createdAt, about, proposalId, rootId, consultId } = q;
  return { id, runId, stepRunId, placement, payload, status, answer, createdAt, about, proposalId, rootId, consultId };
}

/** What `runs.stream` forwards: each carries the whole row as it is now (upserts by id). */
export type RunEvent =
  | { type: "run"; run: ReturnType<typeof runView> }
  | { type: "step"; step: ReturnType<typeof stepView> }
  | { type: "message"; message: ReturnType<typeof messageView> }
  | { type: "question"; question: ReturnType<typeof questionView> };

/**
 * What a transaction leaves to do once it commits: its runs' events, the steps it handed a slot
 * to (`slots.ts`), the Jobs it made (a consult's: they start), and the sessions of the steps it
 * stopped (told to end).
 */
export type Out = RunEvent | { type: "slot"; runId: string; stepId: string } | { type: "job"; runId: string } | { type: "end"; steps: StepRow[] };

/** The run an event is about, which `publish` sends it to. */
function runOf(e: RunEvent): string {
  if (e.type === "run") return e.run.id;
  if (e.type === "step") return e.step.runId;
  if (e.type === "message") return e.message.runId;
  return e.question.runId;
}

/** Why the runner would refuse this start (the protocol's `SessionStart`), in the owner's words; null if it wouldn't. */
export function startProblem(harness: CliHarness, { runKey, ...start }: StartParams): string | null {
  const parsed = SessionStart.safeParse({
    ...start,
    harness: harness.kind,
    cwd: { mode: "per-run", runKey },
    permissionMode: harness.permissionMode,
    ...(harness.model ? { model: harness.model } : {}),
    skills: [],
    mcpServers: [],
  });
  if (parsed.success) return null;
  const field = String(parsed.error.issues[0]?.path[0] ?? "start");
  if (field === "prompt" && start.prompt.length > TEXT) {
    return `The step's prompt is too long once its values are filled in (${start.prompt.length} characters, at most ${TEXT})`;
  }
  const what = { prompt: "prompt", systemPrompt: "agent's system prompt", expectedOutputs: "expected outputs", model: "model" }[field] ?? field;
  return `The session can't start: its ${what} is outside what a runner accepts`;
}

/**
 * Why the runner can't run this CLI, as it last reported it (`hello.clis`); null when it can or
 * hasn't reported yet. The runner checks Codex's sign-in once, when it starts.
 */
export function cliProblem(kind: string, runner: Pick<RunnerRow, "name" | "clis" | "lastSeenAt">): string | null {
  if (kind !== "codex" || runner.lastSeenAt === null) return null;
  if (!runner.clis.codex) return `Codex isn't installed on ${runner.name}`;
  if (!runner.clis.codex.signedIn) return `Sign in to Codex on ${runner.name}: run \`codex login\` there, then restart its runner`;
  return null;
}

/** Who gave an agent's answer (`inbox`), as the asking Job is told it. */
const answeredByAgent = (name: string) => `Answered by the agent ${name}`;

/**
 * An agent's choice answer as a CLI session gets it: a CLI shows any answer as the owner's, so
 * each question's answer says, in its own words, which agent gave it (a label so changed reaches
 * the CLI as free text, whole). It goes with the answer: the session resumes on it.
 */
export function attributed(answer: Answer, name: string): Answer {
  if (answer.kind !== "choice") return answer;
  const note = ` (${answeredByAgent(name)}, not by the owner)`;
  const answers = Object.fromEntries(
    Object.entries(answer.answers).map(([question, given]) => [question, Array.isArray(given) ? given.map((g, i) => (i === given.length - 1 ? g + note : g)) : given + note]),
  );
  return { kind: "choice", answers };
}

/** An answer in words, for a session that can only get it as a message. */
/** The words of an approval asked with `request_approval`; null for any other question. */
function approvalWords(payload: QuestionPayload): string | null {
  if (payload.kind !== "permission" || payload.toolName !== "request_approval") return null;
  const message = (payload.input as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : null;
}

export function answerText(q: Pick<QuestionRow, "payload" | "answer"> & Partial<Pick<QuestionRow, "answeredBy">>): string {
  const a = q.answer!;
  if (a.kind === "consult") {
    // The answer of the agent consulted, which the asker is told it is from; or why there is none.
    if (a.outcome === "failed") return `Your consult got no answer: ${a.text}`.slice(0, TEXT);
    const name = q.answeredBy?.type === "agent" ? q.answeredBy.name : "consulted";
    return `Answer from the agent ${name}:\n\n${a.text}`.slice(0, TEXT);
  }
  if (a.kind === "choice") {
    const parts = Object.entries(a.answers).map(([question, answer]) => `“${question}”: ${Array.isArray(answer) ? answer.join(", ") : answer}`);
    return `${q.answeredBy?.type === "agent" ? answeredByAgent(q.answeredBy.name) : "The owner answered"}: ${parts.join("; ")}.`;
  }
  if (a.kind === "permission") {
    const asked = approvalWords(q.payload);
    // An approval the agent asked for in its own words: told back with those words.
    if (asked !== null) return `The owner ${a.decision === "deny" ? "denied" : "approved"} your request (“${asked.slice(0, 500).toWellFormed()}”)${a.message ? `: ${a.message}` : "."}`;
    const tool = q.payload.kind === "permission" ? q.payload.toolName : "the tool";
    const verdict = a.decision === "deny" ? "denied" : "allowed";
    return `The owner ${verdict} ${tool}${a.message ? `: ${a.message}` : "."}`;
  }
  return a.confirmed
    ? "The owner confirmed your values: call submit_outputs again with them."
    : `The owner did not confirm your values${a.feedback ? `: ${a.feedback}` : "."}`;
}

function questionText(q: QuestionRow): string {
  const p = q.payload;
  if (p.kind === "choice") return p.questions.map((x) => `“${x.question}”`).join(", ");
  if (approvalWords(p) !== null) return "your approval request";
  if (p.kind === "consult") return "the answer of the agent you consulted";
  if (p.kind === "permission") return `permission to use ${p.toolName}`;
  return "confirmation of your values";
}

/** The first message of a resumed session: what it missed while it was gone. */
/**
 * The first message of a resumed session: what it missed while it was gone, as much as fits the
 * protocol's prompt limit (oldest first). What doesn't fit is returned, to follow as messages.
 */
export function resumePrompt(
  original: string | null,
  answered: QuestionRow[],
  unsent: MessageRow[],
  waiting: QuestionRow[],
): { prompt: string; answers: QuestionRow[]; messages: MessageRow[]; laterAnswers: QuestionRow[]; laterMessages: MessageRow[] } {
  // An empty original (a chat whose trigger has no instructions) adds nothing.
  const parts = original === "" ? [] : [original ?? RESUME_PROMPT];
  let length = parts[0]?.length ?? 0;
  const waitingLine =
    waiting.length > 0 ? `Still waiting for the owner: ${waiting.map(questionText).join("; ")}. Their answer will come as a message.` : "";
  const room = TEXT - (waitingLine ? waitingLine.length + 2 : 0);
  let full = false;
  const fits = (text: string) => {
    if (!full && length + 2 + text.length <= room) {
      parts.push(text);
      length += 2 + text.length;
      return true;
    }
    // Once something doesn't fit, the rest follows it, so the order holds.
    full = true;
    return false;
  };
  const answers = answered.filter((q) => fits(answerText(q)));
  const messages = unsent.filter((m) => fits(`The owner wrote: ${m.text}`));
  if (waitingLine && length + 2 + waitingLine.length <= TEXT) parts.push(waitingLine);
  return {
    prompt: parts.join("\n\n"),
    answers,
    messages,
    laterAnswers: answered.slice(answers.length),
    laterMessages: unsent.slice(messages.length),
  };
}

/**
 * Whether the step's session may get answers and chat messages now: it holds a slot (or has no
 * harness to charge). Every path that sends them to a session it may not have reached goes
 * through here; what may not go stays undelivered, sent when the step is handed a slot (`handOver`).
 */
function holdsSlot(step: Pick<StepRow, "working" | "harnessId">): boolean {
  return step.working || !step.harnessId;
}

/** A consult ended: how, and how long its asker waited (never its question or its answer). */
function consultEnded(q: QuestionRow, outcome: "answered" | "refused" | "failed" | "stopped") {
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

/** What keeps `def` from running: its own issues, its data steps' against the owner's tables and its Tool steps' against the owner's tools. */
export async function runIssues(db: Db | Tx, ownerId: string, def: WorkflowDef): Promise<WorkflowIssue[]> {
  return [
    ...validateWorkflow(def),
    ...validateDataSteps(def, await loadTableSchemas(db, ownerId, tableIdsOf(def))),
    ...validateToolSteps(def, await loadToolSchemas(db, ownerId, toolIdsOf(def))),
  ];
}

/**
 * Each agent step's harness as its agent is now, by node, for its row: what a queued step is
 * charged to. A workflow agent step's is set again when it becomes ready (`openSession`).
 */
async function agentHarnesses(db: Db | Tx, ownerId: string, nodes: object[]): Promise<(node: object) => string | null> {
  const agentOf = (n: object) => ("agentId" in n && typeof n.agentId === "string" && n.agentId ? n.agentId : null);
  const ids = [...new Set(nodes.flatMap((n) => agentOf(n) ?? []))];
  const rows = ids.length
    ? await db.select({ id: agents.id, harnessId: agents.harnessId }).from(agents).where(and(inArray(agents.id, ids), eq(agents.ownerId, ownerId)))
    : [];
  const byAgent = new Map(rows.map((r) => [r.id, r.harnessId]));
  return (n) => byAgent.get(agentOf(n) ?? "") ?? null;
}

export class EngineError extends Error {
  override name = "EngineError";
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "CLOSED" | "NOT_PENDING" | "STOPPED",
    message: string,
  ) {
    super(message);
  }
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
    private readonly cloud?: { recover(going: (runId: string) => Promise<boolean>): Promise<string[]> },
    /** Where data steps publish the rows they write (`rows.stream`). */
    private readonly dataEvents?: DataEvents,
    /** Runs Tool steps (`connectorToolExecutor`); without one, they fail. */
    private readonly toolSteps: ToolExecutor = noToolSteps,
    /** Seals each Job's token; without one, Jobs get no token (and no Job endpoint). */
    private readonly secrets?: SecretBox,
  ) {}

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
    if (!workflow) throw new EngineError("NOT_FOUND", "Workflow not found");
    const [version] = await tx
      .select({ def: workflowVersions.def })
      .from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, workflow.currentVersion)));
    const def = version!.def;
    const [issue] = await runIssues(tx, workflow.ownerId, def);
    if (issue) throw new EngineError("INVALID", issue.message);
    const runId = newId("run");
    await tx.insert(runs).values({ id: runId, ownerId: workflow.ownerId, workflowId, version: workflow.currentVersion, status: "running", trigger, traceId: currentTraceId() ?? null });
    counts.counter("dispand.runs.created").add(1, { "dispand.run.source": "workflow", "dispand.run.trigger": trigger.type });
    // A loop's body gets its rows when each iteration opens.
    const top = nodesOf(def).filter((n) => n.loopId === undefined);
    const harnessOf = await agentHarnesses(tx, workflow.ownerId, top);
    await tx.insert(stepRuns).values(top.map((n) => ({ id: newId("step"), ownerId: workflow.ownerId, runId, nodeId: n.id, harnessId: harnessOf(n), status: "pending" as const })));
    return runId;
  }

  /** Starts a Job of the owner's trigger (a manual start) and returns its id. */
  async startJob(triggerId: string, ownerId: string): Promise<string> {
    const runId = await this.db.transaction(async (tx) => {
      const [trigger] = await tx
        .select({ agentId: triggers.agentId })
        .from(triggers)
        .where(and(eq(triggers.id, triggerId), eq(triggers.ownerId, ownerId)));
      if (!trigger) throw new EngineError("NOT_FOUND", "Trigger not found");
      return this.createJob(tx, { ownerId, agentId: trigger.agentId, triggerId, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } });
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
      if (!root) throw new EngineError("NOT_FOUND", "Root cause not found");
      if (root.state === "stopped") throw new EngineError("STOPPED", ROOT_STOPPED);
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
    if (!agent) throw new EngineError("NOT_FOUND", "Agent not found");
    if (firing.type === "consult" ? triggerId || !given : !trigger || !trigger.enabled) throw new EngineError("NOT_FOUND", "Trigger not found");
    const root = given ?? (await lockRoot(await newRoot(tx, ownerId, cause.kind as RootKind, runId)));
    const rootId = root.id;
    const { skills, tools } = await skillsAndTools(tx, agentId);
    const snapshot: AgentSnapshot = {
      id: agent.id,
      name: agent.name,
      harnessId: agent.harnessId,
      systemPrompt: jobSystemPrompt(agent),
      ...(agent.model ? { model: agent.model } : {}),
      skills,
      tools: tools.map(({ toolId, name }) => ({ toolId, name })),
      bundles: agent.bundles,
      tables: agent.dataTables,
      selfLearning: agent.selfLearning,
      consults: await consultsOf(tx, agentId),
    };
    const def = jobDef({ agent: snapshot, trigger: trigger ?? null });
    const token = this.secrets ? issueJobToken(this.secrets, runId) : undefined;
    await tx.insert(runs).values({
      id: runId,
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
      traceId: currentTraceId() ?? null,
    });
    counts.counter("dispand.runs.created").add(1, { "dispand.run.source": "agent", "dispand.run.trigger": firing.type });
    const creator = creatorOf(ownerId, cause);
    await recordAudit(tx, {
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
    });
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
      const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).for("update");
      if (!run) throw new EngineError("NOT_FOUND", "Run not found");
      if (!ACTIVE_RUN.includes(run.status)) throw new EngineError("CLOSED", "This run is over");
      return this.stopIn(tx, runId, out);
    });
    this.publish(out);
    this.endSessions(sessions);
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

  /** The owner's next chat message to the run's chat session. */
  async sendChat(runId: string, text: string): Promise<void> {
    const steps = await this.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, runId), inArray(stepRuns.status, OPEN_STEP)));
    // A chat whose session waits for a slot (`slots.ts`) keeps the message: its start sends it.
    const chat = steps.find((s) => s.start?.interactive && s.sessionId && ACTIVE_STEP.includes(s.status)) ?? (await this.queuedChat(runId, steps));
    if (!chat) throw new EngineError("CLOSED", "The chat is over");
    const out: Out[] = [];
    const { row, working } = await this.db.transaction(async (tx) => {
      // Each message of the owner is a root cause of its own, unless the chat's is paused at a
      // checkpoint: the message then waits, undelivered, for that one to go on.
      const going = await this.rootGoingLocked(tx, runId);
      if (going) await tx.update(runs).set({ rootId: await newRoot(tx, chat.ownerId, "chat", runId) }).where(eq(runs.id, runId));
      const [row] = await tx
        .insert(messages)
        .values({ id: newId("msg"), ownerId: chat.ownerId, runId, stepRunId: chat.id, role: "user", text })
        .returning();
      out.push({ type: "message", message: messageView(row!) });
      // Not started yet: its start sends what is stored by then (and waits for the root too).
      if (!chat.sessionId) return { row: row!, working: true };
      if (!going) {
        await this.hold(tx, chat.id, { kind: "deliver" }, out);
        return { row: row!, working: false };
      }
      // A session between turns takes a slot first, a person waiting on it, or queues with the message.
      if (!chat.harnessId) return { row: row!, working: true };
      const got = await take(tx, { id: chat.id, harnessId: chat.harnessId }, "person", { kind: "deliver" });
      if (got === "queued") await this.pushStep(tx, chat.id, out);
      return { row: row!, working: got === "working" };
    });
    this.publish(out);
    if (chat.sessionId) {
      if (working) this.deliverMessage(chat.sessionId, row);
      return;
    }
    // Queued for its start: the start sends what is stored by then. If it was written meanwhile,
    // this one goes as any message to a started chat (its first turn may be over by now), unless
    // the start's flush sent it already.
    const [now] = await this.db.select().from(stepRuns).where(eq(stepRuns.id, chat.id));
    if (!now?.sessionId || !now.startDeliveredAt) return;
    const late: Out[] = [];
    const going = await this.db.transaction(async (tx) => {
      if (!(await rootGoing(tx, runId))) {
        await this.hold(tx, now.id, { kind: "deliver" }, late);
        return false;
      }
      if (now.harnessId && (await take(tx, { id: now.id, harnessId: now.harnessId }, "person", { kind: "deliver" })) === "queued") await this.pushStep(tx, now.id, late);
      return true;
    });
    this.publish(late);
    if (going) await this.redeliverMessage(row.id);
  }

  /** Sends the answers and chat messages that wait for the step's session (it holds a slot). */
  private async flush(stepId: string, sessionId: string) {
    for (const q of await this.undeliveredAnswers(sessionId)) this.deliverAnswer(q);
    for (const m of await this.undeliveredMessages(stepId)) this.deliverMessage(sessionId, m);
  }

  /** The step as it is now, for `runs.stream` (it queued, or left the queue). */
  private async pushStep(tx: Tx, stepId: string, out: Out[]) {
    const [row] = await tx.select().from(stepRuns).where(eq(stepRuns.id, stepId));
    if (row) out.push({ type: "step", step: stepView(row) });
  }

  /**
   * A step handed a slot does what it waited to do (`pending_action`): its start goes as its run
   * advances; its waiting answers and messages go, or its lost session resumes. Cleared as it goes:
   * the rows it sends stay undelivered until they reach the session, and every reconcile of a
   * step holding a slot sends those again.
   */
  private async handOver(stepId: string) {
    const [step] = await this.db.select().from(stepRuns).where(eq(stepRuns.id, stepId));
    if (!step?.working || !step.pendingAction) return;
    // Its root paused at a checkpoint meanwhile: the slot goes back, what it waited to do waits on.
    if (!(await rootGoing(this.db, step.runId))) {
      const out: Out[] = [];
      const action = step.pendingAction;
      await this.db.transaction((tx) => this.hold(tx, stepId, action, out));
      return this.publish(out);
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
          this.launch(claimed.harness!, claimed.start!, claimed);
          for (const m of await this.undeliveredMessages(claimed.id)) this.deliverMessage(claimed.sessionId!, m);
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
    else await this.flush(claimed.id, claimed.sessionId);
  }

  /** The run's chat step queued for a slot of its harness, or handed one (or held) and not started yet. */
  private async queuedChat(runId: string, steps: StepRow[]): Promise<StepRow | undefined> {
    const [run] = await this.db.select().from(runs).where(eq(runs.id, runId));
    if (!run || !ACTIVE_RUN.includes(run.status)) return undefined;
    const { field } = (await this.defOf(run)).trigger;
    if (field.type !== "chat") return undefined;
    // Held, too, while its root is paused at a checkpoint (`hold`).
    return steps.find((s) => s.nodeId === field.id && s.status === "pending" && (s.queuedAt || s.working || s.pendingAction));
  }

  /** Records the owner's answer (once) and sends it to the session. */
  async answer(questionId: string, answer: Answer, by?: AnsweredBy): Promise<void> {
    // Any answer may have to go as words (its session lost and resumed): those must fit a message.
    const [asked] = await this.db.select({ payload: questions.payload, kind: questions.kind, ownerId: questions.ownerId, runId: questions.runId, consultId: questions.consultId }).from(questions).where(eq(questions.id, questionId));
    // Nothing answers in a consulted agent's place: only its Job does (`answerConsult`).
    if (asked?.kind === "consult") throw new EngineError("NOT_FOUND", "Question not found");
    if (asked) {
      const words = answerText({ payload: asked.payload, answer, answeredBy: by ?? null });
      if (words.length > TEXT || !storable(words)) throw new EngineError("INVALID", `The answer is too long (at most about ${TEXT - 100} characters)`);
    }
    const out: Out[] = [];
    const settled = await this.db.transaction(async (tx) => {
      // A consult's Approval may make a Job in the asking Job's root: that root is locked first (`applyEvent`).
      if (asked?.consultId) {
        await lockConsults(tx, asked.ownerId);
        await this.rootGoingLocked(tx, asked.runId);
      }
      const [q] = await tx
        .update(questions)
        .set({ status: "answered", answer, answeredAt: new Date(), answeredBy: by ?? null })
        .where(and(eq(questions.id, questionId), eq(questions.status, "pending")))
        .returning();
      if (!q) return undefined;
      // An agent's answer is its Job's write.
      await recordInteraction(tx, q, "answered", by?.type === "agent" ? { type: "job", runId: by.runId } : (by ?? { type: "user", userId: q.ownerId }));
      // A checkpoint's Approval: no session waits on it, its root does.
      if (q.rootId) {
        out.push({ type: "question", question: questionView(q) });
        return { q, step: null, root: await this.settleRoot(tx, q.rootId, answer) };
      }
      // A consult's Approval: no session asked it, so none is sent its answer; the consult goes on or ends.
      if (q.consultId) {
        Object.assign(q, (await tx.update(questions).set({ deliveredAt: new Date() }).where(eq(questions.id, q.id)).returning())[0]);
        out.push({ type: "question", question: questionView(q) });
        await this.consultApproved(tx, q, answer, by, out);
        return { q, step: null };
      }
      // A person's "always allow" to a CLI session's approval of one of its agent's tools: that
      // action stops asking on the agent, with the answer that was just taken (an answer that
      // came second grants nothing). The answer is used up as it is given: the call it is for
      // needs no approval any more, and it must not stay for a later one. When the name stands
      // for nothing the agent chose, nothing is granted and the answer allows this call only:
      // the runner must not stop prompting for a call the endpoint would still refuse.
      if (by?.type === "user" && answer.kind === "permission" && answer.decision === "allow-always" && q.payload.kind === "permission" && isExposedName(q.payload.toolName)) {
        const stopped = await stopAsking(tx as unknown as Db, q.runId, q.payload.toolName);
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
      return { q, step: await this.toSession(tx, q, out) };
    });
    const { q, step } = settled ?? {};
    const root = settled && "root" in settled ? settled.root : undefined;
    if (!q) throw new EngineError("NOT_PENDING", "This question is no longer waiting for an answer");
    const decision = q.answer?.kind === "permission" ? q.answer.decision : q.answer?.kind ?? "none";
    counts.counter("dispand.questions.answered").add(1, { "dispand.question.kind": q.kind, "dispand.answer.decision": decision, "dispand.answer.by": q.answeredBy?.type ?? "user" });
    counts.histogram("dispand.question.wait", { unit: "ms", description: "From a question to its answer" }).record(q.answeredAt!.getTime() - q.createdAt.getTime(), { "dispand.question.kind": q.kind });
    this.publish(out);
    if (step) await this.flush(step.id, step.sessionId!);
    if (root?.stopped) {
      for (const events of root.stopped.outs.values()) this.publish(events);
      this.endSessions(root.stopped.sessions);
    }
    if (root?.goOn) await this.goOn(root.goOn);
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
      await this.pushStep(tx, step.id, out);
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
    consultEnded(q, outcome);
    await this.expireApprovals(tx, [q.id], out);
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
    for (const q of expired) out.push({ type: "question", question: questionView(q) });
    await this.expireApprovals(tx, expired.filter((q) => q.kind === "consult").map((q) => q.id), out);
    for (const q of expired) {
      if (q.kind !== "consult") continue;
      consultEnded(q, "stopped");
      if (!q.consultRunId) continue;
      const [going] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.id, q.consultRunId), inArray(runs.status, ACTIVE_RUN))).for("update");
      // Stopped for the reason its asker was, if any (a declined checkpoint, a consult taken back).
      if (going) out.push({ type: "end", steps: await this.stopIn(tx, going.id, out, stop) });
    }
  }

  /** The Approvals still pending of these consults, which ended without them: they leave the Inbox with them. */
  private async expireApprovals(tx: Tx, consultIds: string[], out: Out[]): Promise<void> {
    if (consultIds.length === 0) return;
    const expired = await tx
      .update(questions)
      .set({ status: "expired" })
      .where(and(inArray(questions.consultId, consultIds), eq(questions.status, "pending")))
      .returning();
    await recordInteractions(tx, expired, "expired");
    for (const q of expired) out.push({ type: "question", question: questionView(q) });
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
  private async settleRoot(tx: Tx, rootId: string, answer: Answer): Promise<{ stopped?: { outs: Map<string, Out[]>; sessions: StepRow[] }; goOn?: string }> {
    const decision = answer.kind === "permission" ? answer.decision : "deny";
    counts.counter("dispand.checkpoints.answered").add(1, { "dispand.checkpoint.answer": decision === "allow-always" ? "dont-ask" : decision === "allow" ? "approve" : "decline" });
    const [root] = await tx.select().from(roots).where(eq(roots.id, rootId)).for("update");
    if (!root || root.state !== "paused") return {};
    if (decision !== "deny") {
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
    await tx.update(events).set({ processedAt: now }).where(and(eq(events.rootId, rootId), isNull(events.processedAt)));
    const going = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.rootId, rootId), inArray(runs.status, ACTIVE_RUN)))
      .for("update");
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
    const undelivered = async () => (await this.undeliveredAnswers(step.sessionId!)).length > 0 || (await this.undeliveredMessages(step.id)).length > 0;
    const action: PendingAction | null = !step.startDeliveredAt
      ? { kind: "start" }
      : (step.pendingAction ?? (step.status === "running" && (await undelivered()) ? { kind: "deliver" } : null));
    // An answer waits until no question of the step is pending; a resume carries what the session missed.
    if (!action || (action.kind === "deliver" && step.status !== "running")) return;
    const out: Out[] = [];
    const got = await this.db.transaction(async (tx) => {
      const got = step.harnessId ? await take(tx, { id: step.id, harnessId: step.harnessId }, "resume", action) : "working";
      if (got === "working") await tx.update(stepRuns).set({ pendingAction: action }).where(and(eq(stepRuns.id, step.id), inArray(stepRuns.status, ACTIVE_STEP)));
      else await this.pushStep(tx, step.id, out);
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
    if (!turning) await this.release(tx, step, out);
    await tx
      .update(stepRuns)
      .set({ pendingAction: step.pendingAction?.kind === "resume" ? step.pendingAction : action })
      .where(eq(stepRuns.id, stepId));
    spanEvent("engine.slot", { "dispand.slot.action": "hold", "dispand.step.id": stepId });
  }

  /** `rootGoing`, with the run's root locked: a chat message and a checkpoint are decided one after the other. */
  private async rootGoingLocked(tx: Tx, runId: string): Promise<boolean> {
    const [row] = await tx.select({ state: roots.state }).from(runs).innerJoin(roots, eq(roots.id, runs.rootId)).where(eq(runs.id, runId)).for("update", { of: roots });
    return !row || row.state === "going";
  }

  /** One event of a session, from the runner `from.runnerId` (events for another runner's session are ignored). */
  async onHarnessEvent(sessionId: string, event: HarnessEvent, from: { runnerId: string; seq: number }): Promise<void> {
    // The runner lost the session: answers and chat messages wait until the resume has carried
    // what it missed, as during a reconcile, or they would go to the lost session (which the runner
    // reports only once) and be marked delivered.
    if (event.type === "error" && event.message === SESSION_NOT_RUNNING) return this.holdingDeliveries(() => this.handleEvent(sessionId, event, from));
    return this.handleEvent(sessionId, event, from);
  }

  private async handleEvent(sessionId: string, event: HarnessEvent, from: { runnerId: string; seq: number }): Promise<void> {
    counts.counter("dispand.harness.events").add(1, { "dispand.event.type": event.type });
    // Words stream as many small events: those are counted, the others traced one by one.
    if (event.type === "text") return this.applyEvent(sessionId, event, from);
    return traces.startActiveSpan("engine.event", { attributes: { "dispand.event.type": event.type, "dispand.session.id": sessionId, "dispand.runner.id": from.runnerId } }, async (span) => {
      try {
        await this.applyEvent(sessionId, event, from);
      } catch (err) {
        recordError(span, errorKind(err));
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async applyEvent(sessionId: string, event: HarnessEvent, from: { runnerId: string; seq: number }): Promise<void> {
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
          .where(and(eq(stepRuns.sessionId, sessionId), eq(stepRuns.runnerId, from.runnerId)))
          .for("update", { of: roots });
      }
      const [step] = await tx
        .update(stepRuns)
        .set({ eventSeq: from.seq, ...(event.type === "error" ? {} : { lastActivityAt: new Date() }) })
        .where(and(eq(stepRuns.sessionId, sessionId), eq(stepRuns.runnerId, from.runnerId), lt(stepRuns.eventSeq, from.seq)))
        .returning();
      if (!step) return null;
      annotate({ "dispand.job.id": step.runId, "dispand.step.id": step.id });
      return { step, next: await this.apply(tx, step, event, out) };
    });
    if (!result) {
      // A replay of an event already applied: what it started may not have finished (advance
      // failed after the commit, and the hub didn't ack), so advancing again is the retry.
      await this.retryAdvance(sessionId, from.runnerId);
      return;
    }
    this.publish(out);
    if (result.next === "advance") await this.advance(result.step.runId);
    // Only database work is awaited: the start itself goes out without waiting.
    if (result.next === "resume" && !this.inFlight.has(`start:${sessionId}`)) await this.resume(result.step);
  }

  private async retryAdvance(sessionId: string, runnerId: string) {
    const [row] = await this.db
      .select({ runId: stepRuns.runId, status: stepRuns.status })
      .from(stepRuns)
      .where(and(eq(stepRuns.sessionId, sessionId), eq(stepRuns.runnerId, runnerId)));
    if (row?.status === "succeeded") await this.advance(row.runId);
  }

  /** A runner was revoked: its open sessions never come back, so their steps (and runs) fail. */
  async runnerRevoked(runnerId: string): Promise<void> {
    const open = await this.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runnerId, runnerId), inArray(stepRuns.status, ACTIVE_STEP)));
    for (const step of open) {
      const out: Out[] = [];
      await this.db.transaction((tx) => this.fail(tx, step, "The agent's runner was revoked", out));
      this.publish(out);
    }
  }

  /**
   * On boot: active runs continue (steps whose predecessors are done start). A Tool step left
   * running was calling its tool when Dispand stopped: it fails, and is never called again.
   * Sessions are reconciled per runner.
   */
  async recover(): Promise<void> {
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
        .select({ step: stepRuns })
        .from(stepRuns)
        .innerJoin(runs, eq(runs.id, stepRuns.runId))
        .where(and(eq(stepRuns.runnerId, runnerId), inArray(runs.status, ACTIVE_RUN), inArray(stepRuns.status, ACTIVE_STEP)));
      for (const { step: row } of steps) {
        let step = row;
        const sessionId = step.sessionId!;
        if (this.inFlight.has(`start:${sessionId}`)) continue;
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
          if (lost) await this.unconfirm(this.db, step);
          if (!step.startDeliveredAt || lost) {
            const out: Out[] = [];
            await this.db.transaction((tx) => this.hold(tx, step.id, { kind: lost ? "resume" : "start" }, out));
            this.publish(out);
          }
          continue;
        }
        if (!step.startDeliveredAt) {
          // Queued again after its root was paused: it goes when handed a slot (`handOver`).
          if (!holdsSlot(step)) continue;
          if (await this.refusedForScope(step)) continue;
          this.launch(step.harness!, step.start!, step);
          // Chat messages sent before the start ever reached the runner go right after it.
          for (const m of await this.undeliveredMessages(step.id)) this.deliverMessage(sessionId, m);
        } else if (!liveSessions.includes(sessionId)) {
          await this.unconfirm(this.db, step);
          await this.resume(step);
        }
        // Live: what it missed goes now, if it holds a slot; otherwise once it is handed one.
        else if (holdsSlot(step)) await this.flush(step.id, sessionId);
      }
      // Sessions it still runs that no step still going is waiting on are ended: a stop that
      // never reached it, or a run deleted since (with its workflow or its agent). Decided from
      // the steps as they are now, not from the rows of the finished ones, which may be gone.
      const going = new Set(steps.map(({ step }) => step.sessionId));
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
        if (got === "queued") await this.pushStep(tx, step.id, out);
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
    const unsent = await this.undeliveredMessages(step.id);
    const { prompt, answers, messages: carried, laterAnswers, laterMessages } = resumePrompt(
      step.cliSessionId ? null : step.start!.prompt,
      answered,
      unsent,
      waiting,
    );
    // A Job's memory is read again: the resumed session gets it as it is now.
    const [run] = await this.db.select().from(runs).where(eq(runs.id, step.runId));
    const systemPrompt = run?.snapshot ? await this.jobSystemPrompt(run, run.snapshot.systemPrompt) : step.start!.systemPrompt;
    let start: StartParams;
    if (step.cliSessionId) start = { ...step.start!, systemPrompt, prompt, resumeCliSessionId: step.cliSessionId };
    else {
      // Nothing to resume (the CLI never reported its session): start afresh, in a new folder,
      // since the runner may have created the first one before it stopped.
      const runKey = `${step.runId}-${step.id}-${Date.now().toString(36)}`;
      await this.db.update(stepRuns).set({ start: { ...step.start!, runKey } }).where(eq(stepRuns.id, step.id));
      start = { ...step.start!, runKey, systemPrompt, prompt };
    }
    // What the prompt carries is held, so no separate delivery sends it too.
    const held = [...answers.map((q) => `q:${q.id}`), ...carried.map((m) => `m:${m.id}`)];
    // Its run may have been stopped since the step was read: a stopped run never starts again.
    // Read right before the launch, so a stop is either seen here or sent after this start.
    const [now] = await this.db.select({ status: stepRuns.status }).from(stepRuns).where(eq(stepRuns.id, step.id));
    if (!now || !ACTIVE_STEP.includes(now.status)) return;
    if (await this.refusedForScope(step)) return;
    await this.auditResume(step);
    this.launch(step.harness!, start, step, held, async () => {
      const now = new Date();
      if (answers.length) await this.db.update(questions).set({ deliveredAt: now }).where(inArray(questions.id, answers.map((q) => q.id)));
      if (carried.length) await this.db.update(messages).set({ deliveredAt: now }).where(inArray(messages.id, carried.map((m) => m.id)));
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
    for (const m of laterMessages) this.deliverMessage(sessionId, m);
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
  private async unconfirm(tx: Tx | Db, step: StepRow) {
    // A write under way went to the lost session: it won't mark its row delivered.
    this.losses.set(step.sessionId!, (this.losses.get(step.sessionId!) ?? 0) + 1);
    const since = step.startDeliveredAt ?? new Date(0);
    await tx
      .update(messages)
      .set({ deliveredAt: null })
      .where(and(eq(messages.stepRunId, step.id), eq(messages.role, "user"), gte(messages.deliveredAt, since)));
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

  private undeliveredMessages(stepRunId: string) {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.stepRunId, stepRunId), eq(messages.role, "user"), isNull(messages.deliveredAt)))
      .orderBy(asc(messages.position));
  }

  /**
   * Applies one new event inside its transaction. "advance": a step completed (the run may go
   * on); "resume": the runner doesn't have the session (it lost it), so it starts again.
   */
  private async apply(tx: Tx, step: StepRow, event: HarnessEvent, out: Out[]): Promise<"advance" | "resume" | null> {
    // A closed step keeps its transcript and questions as they were.
    if (!OPEN_STEP.includes(step.status)) return null;
    switch (event.type) {
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
        // A call of one of the Job's exposed tools is asked under a short name: say which tool and action it is.
        const [asking] =
          event.payload.kind === "permission"
            ? await tx.select({ id: runs.id, ownerId: runs.ownerId, agentId: runs.agentId }).from(runs).where(eq(runs.id, step.runId))
            : [];
        const about = asking?.agentId && event.payload.kind === "permission" ? await aboutExposed(tx as unknown as Db, { runId: asking.id, ownerId: asking.ownerId, agentId: asking.agentId }, event.payload.toolName) : null;
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
            about,
            payload: event.payload,
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
            counts.counter("dispand.consults.asked").add(1);
            await this.openConsult(tx, row, out);
          }
        }
        await this.syncWaiting(tx, step.id, step.runId, out);
        return null;
      }
      case "turn-end": {
        // A chat between turns waits for the owner's next message: it holds no slot meanwhile. A
        // message sent before this was applied (the last of the transcript) started its next turn
        // on the slot it holds: that turn's end gives it back.
        if (!step.start?.interactive || !step.working) return null;
        const [last] = await tx.select({ role: messages.role }).from(messages).where(eq(messages.stepRunId, step.id)).orderBy(desc(messages.position)).limit(1);
        // A message held by a paused root (`hold`) started no turn: the slot goes back too.
        if (last?.role !== "user" || !(await rootGoing(tx, step.runId))) await this.release(tx, step, out);
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
          await this.fail(tx, step, "the agent finished without its outputs", out);
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
          await this.unconfirm(tx, step);
          return "resume";
        }
        await this.fail(tx, step, event.message, out);
        return null;
    }
  }

  /** Applies `nextActions` (starts, completes, skips, fails, loop iterations, finish) until nothing changes. */
  private async advance(runId: string): Promise<void> {
    for (;;) {
      const [run] = await this.db.select().from(runs).where(eq(runs.id, runId));
      if (!run || !ACTIVE_RUN.includes(run.status)) return;
      const def = await this.defOf(run);
      const steps = await this.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
      const nodes = new Map(nodesOf(def).map((n) => [n.id, n]));
      let changed = false;
      const scheduledFor = run.trigger.type === "schedule" ? new Date(run.trigger.scheduledFor) : run.createdAt;
      const outputs = run.trigger.type === "event" || run.trigger.type === "poll" || run.trigger.type === "consult" ? run.trigger.outputs : undefined;
      for (const action of nextActions(def, steps, { scheduledFor, ...(outputs ? { outputs } : {}) })) {
        const out: Out[] = [];
        if (action.type === "finish") {
          await this.db.transaction((tx) => this.finishRun(tx, runId, action.status, null, out));
          this.publish(out);
          return;
        }
        if (action.type === "open-iteration") {
          changed = (await this.openIteration(run, def, action.loopId, action.iteration, out)) || changed;
          this.publish(out);
          continue;
        }
        const step = steps.find((s) => s.nodeId === action.nodeId && s.iteration === action.iteration)!;
        if (action.type === "complete") changed = (await this.db.transaction((tx) => this.complete(tx, step, action.outputs, out))) || changed;
        else if (action.type === "skip") changed = (await this.skip(step, out)) || changed;
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
        } else if (nodes.get(action.nodeId)!.type === "loop") changed = (await this.startLoop(step, out)) || changed;
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
        return { ok: false as const, error: "The tool call failed" };
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
    const def = await this.defOf(run);
    const running = await this.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, "running")));
    for (const step of running) {
      if (def.steps.find((s) => s.id === step.nodeId)?.type !== "tool" || this.inFlight.has(`tool:${step.id}`)) continue;
      const out: Out[] = [];
      await this.db.transaction((tx) => this.fail(tx, step, TOOL_RESTARTED, out));
      this.publish(out);
    }
  }

  /** A loop runs in the engine, without a session: it stays running while its iterations do. */
  private async startLoop(step: StepRow, out: Out[]): Promise<boolean> {
    const [row] = await this.db
      .update(stepRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
      .returning();
    if (row) out.push({ type: "step", step: stepView(row) });
    return !!row;
  }

  /** One pending row per body step of the loop, for `iteration` (once: a retried advance adds none). */
  private async openIteration(run: RunRow, def: WorkflowDef, loopId: string, iteration: number, out: Out[]): Promise<boolean> {
    const body = def.steps.filter((s) => s.loopId === loopId);
    const harnessOf = await agentHarnesses(this.db, run.ownerId, body);
    const rows = await this.db
      .insert(stepRuns)
      .values(body.map((s) => ({ id: newId("step"), ownerId: run.ownerId, runId: run.id, nodeId: s.id, iteration, harnessId: harnessOf(s), status: "pending" as const })))
      .onConflictDoNothing()
      .returning();
    for (const row of rows) out.push({ type: "step", step: stepView(row) });
    return rows.length > 0;
  }

  /** A step on a branch the run didn't take: it never runs. */
  private async skip(step: StepRow, out: Out[]): Promise<boolean> {
    const [row] = await this.db
      .update(stepRuns)
      .set({ status: "skipped", finishedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
      .returning();
    if (row) out.push({ type: "step", step: stepView(row) });
    return !!row;
  }

  /** A Job's system prompt at a session start: its agent's, as snapshotted, then its memory as it is now. */
  private async jobSystemPrompt(run: RunRow, systemPrompt: string): Promise<string> {
    const memory = await jobMemoryPrompt(this.db, run);
    return memory ? [systemPrompt, memory].filter(Boolean).join("\n\n") : systemPrompt;
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
    return run.source === "agent" ? withJob(run.id, traced) : traced();
  }

  private async openSession(run: RunRow, def: WorkflowDef, steps: StepRow[], node: WorkflowNode, step: StepRow) {
    // Queued: it starts when it is handed a slot (`slots.ts`), not before.
    if (step.queuedAt) return;
    // A Job runs the agent as it was when the Job was created; a workflow run, as it is now.
    const [stored] = run.snapshot
      ? []
      : await this.db
          .select({ systemPrompt: agents.systemPrompt, model: agents.model, harnessId: agents.harnessId })
          .from(agents)
          .where(and(eq(agents.id, node.agentId ?? ""), eq(agents.ownerId, run.ownerId)));
    // A Job of a deleted agent never runs again: its step fails as one whose agent is gone.
    const agent = run.source === "agent" && !run.agentId ? undefined : run.snapshot ? { ...run.snapshot, model: run.snapshot.model ?? null } : stored;
    // The agent's harness as read here takes the slot and runs the session; a step handed a slot
    // keeps the harness it queued on, wherever its agent went since.
    const harnessId = step.working && step.harnessId ? step.harnessId : agent?.harnessId;
    const [h] = harnessId
      ? await this.db
          .select()
          .from(harnesses)
          .where(and(eq(harnesses.id, harnessId), eq(harnesses.ownerId, run.ownerId)))
      : [];
    if (!agent || !h) {
      const out: Out[] = [];
      await this.db.transaction((tx) => this.fail(tx, step, "The step's agent no longer exists", out));
      this.publish(out);
      return;
    }
    const model = agent.model ?? h.model;
    let harness: Harness;
    let runnerRow: RunnerRow | undefined;
    if (h.type === "cloud") {
      // The harness's settings and key are read at each model call: only the agent's model is kept.
      harness = { id: h.id, type: "cloud", kind: h.kind as CloudKind, ...(agent.model ? { model: agent.model } : {}) };
    } else {
      // A revoked runner never comes back: the step would wait forever.
      const [runner] = h.runnerId ? await this.db.select().from(runners).where(eq(runners.id, h.runnerId)) : [];
      runnerRow = runner;
      const problem = !runner || runner.revokedAt || !h.permissionMode ? "The agent's runner was revoked" : cliProblem(h.kind, runner);
      if (problem) {
        const out: Out[] = [];
        await this.db.transaction((tx) => this.fail(tx, step, problem, out));
        this.publish(out);
        return;
      }
      harness = {
        id: h.id,
        runnerId: h.runnerId!,
        kind: h.kind,
        permissionMode: h.permissionMode,
        ...(model ? { model } : {}),
      } as CliHarness;
    }
    const values = valuesFor(def, steps, node.id, step.iteration);
    const start: StartParams = {
      sessionId: newId("ses"),
      // One folder per session: the run and the step (a resume reuses its own).
      runKey: `${run.id}-${step.id}`,
      // A Job's memory is read now, at each start, after its agent's instructions.
      systemPrompt: run.snapshot ? await this.jobSystemPrompt(run, agent.systemPrompt) : agent.systemPrompt,
      prompt: renderTemplate(node.prompt ?? "", values),
      expectedOutputs:
        deriveExpectedOutputs(def, await loadTableSchemas(this.db, run.ownerId, tableIdsOf(def)), await loadToolSchemas(this.db, run.ownerId, toolIdsOf(def)))[node.id] ?? [],
      interactive: node.kind === "trigger",
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
    this.launch(harness, start, started, [], start.interactive ? () => this.flush(started.id, start.sessionId) : undefined);
  }

  /**
   * Hands a session start to the harness without waiting for it to arrive. Once written, the
   * step records it (and `written` runs); unwritten, the runner's next reconcile sends it again.
   */
  private launch(harness: Harness, start: StartParams, step: StepRow, held: string[] = [], written?: () => Promise<void>) {
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
      const out: Out[] = [];
      await this.db.transaction((tx) => this.fail(tx, step, "The session could not start", out));
      this.publish(out);
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
    const problem = await this.lostScope(step.runId);
    if (!problem) return false;
    const out: Out[] = [];
    await this.db.transaction((tx) => this.fail(tx, step, problem, out));
    this.publish(out);
    return true;
  }

  /** Why the run, a Job fired by a row's change, a Question or a poll's item, may no longer be told of it; null when it may. */
  private async lostScope(runId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ ownerId: runs.ownerId, agentId: runs.agentId, trigger: runs.trigger, bundles: agents.bundles, dataTables: agents.dataTables })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(eq(runs.id, runId));
    if (row?.trigger.type === "poll") {
      const { toolId, action } = row.trigger;
      return row.agentId && !(await pollProblem(this.db, row.ownerId, row.agentId, toolId, action)) ? null : "The agent may no longer read the tool's action that found this item";
    }
    if (row?.trigger.type !== "event") return null;
    const tableId = row.trigger.outputs.table_id ?? "";
    // A Question or an Approval: still one its Job may read, with the Job's rights as they are now (and, once asked, still open).
    if (tableId === INTERACTION) {
      const scope = row.agentId ? await jobScope(this.db, { runId, ownerId: row.ownerId, agentId: row.agentId }) : null;
      return scope && (await startable(this.db, scope, row.trigger.outputs.row_id ?? "", row.trigger.outputs.operation ?? "")) ? null : "The agent may no longer read this Question";
    }
    return !row.bundles?.includes("data") || (row.dataTables !== "all" && !row.dataTables?.includes(tableId)) ? "The agent may no longer read the table that changed" : null;
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

  private deliverMessage(sessionId: string, m: MessageRow) {
    if (this.reconciling > 0) {
      this.deferred.push(() => this.keep(this.redeliverMessage(m.id)));
      return;
    }
    const losses = this.losses.get(sessionId) ?? 0;
    const sent = this.track(`m:${m.id}`, async () => {
      if ((await this.adapter.send(sessionId, m.text)) && (this.losses.get(sessionId) ?? 0) === losses) {
        await this.db.update(messages).set({ deliveredAt: new Date() }).where(eq(messages.id, m.id));
      }
    }).catch((err: unknown) => logError("chat message delivery failed", err, { ref: m.id }));
    this.keep(sent);
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
    if (row && !row.m.deliveredAt && row.step.sessionId && holdsSlot(row.step)) this.deliverMessage(row.step.sessionId, row.m);
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
      .set({ status: "succeeded", outputs, finishedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), inArray(stepRuns.status, OPEN_STEP)))
      .returning();
    if (!row) return false;
    out.push({ type: "step", step: stepView(row) });
    await this.release(tx, row, out);
    // A checkpoint's Approval asked in a chat is the root's, not the step's: it stays.
    await this.expire(tx, eq(questions.stepRunId, step.id), out);
    await this.syncWaiting(tx, step.id, step.runId, out);
    return true;
  }

  /** Fails the step and its run; the run's pending questions expire. */
  private async fail(tx: Tx, step: StepRow, error: string, out: Out[], stop?: StopReason) {
    const [row] = await tx
      .update(stepRuns)
      .set({ status: "failed", error, finishedAt: new Date() })
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
      const loopId = run && loopOf(await this.defOf(run, tx), step.nodeId);
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
    for (const s of waiting) await this.release(tx, s, out);
    // Last, once its run is over: none of the run's steps is handed the slot.
    await this.release(tx, row, out);
  }

  /** A step that held a slot gives it back, or leaves the queue; the steps handed the slot go on once `tx` commits (`handOver`). */
  private async release(tx: Tx, step: StepRow, out: Out[]) {
    if (!step.working && !step.queuedAt) return;
    const handed = await give(tx, step.id);
    if (handed.length === 0) return;
    const rows = await tx.select({ id: stepRuns.id, runId: stepRuns.runId }).from(stepRuns).where(inArray(stepRuns.id, handed));
    for (const r of rows) out.push({ type: "slot", runId: r.runId, stepId: r.id });
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
      out.push({ type: "run", run: runView(row) });
      const attributes = { "dispand.run.source": row.source, "dispand.run.status": status };
      counts.counter("dispand.runs.finished").add(1, attributes);
      counts.histogram("dispand.run.duration", { unit: "ms", description: "From a run's creation to its end" }).record(row.finishedAt!.getTime() - row.createdAt.getTime(), attributes);
      if (row.source === "agent") {
        await recordAudit(tx, {
          ownerId: row.ownerId,
          actor: { type: "job", runId: row.id },
          agentId: row.agentId,
          jobId: row.id,
          action: status === "succeeded" ? "job.finished" : "job.failed",
          resource: { type: "job", id: row.id },
          result: status === "succeeded" ? "ok" : "failed",
          ...(status === "failed" ? { details: { reason: stop ?? (error === STOPPED ? "stopped" : "failed") } } : {}),
        });
      }
      await this.answerConsult(tx, row, out);
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
      if (held) await this.release(tx, held, out);
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

  /** A Job carries its own definition; a workflow run reads the version it started on. */
  private async defOf(
    run: Pick<typeof runs.$inferSelect, "workflowId" | "version" | "def">,
    db: Tx | Db = this.db,
  ): Promise<WorkflowDef> {
    if (run.def) return run.def;
    const [row] = run.workflowId
      ? await db
          .select({ def: workflowVersions.def })
          .from(workflowVersions)
          .where(and(eq(workflowVersions.workflowId, run.workflowId), eq(workflowVersions.version, run.version)))
      : [];
    if (!row) throw new EngineError("NOT_FOUND", "Workflow version not found");
    return row.def;
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
