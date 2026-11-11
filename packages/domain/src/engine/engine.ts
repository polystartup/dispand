import { EventPublisher } from "@orpc/server";
import {
  type Answer,
  type HarnessEvent,
  type QuestionPayload,
  SESSION_ALREADY_RUNNING,
  SESSION_NOT_RUNNING,
  SessionStart,
  storable,
  TEXT,
} from "@dispand/runner-protocol";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import {
  agents,
  harnesses,
  runners,
  messages,
  questions,
  runs,
  stepRuns,
  triggers,
  workflows,
  workflowVersions,
  type AgentSnapshot,
  type AnsweredBy,
  type JobCause,
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
import { CLOUD_SOURCE, type CliHarness, type Harness, type HarnessAdapter, isCloud, type StartParams } from "./harness.ts";
import { runDataStep } from "./data-step.ts";
import { aboutExposed, isExposedName, stopAsking } from "../platform/exposed.ts";
import { annotate, currentTraceId, meter, recordError, tracer, withJob } from "../telemetry/index.ts";
import { REQUEST_APPROVAL } from "../cloud/builtins.ts";
import { attachProposal, settleProposal } from "../platform/proposals.ts";
import { issueJobToken } from "../platform/token.ts";
import type { SecretBox } from "../secrets.ts";
import { jobDef } from "./job-def.ts";
import { nextActions, outputsFor, toolValues, valuesFor } from "./next-actions.ts";
import { skillsAndTools } from "../agents/skills-and-tools.ts";

type RunRow = typeof runs.$inferSelect;
type StepRow = typeof stepRuns.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type QuestionRow = typeof questions.$inferSelect;
type RunnerRow = typeof runners.$inferSelect;

/** How many Jobs deep a chain of Jobs causing Jobs may go. */
const MAX_CHAIN_DEPTH = 10;
/** The most Jobs one chain makes, from its first Job (`cause.rootJobId`). */
const MAX_CHAIN_JOBS = 100;
export const CHAIN_LIMIT = "Chain limit reached";

const traces = tracer("engine");
const counts = meter("engine");

const ACTIVE_RUN: RunStatus[] = ["running", "waiting"];
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
  return { id, source, workflowId, version, agentId, triggerId, status, trigger, error, createdAt, finishedAt };
}
export function stepView(s: StepRow) {
  const { id, runId, nodeId, iteration, status, outputs, error, startedAt, finishedAt } = s;
  // prompt: as the step got it, values filled in (for the owner to debug a run); null until started.
  return { id, runId, nodeId, iteration, status, outputs, error, startedAt, finishedAt, interactive: s.start?.interactive ?? false, prompt: s.start?.prompt ?? null };
}
export function messageView(m: MessageRow) {
  const { id, runId, stepRunId, role, text, createdAt } = m;
  return { id, runId, stepRunId, role, text, createdAt };
}
export function questionView(q: QuestionRow) {
  const { id, runId, stepRunId, placement, payload, status, answer, createdAt, about, proposalId } = q;
  return { id, runId, stepRunId, placement, payload, status, answer, createdAt, about, proposalId };
}

/** What `runs.stream` forwards: each carries the whole row as it is now (upserts by id). */
export type RunEvent =
  | { type: "run"; run: ReturnType<typeof runView> }
  | { type: "step"; step: ReturnType<typeof stepView> }
  | { type: "message"; message: ReturnType<typeof messageView> }
  | { type: "question"; question: ReturnType<typeof questionView> };

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

/** An answer in words, for a session that can only get it as a message. */
/** The words of an approval asked with `request_approval`; null for any other question. */
function approvalWords(payload: QuestionPayload): string | null {
  if (payload.kind !== "permission" || payload.toolName !== "request_approval") return null;
  const message = (payload.input as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : null;
}

export function answerText(q: Pick<QuestionRow, "payload" | "answer">): string {
  const a = q.answer!;
  if (a.kind === "choice") {
    const parts = Object.entries(a.answers).map(([question, answer]) => `“${question}”: ${Array.isArray(answer) ? answer.join(", ") : answer}`);
    return `The owner answered: ${parts.join("; ")}.`;
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
  const parts = [original ?? RESUME_PROMPT];
  let length = parts[0]!.length;
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

/** What keeps `def` from running: its own issues, its data steps' against the owner's tables and its Tool steps' against the owner's tools. */
export async function runIssues(db: Db | Tx, ownerId: string, def: WorkflowDef): Promise<WorkflowIssue[]> {
  return [
    ...validateWorkflow(def),
    ...validateDataSteps(def, await loadTableSchemas(db, ownerId, tableIdsOf(def))),
    ...validateToolSteps(def, await loadToolSchemas(db, ownerId, toolIdsOf(def))),
  ];
}

export class EngineError extends Error {
  override name = "EngineError";
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "CLOSED" | "NOT_PENDING",
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

  constructor(
    readonly db: Db,
    private readonly adapter: HarnessAdapter,
    /** Sessions run in this process (`CloudRunner`), reconciled on `recover()` under `CLOUD_SOURCE`. */
    private readonly cloud?: { recover(): Promise<string[]> },
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
    await tx.insert(stepRuns).values(top.map((n) => ({ id: newId("step"), ownerId: workflow.ownerId, runId, nodeId: n.id, status: "pending" as const })));
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
    await this.continueRun(runId);
    return runId;
  }

  /**
   * Inserts a Job (a run of the agent, for one firing of its trigger) and its steps, in `tx`,
   * without starting anything, like `createRun`. The Job keeps the agent and the trigger as
   * they are now: later edits don't change it.
   */
  async createJob(
    tx: Tx,
    input: { ownerId: string; agentId: string; triggerId: string; cause: JobCause; firing: RunTrigger },
  ): Promise<string> {
    const { ownerId, agentId, triggerId, cause, firing } = input;
    if (cause.depth > MAX_CHAIN_DEPTH) throw new EngineError("INVALID", CHAIN_LIMIT);
    if (cause.kind === "event" && cause.rootJobId) {
      // The root held while counting: two Jobs of one chain made at once wait for each other.
      await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, cause.rootJobId)).for("no key update");
      const [chain] = await tx
        .select({ jobs: count() })
        .from(runs)
        .where(and(eq(runs.ownerId, ownerId), or(eq(runs.id, cause.rootJobId), sql`${runs.cause}->>'rootJobId' = ${cause.rootJobId}`)));
      if (chain!.jobs >= MAX_CHAIN_JOBS) throw new EngineError("INVALID", CHAIN_LIMIT);
    }
    // Shared with other starts, exclusive with a delete: the Job never outlives its agent. The
    // trigger first, then the agent: the order the scheduler and a delete take them in
    // (`jobs/active.ts`), so none of them waits on another.
    const [trigger] = await tx
      .select()
      .from(triggers)
      .where(and(eq(triggers.id, triggerId), eq(triggers.agentId, agentId), eq(triggers.ownerId, ownerId)))
      .for("share");
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
      .for("share");
    if (!agent) throw new EngineError("NOT_FOUND", "Agent not found");
    if (!trigger || !trigger.enabled) throw new EngineError("NOT_FOUND", "Trigger not found");
    const { skills, tools } = await skillsAndTools(tx, agentId);
    const snapshot: AgentSnapshot = {
      id: agent.id,
      name: agent.name,
      harnessId: agent.harnessId,
      systemPrompt: agent.systemPrompt,
      ...(agent.model ? { model: agent.model } : {}),
      skills,
      tools: tools.map(({ toolId, name }) => ({ toolId, name })),
      bundles: agent.bundles,
      tables: agent.dataTables,
    };
    const def = jobDef({ agent: snapshot, trigger });
    const runId = newId("run");
    const token = this.secrets ? issueJobToken(this.secrets, runId) : undefined;
    await tx.insert(runs).values({
      id: runId,
      ownerId,
      source: "agent",
      ...(token ? { tokenHash: token.hash, tokenSealed: token.sealed } : {}),
      version: 0,
      agentId,
      triggerId,
      def,
      snapshot,
      cause,
      status: "running",
      trigger: firing,
      traceId: currentTraceId() ?? null,
    });
    counts.counter("dispand.runs.created").add(1, { "dispand.run.source": "agent", "dispand.run.trigger": firing.type });
    await tx.insert(stepRuns).values(nodesOf(def).map((n) => ({ id: newId("step"), ownerId, runId, nodeId: n.id, status: "pending" as const })));
    return runId;
  }

  /**
   * Stops a run by hand: every step still open fails with `STOPPED` (a step that never started
   * too, so nothing of the run is left open), its pending questions expire, the run fails, and
   * its sessions are told to end. A stop that doesn't reach a runner is sent again when the
   * runner is back with the session (`reconcile`).
   */
  async stopRun(runId: string): Promise<void> {
    const out: RunEvent[] = [];
    const sessions = await this.db.transaction(async (tx) => {
      const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).for("update");
      if (!run) throw new EngineError("NOT_FOUND", "Run not found");
      if (!ACTIVE_RUN.includes(run.status)) throw new EngineError("CLOSED", "This run is over");
      const open = await tx
        .select()
        .from(stepRuns)
        .where(and(eq(stepRuns.runId, runId), inArray(stepRuns.status, OPEN_STEP)));
      for (const step of open) await this.fail(tx, step, STOPPED, out);
      // A run with no step open (between two steps) is closed here.
      await this.finishRun(tx, runId, "failed", STOPPED, out);
      return open;
    });
    this.publish(runId, out);
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
      .where(and(eq(stepRuns.runId, runId), inArray(stepRuns.status, ACTIVE_STEP)));
    const chat = steps.find((s) => s.start?.interactive && s.sessionId);
    if (!chat) throw new EngineError("CLOSED", "The chat is over");
    const [row] = await this.db
      .insert(messages)
      .values({ id: newId("msg"), ownerId: chat.ownerId, runId, stepRunId: chat.id, role: "user", text })
      .returning();
    this.publish(runId, [{ type: "message", message: messageView(row!) }]);
    this.deliverMessage(chat.sessionId!, row!);
  }

  /** Records the owner's answer (once) and sends it to the session. */
  async answer(questionId: string, answer: Answer, by?: AnsweredBy): Promise<void> {
    // Any answer may have to go as words (its session lost and resumed): those must fit a message.
    const [asked] = await this.db.select({ payload: questions.payload }).from(questions).where(eq(questions.id, questionId));
    if (asked) {
      const words = answerText({ payload: asked.payload, answer });
      if (words.length > TEXT || !storable(words)) throw new EngineError("INVALID", `The answer is too long (at most about ${TEXT - 100} characters)`);
    }
    const out: RunEvent[] = [];
    const q = await this.db.transaction(async (tx) => {
      const [q] = await tx
        .update(questions)
        .set({ status: "answered", answer, answeredAt: new Date(), answeredBy: by ?? null })
        .where(and(eq(questions.id, questionId), eq(questions.status, "pending")))
        .returning();
      if (!q) return null;
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
      out.push({ type: "question", question: questionView(q) });
      await this.syncWaiting(tx, q.stepRunId, q.runId, out);
      return q;
    });
    if (!q) throw new EngineError("NOT_PENDING", "This question is no longer waiting for an answer");
    const decision = q.answer?.kind === "permission" ? q.answer.decision : q.answer?.kind ?? "none";
    counts.counter("dispand.questions.answered").add(1, { "dispand.question.kind": q.kind, "dispand.answer.decision": decision });
    counts.histogram("dispand.question.wait", { unit: "ms", description: "From a question to its answer" }).record(q.answeredAt!.getTime() - q.createdAt.getTime(), { "dispand.question.kind": q.kind });
    this.publish(q.runId, out);
    this.deliverAnswer(q);
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
    const out: RunEvent[] = [];
    const result = await this.db.transaction(async (tx) => {
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
    this.publish(result.step.runId, out);
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
      const out: RunEvent[] = [];
      await this.db.transaction((tx) => this.fail(tx, step, "The agent's runner was revoked", out));
      this.publish(step.runId, out);
    }
  }

  /**
   * On boot: active runs continue (steps whose predecessors are done start). A Tool step left
   * running was calling its tool when Dispand stopped: it fails, and is never called again.
   * Sessions are reconciled per runner.
   */
  async recover(): Promise<void> {
    const active = await this.db.select({ id: runs.id }).from(runs).where(inArray(runs.status, ACTIVE_RUN));
    for (const { id } of active) {
      await this.failInterruptedTools(id);
      await this.advance(id);
    }
    if (this.cloud) await this.reconcile(CLOUD_SOURCE, await this.cloud.recover());
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
        if (!step.startDeliveredAt) {
          this.launch(step.harness!, step.start!, step);
          // Chat messages sent before the start ever reached the runner go right after it.
          for (const m of await this.undeliveredMessages(step.id)) this.deliverMessage(sessionId, m);
        } else if (!liveSessions.includes(sessionId)) {
          await this.unconfirm(this.db, step);
          await this.resume(step);
        }
        else {
          for (const q of await this.undeliveredAnswers(sessionId)) this.deliverAnswer(q);
          for (const m of await this.undeliveredMessages(step.id)) this.deliverMessage(sessionId, m);
        }
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
    const out: RunEvent[] = [];
    const waiting = await this.db
      .update(questions)
      .set({ orphaned: true })
      .where(and(eq(questions.sessionId, sessionId), eq(questions.status, "pending")))
      .returning();
    for (const q of waiting) out.push({ type: "question", question: questionView(q) });
    this.publish(step.runId, out);
    // Deliveries still under way are carried too (they never mark a lost session's rows delivered).
    const answered = await this.undeliveredAnswers(sessionId);
    const unsent = await this.undeliveredMessages(step.id);
    const { prompt, answers, messages: carried, laterAnswers, laterMessages } = resumePrompt(
      step.cliSessionId ? null : step.start!.prompt,
      answered,
      unsent,
      waiting,
    );
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

  private undeliveredAnswers(sessionId: string) {
    return this.db
      .select()
      .from(questions)
      .where(and(eq(questions.sessionId, sessionId), eq(questions.status, "answered"), isNull(questions.deliveredAt)))
      .orderBy(asc(questions.answeredAt));
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
  private async apply(tx: Tx, step: StepRow, event: HarnessEvent, out: RunEvent[]): Promise<"advance" | "resume" | null> {
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
            kind: event.payload.kind === "permission" ? "approval" : "question",
            about,
            payload: event.payload,
            status: "pending",
          })
          .onConflictDoNothing()
          .returning();
        if (row) {
          counts.counter("dispand.questions.opened").add(1, { "dispand.question.kind": row.kind });
          // A request for approval that names a proposal of this run: the question is for that proposal.
          if (event.payload.kind === "permission" && event.payload.toolName === REQUEST_APPROVAL) {
            row.proposalId = await attachProposal(tx as unknown as Db, { runId: step.runId, ownerId: step.ownerId }, row.id, event.payload.input);
            if (row.proposalId) await tx.update(questions).set({ proposalId: row.proposalId }).where(eq(questions.id, row.id));
          }
          out.push({ type: "question", question: questionView(row) });
          // The resumed session asks for itself now: questions of the session it replaced expire.
          const expired = await tx
            .update(questions)
            .set({ status: "expired" })
            .where(and(eq(questions.stepRunId, step.id), eq(questions.status, "pending"), eq(questions.orphaned, true)))
            .returning();
          for (const q of expired) out.push({ type: "question", question: questionView(q) });
        }
        await this.syncWaiting(tx, step.id, step.runId, out);
        return null;
      }
      case "turn-end":
        return null;
      case "outputs-accepted":
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
      const outputs = run.trigger.type === "event" ? run.trigger.outputs : undefined;
      for (const action of nextActions(def, steps, { scheduledFor, ...(outputs ? { outputs } : {}) })) {
        const out: RunEvent[] = [];
        if (action.type === "finish") {
          await this.finishRun(this.db, runId, action.status, null, out);
          this.publish(runId, out);
          return;
        }
        if (action.type === "open-iteration") {
          changed = (await this.openIteration(run, def, action.loopId, action.iteration, out)) || changed;
          this.publish(runId, out);
          continue;
        }
        const step = steps.find((s) => s.nodeId === action.nodeId && s.iteration === action.iteration)!;
        if (action.type === "complete") changed = (await this.complete(this.db, step, action.outputs, out)) || changed;
        else if (action.type === "skip") changed = (await this.skip(step, out)) || changed;
        else if (action.type === "data") {
          const ran = await this.runData(run, def, steps, step, out);
          this.publish(runId, out);
          if (ran === "failed") return;
          changed = ran === "succeeded" || changed;
          continue;
        }
        else if (action.type === "tool") await this.startTool(run, def, steps, step, out);
        else if (action.type === "fail") {
          // The run fails with the step: nothing else of it starts.
          await this.db.transaction((tx) => this.fail(tx, step, action.error, out));
          this.publish(runId, out);
          return;
        } else if (nodes.get(action.nodeId)!.type === "loop") changed = (await this.startLoop(step, out)) || changed;
        else await this.startSession(run, def, steps, nodes.get(action.nodeId)!, step);
        this.publish(runId, out);
      }
      if (!changed) return;
    }
  }

  /**
   * Runs a ready data step in one transaction: claimed (pending → running, so a retried or
   * concurrent advance finds nothing to do), run, then completed or failed with the run. The rows
   * it wrote are published once that commits. Nothing to claim: null.
   */
  private async runData(run: RunRow, def: WorkflowDef, steps: StepRow[], step: StepRow, out: RunEvent[]): Promise<"succeeded" | "failed" | null> {
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
  private async startTool(run: RunRow, def: WorkflowDef, steps: StepRow[], step: StepRow, out: RunEvent[]) {
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
      const settled: RunEvent[] = [];
      await this.db.transaction(async (tx) => {
        if (result.ok) await this.complete(tx, claimed, result.outputs, settled);
        else await this.fail(tx, claimed, result.error, settled);
      });
      this.publish(run.id, settled);
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
      const out: RunEvent[] = [];
      await this.db.transaction((tx) => this.fail(tx, step, TOOL_RESTARTED, out));
      this.publish(runId, out);
    }
  }

  /** A loop runs in the engine, without a session: it stays running while its iterations do. */
  private async startLoop(step: StepRow, out: RunEvent[]): Promise<boolean> {
    const [row] = await this.db
      .update(stepRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
      .returning();
    if (row) out.push({ type: "step", step: stepView(row) });
    return !!row;
  }

  /** One pending row per body step of the loop, for `iteration` (once: a retried advance adds none). */
  private async openIteration(run: RunRow, def: WorkflowDef, loopId: string, iteration: number, out: RunEvent[]): Promise<boolean> {
    const body = def.steps.filter((s) => s.loopId === loopId);
    const rows = await this.db
      .insert(stepRuns)
      .values(body.map((s) => ({ id: newId("step"), ownerId: run.ownerId, runId: run.id, nodeId: s.id, iteration, status: "pending" as const })))
      .onConflictDoNothing()
      .returning();
    for (const row of rows) out.push({ type: "step", step: stepView(row) });
    return rows.length > 0;
  }

  /** A step on a branch the run didn't take: it never runs. */
  private async skip(step: StepRow, out: RunEvent[]): Promise<boolean> {
    const [row] = await this.db
      .update(stepRuns)
      .set({ status: "skipped", finishedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
      .returning();
    if (row) out.push({ type: "step", step: stepView(row) });
    return !!row;
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
    // A Job runs the agent as it was when the Job was created; a workflow run, as it is now.
    const [stored] = run.snapshot
      ? []
      : await this.db
          .select({ systemPrompt: agents.systemPrompt, model: agents.model, harnessId: agents.harnessId })
          .from(agents)
          .where(and(eq(agents.id, node.agentId ?? ""), eq(agents.ownerId, run.ownerId)));
    const agent = run.snapshot ? { ...run.snapshot, model: run.snapshot.model ?? null } : stored;
    const [h] = agent
      ? await this.db
          .select()
          .from(harnesses)
          .where(and(eq(harnesses.id, agent.harnessId), eq(harnesses.ownerId, run.ownerId)))
      : [];
    if (!agent || !h) {
      const out: RunEvent[] = [];
      await this.db.transaction((tx) => this.fail(tx, step, "The step's agent no longer exists", out));
      this.publish(run.id, out);
      return;
    }
    const model = agent.model ?? h.model;
    let harness: Harness;
    if (h.type === "cloud") {
      // The harness's settings and key are read at each model call: only the agent's model is kept.
      harness = { id: h.id, type: "cloud", kind: h.kind as CloudKind, ...(agent.model ? { model: agent.model } : {}) };
    } else {
      // A revoked runner never comes back: the step would wait forever.
      const [runner] = h.runnerId ? await this.db.select().from(runners).where(eq(runners.id, h.runnerId)) : [];
      const problem = !runner || runner.revokedAt || !h.permissionMode ? "The agent's runner was revoked" : cliProblem(h.kind, runner);
      if (problem) {
        const out: RunEvent[] = [];
        await this.db.transaction((tx) => this.fail(tx, step, problem, out));
        this.publish(run.id, out);
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
      systemPrompt: agent.systemPrompt,
      prompt: renderTemplate(node.prompt ?? "", values),
      expectedOutputs:
        deriveExpectedOutputs(def, await loadTableSchemas(this.db, run.ownerId, tableIdsOf(def)), await loadToolSchemas(this.db, run.ownerId, toolIdsOf(def)))[node.id] ?? [],
      interactive: node.kind === "trigger",
    };
    const [started] = await this.db
      .update(stepRuns)
      .set({ status: "running", sessionId: start.sessionId, harness, runnerId: isCloud(harness) ? CLOUD_SOURCE : harness.runnerId, start, startedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
      .returning();
    if (!started) return;
    annotate({ "dispand.harness.kind": harness.kind, "dispand.session.id": start.sessionId });
    this.publish(run.id, [{ type: "step", step: stepView(started) }]);
    this.launch(harness, start, started);
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
      const out: RunEvent[] = [];
      const failed = this.db
        .transaction((tx) => this.fail(tx, step, problem, out))
        .then(() => this.publish(step.runId, out))
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
      const out: RunEvent[] = [];
      await this.db.transaction((tx) => this.fail(tx, step, "The session could not start", out));
      this.publish(step.runId, out);
    });
    this.keep(sent);
  }

  /** An answer reaches the session as an answer, or, for a question its lost session asked, as a message. */
  private deliverAnswer(q: QuestionRow) {
    // A reconcile may be resuming this session: deliver once it is done, against the row as it left it.
    if (this.reconciling > 0) {
      this.deferred.push(() => this.keep(this.redeliverAnswer(q.id)));
      return;
    }
    const losses = this.losses.get(q.sessionId) ?? 0;
    const sent = this.track(`q:${q.id}`, async () => {
      const ok = q.orphaned
        ? await this.adapter.send(q.sessionId, answerText(q))
        : await this.adapter.answer(q.sessionId, q.runnerQuestionId, q.answer!);
      if (ok && (this.losses.get(q.sessionId) ?? 0) === losses) await this.db.update(questions).set({ deliveredAt: new Date() }).where(eq(questions.id, q.id));
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
    const [q] = await this.db.select().from(questions).where(eq(questions.id, id));
    if (q?.status === "answered" && !q.deliveredAt) this.deliverAnswer(q);
  }

  private async redeliverMessage(id: string) {
    const [row] = await this.db
      .select({ m: messages, sessionId: stepRuns.sessionId })
      .from(messages)
      .innerJoin(stepRuns, eq(stepRuns.id, messages.stepRunId))
      .where(eq(messages.id, id));
    if (row && !row.m.deliveredAt && row.sessionId) this.deliverMessage(row.sessionId, row.m);
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
  private async complete(tx: Tx | Db, step: StepRow, outputs: Record<string, string>, out: RunEvent[]): Promise<boolean> {
    const [row] = await tx
      .update(stepRuns)
      .set({ status: "succeeded", outputs, finishedAt: new Date() })
      .where(and(eq(stepRuns.id, step.id), inArray(stepRuns.status, OPEN_STEP)))
      .returning();
    if (!row) return false;
    out.push({ type: "step", step: stepView(row) });
    const expired = await tx
      .update(questions)
      .set({ status: "expired" })
      .where(and(eq(questions.stepRunId, step.id), eq(questions.status, "pending")))
      .returning();
    for (const q of expired) out.push({ type: "question", question: questionView(q) });
    await this.syncWaiting(tx, step.id, step.runId, out);
    return true;
  }

  /** Fails the step and its run; the run's pending questions expire. */
  private async fail(tx: Tx, step: StepRow, error: string, out: RunEvent[]) {
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
    const expired = await tx
      .update(questions)
      .set({ status: "expired" })
      .where(and(eq(questions.runId, step.runId), eq(questions.status, "pending")))
      .returning();
    for (const q of expired) out.push({ type: "question", question: questionView(q) });
    await this.finishRun(tx, step.runId, "failed", error, out);
  }

  private async finishRun(tx: Tx | Db, runId: string, status: "succeeded" | "failed", error: string | null, out: RunEvent[]) {
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
    }
  }

  /** A step, and its run, wait while one of their questions is pending. */
  private async syncWaiting(tx: Tx | Db, stepId: string, runId: string, out: RunEvent[]) {
    const pending = async (column: typeof questions.stepRunId | typeof questions.runId, id: string) => {
      const [row] = await tx
        .select({ n: count() })
        .from(questions)
        .where(and(eq(column, id), eq(questions.status, "pending")));
      return (row?.n ?? 0) > 0;
    };
    const stepStatus = (await pending(questions.stepRunId, stepId)) ? "waiting" : "running";
    const [step] = await tx
      .update(stepRuns)
      .set({ status: stepStatus })
      .where(and(eq(stepRuns.id, stepId), inArray(stepRuns.status, ACTIVE_STEP), sql`${stepRuns.status} <> ${stepStatus}`))
      .returning();
    if (step) out.push({ type: "step", step: stepView(step) });
    const runStatus = (await pending(questions.runId, runId)) ? "waiting" : "running";
    const [run] = await tx
      .update(runs)
      .set({ status: runStatus })
      .where(and(eq(runs.id, runId), inArray(runs.status, ACTIVE_RUN), sql`${runs.status} <> ${runStatus}`))
      .returning();
    if (run) out.push({ type: "run", run: runView(run) });
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

  private publish(runId: string, out: RunEvent[]) {
    for (const e of out) this.events.publish(runId, e);
    if (out.some((e) => e.type === "question")) this.questionChanges.publish("changed", true);
  }
}
