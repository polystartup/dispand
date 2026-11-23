import { type Answer, ID, type QuestionPayload, SHORT, TEXT } from "@dispand/runner-protocol";
import type { CloudEvent } from "../messages/record-result.ts";
import { isRecordTool, recordResultOf } from "./record-result.ts";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { cloudSessions, runs, stepRuns, type MessageFile } from "../db/schema.ts";
import { attachmentBytes } from "../data/files.ts";
import { answerText } from "../engine/answers.ts";
import { liveCloudStep } from "../engine/discovery.ts";
import type { AgentAnswerer, CloudHarness, HarnessAdapter, InterruptOutcome, StartParams } from "../engine/harness.ts";
import { loadCloudHarness } from "../harnesses/cloud.ts";
import { newId } from "../ids.ts";
import { errorKind, logError } from "../log.ts";
import { inJobTrace, meter, recordError, tracer } from "../telemetry/index.ts";
import { stored } from "../messages/index.ts";
import { SecretError, type SecretBox } from "../secrets.ts";
import {
  ASK_USER,
  CONSULT,
  consultQuestion,
  consultSpec,
  READ_SKILL,
  readSkillSpec,
  REQUEST_APPROVAL,
  approvalMessage,
  requestApprovalSpec,
  askUserPayload,
  askUserSpec,
  outputValues,
  questionEvent,
  storableText,
  SUBMIT_OUTPUTS,
  submitOutputsSpec,
  TEXTS,
} from "./builtins.ts";
import { budgetFiles, type ChatItem, type ClientHarness, createModelClient, type ModelClient, type ModelTurn, type ToolCall, type ToolSpec } from "./model-client.ts";
import { DEFAULT_BASE_URLS } from "./models.ts";
import { readSkill, sessionSkills, skillsPrompt } from "../skills/cloud.ts";
import { toolNames } from "./tool-names.ts";

/** The agent's tools (MCP), by key. The MCP-backed one is `mcpToolCaller`. */
export interface ToolCaller {
  /**
   * The tools of a session, read at every call. `ask: false` marks one that runs without a
   * permission question (Dispand's own, authorized per call; an action its agent lets run
   * unasked). `always: true` marks one whose question offers "always allow".
   */
  specs(sessionId: string): Promise<{ key: string; label: string; spec: ToolSpec; ask?: false; always?: true }[]>;
  call(sessionId: string, key: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
  /** The owner answered "always allow" for this tool: the caller makes it `ask: false` from now on, where that is kept. */
  allowAlways?(sessionId: string, key: string): Promise<void>;
}

/** Until agents get tools: none. */
/** Several callers as one: their tools together; a call goes to the caller that offers its key. */
export function combineToolCallers(...callers: ToolCaller[]): ToolCaller {
  return {
    specs: async (sessionId) => (await Promise.all(callers.map((c) => c.specs(sessionId)))).flat(),
    async call(sessionId, key, args, signal) {
      for (const caller of callers) {
        if ((await caller.specs(sessionId)).some((s) => s.key === key)) return caller.call(sessionId, key, args, signal);
      }
      return { text: "This tool is not available.", isError: true };
    },
    async allowAlways(sessionId, key) {
      for (const caller of callers) {
        if ((await caller.specs(sessionId)).some((s) => s.key === key)) return caller.allowAlways?.(sessionId, key);
      }
    },
  };
}

const traces = tracer("cloud");
const counts = meter("cloud");

/** One model call in a span: the harness's kind, how the turn ended and how many tools it asked for; never the prompt or the answer. */
function modelCall(kind: string, sessionId: string, turn: () => Promise<ModelTurn>): Promise<ModelTurn> {
  return traces.startActiveSpan("model.turn", { attributes: { "dispand.harness.kind": kind, "dispand.session.id": sessionId } }, async (span) => {
    const started = performance.now();
    let result = "error";
    try {
      const done = await turn();
      result = done.stop;
      span.setAttribute("dispand.model.tool_calls", done.toolCalls.length);
      // An endpoint of the owner's can send anything as a count: only numbers reach telemetry.
      if (done.usage && [done.usage.input, done.usage.output].every((n) => Number.isFinite(n) && n >= 0)) {
        span.setAttributes({ "dispand.model.tokens.input": done.usage.input, "dispand.model.tokens.output": done.usage.output });
        for (const direction of ["input", "output"] as const) counts.counter("dispand.model.tokens", { unit: "{token}", description: "Tokens the provider counted for a model call" }).add(done.usage[direction], { "dispand.harness.kind": kind, "dispand.token.direction": direction });
      }
      return done;
    } catch (err) {
      recordError(span, errorKind(err));
      throw err;
    } finally {
      span.setAttribute("dispand.result", result);
      span.end();
      counts.counter("dispand.model.calls").add(1, { "dispand.harness.kind": kind, "dispand.result": result });
      counts.histogram("dispand.model.duration", { unit: "ms", description: "A model call of a cloud session" }).record(performance.now() - started, { "dispand.harness.kind": kind, "dispand.result": result });
    }
  });
}

export const noTools: ToolCaller = {
  specs: async () => [],
  call: async () => ({ text: "This tool is not available.", isError: true }),
};

type Row = typeof cloudSessions.$inferSelect;
type Patch = Partial<Omit<Row, "id" | "seq" | "lastEvent">>;
type Handler = (sessionId: string, event: CloudEvent, seq: number) => Promise<void>;
type Execution = { controller: AbortController; text: string; turnId: string };

/** A provider may finish after cancellation; its detached result cannot write into the next turn. */
async function cancellable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Model calls in one turn (from a user message to the model's answer), as a bound on runaway tool loops. */
export const MAX_CALLS_PER_TURN = 50;

/** Why a model call failed, in a few words: never the provider's body or the key. */
export function providerError(err: unknown, h: { kind: ClientHarness["kind"]; baseUrl?: string }): string {
  if (err instanceof SecretError) return stored("cloud.fail.keyNotOpened");
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return stored("cloud.fail.keyRefused");
  if (status === 429) return stored("cloud.fail.rateLimited");
  if (typeof status === "number") return stored("cloud.fail.providerError", { status });
  const base = h.baseUrl ?? (h.kind === "openai-compatible" ? "" : DEFAULT_BASE_URLS[h.kind]);
  try {
    return stored("cloud.fail.unreachable", { host: new URL(base).host });
  } catch {
    // An unparsable URL: no host to name.
    return stored("cloud.fail.unreachableProvider");
  }
}

/** The first tool call of the last assistant item that has no result yet. */
function nextCall(items: ChatItem[]): ToolCall | undefined {
  const i = items.findLastIndex((x) => x.role === "assistant");
  const last = items[i];
  if (last?.role !== "assistant") return undefined;
  const done = new Set(items.slice(i + 1).flatMap((x) => (x.role === "tool" ? [x.callId] : [])));
  return last.toolCalls.find((c) => !done.has(c.id));
}

const cut = (s: string, max: number) => storableText(s.slice(0, max));

/** Whether the session has `submit_outputs`: in a chat, which ends with it, or when the step expects outputs. */
const offersSubmit = (start: { interactive: boolean; expectedOutputs: unknown[] }) => start.interactive || start.expectedOutputs.length > 0;

/**
 * Cloud harness sessions, run in process: Dispand runs the tool loop itself and reports to the
 * engine with the same events a runner sends (spec 5.1). Each session is a `cloud_sessions` row:
 * every state change is written with the seq of the event it causes before that event reaches the
 * engine, one at a time and in order, so a crash loses nothing and replays at most the last event
 * (`recover`), which the engine drops by seq. API keys are opened at each model call and go only
 * to the provider: no event, error or row holds one.
 */
export class CloudRunner implements HarnessAdapter<CloudHarness> {
  private handler: Handler = async () => {};
  private readonly locks = new Map<string, Promise<void>>();
  private readonly driving = new Map<string, Promise<void>>();
  private readonly executions = new Map<string, Execution>();
  private readonly again = new Set<string>();
  private readonly client: (h: ClientHarness) => ModelClient;
  private readonly tools: ToolCaller;
  private readonly claimTurn: (sessionId: string) => Promise<boolean>;

  /** Where attachments are kept: a chat message's files are read from there at each model call. */
  private readonly filesDir: string | undefined;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    deps: { tools: ToolCaller; client?: (h: ClientHarness) => ModelClient; filesDir?: string; claimTurn?: (sessionId: string) => Promise<boolean> },
  ) {
    this.tools = deps.tools;
    this.filesDir = deps.filesDir;
    this.client = deps.client ?? ((h) => createModelClient(h));
    this.claimTurn = deps.claimTurn ?? (async () => true);
  }

  onEvent(h: Handler): void {
    this.handler = h;
  }

  /** The engine granted a slot for input the cloud session already holds. */
  resumeQueued(sessionId: string): void {
    this.kick(sessionId);
  }

  /**
   * Starts a session, or continues it (a resume: `start.prompt` joins it as a message). A start
   * for a session that exists and isn't a resume changes nothing: it is already under way.
   */
  async start(harness: CloudHarness, start: StartParams): Promise<boolean> {
    const id = start.sessionId;
    const idle = !start.prompt && start.interactive;
    await this.locked(id, async () => {
      const [row] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, id));
      if (!row) {
        const [step] = await this.db.select({ id: stepRuns.id, ownerId: stepRuns.ownerId }).from(stepRuns).where(eq(stepRuns.sessionId, id));
        if (!step) throw new Error("unknown session");
        const [previous] = start.resumeCliSessionId
          ? await this.db.select().from(cloudSessions).where(and(eq(cloudSessions.id, start.resumeCliSessionId), eq(cloudSessions.stepRunId, step.id)))
          : [];
        if (start.resumeCliSessionId && !previous) throw new Error("unknown cloud transcript");
        const history: ChatItem[] = previous ? [...previous.items] : [];
        // A completion may leave later calls in the same model batch unanswered. They belong
        // to the former turn: settle all of them before consuming the new owner's message.
        for (let call = nextCall(history); call; call = nextCall(history)) {
          history.push({ role: "tool", callId: call.id, name: call.name, result: TEXTS.notAnswered, isError: true });
        }
        await this.db.insert(cloudSessions).values({
          id,
          ownerId: step.ownerId,
          stepRunId: step.id,
          harnessId: harness.id,
          model: harness.model ?? null,
          start,
          // An empty prompt (a chat whose trigger has no instructions) is no turn: the owner's first
          // message is. Until it comes, the chat waits between turns (`send` wakes it).
          items: previous ? history : idle ? [] : [{ role: "user", text: start.prompt }],
          ...(previous ? { queued: [...previous.queued, start.prompt] } : {}),
          status: idle ? "idle" : "running",
        });
        await this.emit(id, {}, { type: "cli-session", cliSessionId: id });
        if (idle) await this.emit(id, {}, { type: "turn-end" });
        return;
      }
      if (!start.resumeCliSessionId) return;
      // Its question can't be answered by id any more: the engine sends the answer as words.
      const call = row.pending ? nextCall(row.items) : undefined;
      const items: ChatItem[] = call ? [...row.items, { role: "tool", callId: call.id, name: call.name, result: TEXTS.notAnswered, isError: true }] : row.items;
      // A resumed Job's system prompt carries its memory as it is now: the next model calls read it.
      await this.write(id, { start: { ...row.start, systemPrompt: start.systemPrompt }, items, pending: null, queued: [...row.queued, start.prompt], status: "running" });
    });
    this.kick(id);
    return true;
  }

  /** Ends the session without an event (its run was stopped): the loop stops before its next model or tool call. */
  async stop(sessionId: string): Promise<boolean> {
    await this.locked(sessionId, async () => {
      this.executions.get(sessionId)?.controller.abort();
      await this.write(sessionId, { status: "done" });
    });
    // A reopened session must not race the former model/tool loop on the same transcript.
    await this.driving.get(sessionId);
    await this.locked(sessionId, () => this.emit(sessionId, {}, { type: "session-ended" }));
    return true;
  }

  /** Interrupts only this turn, retaining a usable transcript and the same session. */
  async interrupt(sessionId: string, turnId: string): Promise<InterruptOutcome> {
    return this.locked(sessionId, async () => {
      const [row] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, sessionId));
      if (!row || row.turnId !== turnId || !["running", "waiting"].includes(row.status)) return "stale";
      const execution = this.executions.get(sessionId);
      execution?.controller.abort();
      const items = [...row.items];
      if (execution?.text) items.push({ role: "assistant", text: execution.text, toolCalls: [] });
      for (let call = nextCall(items); call; call = nextCall(items)) {
        items.push({ role: "tool", callId: call.id, name: call.name, result: row.inFlight?.callId === call.id ? "Interrupted. The tool's completion is unknown." : "Not run: the turn was interrupted.", isError: true });
      }
      const settled: Patch = { items, turnId: null, pending: null, approvedCall: null, approvedKey: null, inFlight: null };
      // Like native sessions, queued input starts a new turn; stopping this one never drops it.
      if (row.queued.length > 0) {
        await this.emit(sessionId, { ...settled, status: "running" }, { type: "turn-end", turnId });
        this.kick(sessionId);
      } else {
        await this.emit(sessionId, { ...settled, status: "idle" }, { type: "turn-end", turnId });
      }
      return "requested";
    });
  }

  send(sessionId: string, text: string, files: MessageFile[] = []): Promise<boolean> {
    return this.queue(sessionId, text, files);
  }

  /**
   * A message queued while turn `turnId` runs joins it at its next model call: the turn goes on
   * until none is left (`modelCall`). Otherwise it starts the next turn.
   */
  steer(sessionId: string, turnId: string, requestId: string, text: string, files: MessageFile[] = []): Promise<boolean> {
    return this.queue(sessionId, text, files, { turnId, requestId });
  }

  private async queue(sessionId: string, text: string, files: MessageFile[], steer?: { turnId: string; requestId: string }): Promise<boolean> {
    const known = await this.locked(sessionId, async () => {
      const [row] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, sessionId));
      if (!row) return false;
      if (row.status === "done") return true;
      const patch: Patch = { queued: [...row.queued, files.length ? { text, files } : text], ...(row.status === "idle" ? { status: "running" as const } : {}) };
      if (!steer) await this.write(sessionId, patch);
      else {
        const joins = row.turnId === steer.turnId && (row.status === "running" || row.status === "waiting");
        await this.emit(sessionId, patch, { type: "steer-result", ...steer, outcome: joins ? "steered" : "queued" });
      }
      return true;
    });
    if (known) this.kick(sessionId);
    return known;
  }

  async answer(sessionId: string, questionId: string, answer: Answer, by?: AgentAnswerer): Promise<boolean> {
    const known = await this.locked(sessionId, async () => {
      const [row] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, sessionId));
      if (!row) return false;
      // An answer to a question the session no longer waits on finds nothing to resolve.
      if (row.status !== "waiting" || row.pending?.questionId !== questionId) return true;
      const call = nextCall(row.items);
      if (!call) return true;
      await this.resolve(row, call, row.pending.payload, answer, by);
      return true;
    });
    if (known) this.kick(sessionId);
    return known;
  }

  /**
   * On boot, before runners connect: the last event of each open step's session goes to the
   * engine again (dropped if it was handled), a tool call cut by the restart is answered without
   * running it again, and sessions that were working go on. Returns the sessions still open.
   */
  async recover(going: (runId: string) => Promise<boolean> = async () => true): Promise<string[]> {
    const rows = await this.db
      .select({ s: cloudSessions, runId: stepRuns.runId })
      .from(cloudSessions)
      .innerJoin(stepRuns, eq(stepRuns.id, cloudSessions.stepRunId))
      .where(liveCloudStep);
    const live: string[] = [];
    for (const { s, runId } of rows) {
      // A turn of a root paused at a checkpoint isn't run again: not live, the engine holds it to resume.
      const paused = s.status === "running" && !(await going(runId));
      await this.locked(s.id, async () => {
        if (s.lastEvent) await this.deliver(s.id, s.lastEvent, s.seq);
        if (s.status === "done") return;
        // A call cut by the restart is recorded as such either way: it never runs again by itself.
        if (s.inFlight) {
          const call = nextCall(s.items);
          const items: ChatItem[] = call?.id === s.inFlight.callId ? [...s.items, { role: "tool", callId: call.id, name: call.name, result: TEXTS.restarted, isError: true }] : s.items;
          await this.emit(s.id, { items, inFlight: null, approvedCall: null }, { type: "tool", name: await this.labelOf(s.id, s.inFlight.key), status: "done" });
        }
        if (paused) return;
        live.push(s.id);
      });
      if (s.status === "running" && !paused) this.kick(s.id);
    }
    return live;
  }

  /** Runs `work` alone among the session's state changes. */
  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = previous.then(() => new Promise<void>((r) => (release = r)));
    this.locks.set(id, mine);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(id) === mine) this.locks.delete(id);
    }
  }

  /** Writes a state change without an event. */
  private async write(id: string, patch: Patch) {
    await this.db.update(cloudSessions).set(patch).where(eq(cloudSessions.id, id));
  }

  /** Writes a state change with its event and seq in one statement, then hands the event to the engine. Call it locked. */
  private async emit(id: string, patch: Patch, event: CloudEvent) {
    const [row] = await this.db
      .update(cloudSessions)
      .set({ ...patch, seq: sqlIncrement(), lastEvent: event })
      .where(eq(cloudSessions.id, id))
      .returning({ seq: cloudSessions.seq });
    if (row) await this.deliver(id, event, row.seq);
  }

  private async deliver(id: string, event: CloudEvent, seq: number) {
    try {
      await this.handler(id, event, seq);
    } catch (err) {
      logError("cloud event handling failed", err, { ref: id });
    }
  }

  /** Makes sure the session's loop runs (once). */
  private kick(id: string) {
    if (this.driving.has(id)) {
      this.again.add(id);
      return;
    }
    const execution: Execution = { controller: new AbortController(), text: "", turnId: "" };
    this.executions.set(id, execution);
    const driving = this.drive(id, execution)
      .catch(async (err: unknown) => {
        if (execution.controller.signal.aborted) return;
        logError("cloud session failed", err, { ref: id });
        await this.active(id, execution, () => this.emit(id, { status: "done" }, { type: "error", message: stored("cloud.fail.internal") })).catch(
          (e: unknown) => logError("cloud session failed", e, { ref: id }),
        );
      })
      .finally(() => {
        if (this.executions.get(id) === execution) this.executions.delete(id);
        this.driving.delete(id);
        if (this.again.delete(id)) this.kick(id);
      });
    this.driving.set(id, driving);
  }

  private async active<T>(id: string, execution: Execution, work: () => Promise<T>): Promise<T | undefined> {
    return this.locked<T | undefined>(id, () => this.executions.get(id) === execution && !execution.controller.signal.aborted ? work() : Promise.resolve(undefined));
  }

  private async drive(id: string, execution: Execution) {
    for (;;) {
      // Each turn in its Job's trace, whatever woke the session (a start, an answer, a restart).
      // A queued restart may wake while interruption is writing: claim only its committed transcript.
      const found = await this.active(id, execution, async () => {
        const [found] = await this.db
          .select({ row: cloudSessions, traceId: runs.traceId, spanId: runs.spanId, workspaceId: runs.workspaceId })
          .from(cloudSessions)
          .leftJoin(stepRuns, eq(stepRuns.id, cloudSessions.stepRunId))
          .leftJoin(runs, eq(runs.id, stepRuns.runId))
          .where(eq(cloudSessions.id, id));
        const row = found?.row;
        if (row?.status !== "running") return;
        if (!row.turnId || execution.turnId !== row.turnId) {
          if (!(await this.claimTurn(id))) return;
          execution.turnId = row.turnId ?? newId("turn");
          await this.emit(id, { turnId: execution.turnId }, { type: "turn-start", turnId: execution.turnId, interruptible: true });
        }
        return found;
      });
      if (!found) return;
      const row = found.row;
      const call = nextCall(row.items);
      await cancellable(execution.controller.signal, () => inJobTrace(found, () => (call ? this.handleCall(row, call, execution) : this.modelCall(row, found.workspaceId, execution))));
    }
  }

  /** The transcript with its attached files' bytes, read for this model call only: the stored items keep their ids. */
  private async withFileBytes(workspaceId: string, items: ChatItem[], kind: ClientHarness["kind"]): Promise<ChatItem[]> {
    const ids = items.flatMap((x) => (x.role === "user" ? (x.files ?? []).map((f) => f.id) : []));
    if (ids.length === 0) return items;
    const bytes = this.filesDir ? await attachmentBytes(this.db, this.filesDir, workspaceId, ids) : new Map<string, Uint8Array>();
    // OpenAI-compatible servers get no PDF (`openai-chat.ts`).
    return budgetFiles(items.map((x) => (x.role === "user" && x.files?.length ? { ...x, files: x.files.map((f) => ({ id: f.id, name: f.name, ...(bytes.has(f.id) ? { bytes: bytes.get(f.id) } : {}) })) } : x)), { pdf: kind !== "openai-compatible" });
  }

  private async specs(sessionId: string) {
    const specs = await this.tools.specs(sessionId);
    const names = toolNames(specs.map(({ key, label }) => ({ key, label })));
    return { specs, names };
  }

  private async labelOf(sessionId: string, key: string) {
    const { specs } = await this.specs(sessionId);
    return cut(specs.find((s) => s.key === key)?.label ?? key, ID);
  }

  private async modelCall(row: Row, workspaceId: string | null, execution: Execution) {
    const id = row.id;
    const start = row.start;
    // Messages that came during the turn join it now: no tool call is waiting for its result.
    let items = row.items;
    await this.active(id, execution, async () => {
      execution.text = "";
      const [now] = await this.db.select({ queued: cloudSessions.queued }).from(cloudSessions).where(eq(cloudSessions.id, id));
      if (now && now.queued.length > 0) {
        items = [...items, ...now.queued.map((q): ChatItem => (typeof q === "string" ? { role: "user", text: q } : { role: "user", text: q.text, files: q.files }))];
        await this.write(id, { items, queued: [] });
      }
    });
    const sinceUser = items.length - 1 - items.findLastIndex((x) => x.role === "user");
    const calls = items.slice(-sinceUser || items.length).filter((x) => x.role === "assistant").length;
    if (sinceUser > 0 && calls >= MAX_CALLS_PER_TURN) {
      await this.active(id, execution, () => this.emit(id, { status: "done" }, { type: "error", message: stored("cloud.fail.tooManyCalls") }));
      return;
    }

    let harness: ClientHarness & { systemPrompt: string };
    try {
      const h = await loadCloudHarness(this.db, this.secrets, workspaceId ?? "", row.harnessId);
      harness = { ...h, ...(row.model ? { model: row.model } : {}) };
    } catch (err) {
      const message = err instanceof SecretError ? providerError(err, { kind: "openai-compatible" }) : stored("cloud.fail.harnessGone");
      await this.active(id, execution, () => this.emit(id, { status: "done" }, { type: "error", message }));
      return;
    }
    const text = textStream(async (delta) => { await this.active(id, execution, async () => {
      execution.text += delta;
      await this.emit(id, {}, { type: "text", delta });
    }); });
    let turn: ModelTurn;
    try {
      const { specs, names } = await this.specs(row.id);
      // The agent's skills as they are now, read at every turn like its tools.
      const skills = await sessionSkills(this.db, id);
      const tools = [
        askUserSpec,
        // A chat ends with it; elsewhere it is offered only with values to hand back, and a step
        // without them answers with its last message.
        ...(offersSubmit(start) ? [submitOutputsSpec(start.expectedOutputs)] : []),
        requestApprovalSpec,
        ...(start.consults?.length ? [consultSpec(start.consults)] : []),
        ...(skills.length > 0 ? [readSkillSpec] : []),
        ...specs.map((s) => ({ ...s.spec, name: names.toName(s.key) })),
      ];
      const sent = await this.withFileBytes(workspaceId ?? "", items, harness.kind);
      turn = await modelCall(harness.kind, id, () =>
        cancellable(execution.controller.signal, () => this.client(harness).turn({
          system: [harness.systemPrompt, start.systemPrompt, skillsPrompt(skills)].filter(Boolean).join("\n\n"),
          items: sent,
          tools,
          signal: execution.controller.signal,
          onText: text.push,
        })),
      );
    } catch (err) {
      await text.done();
      await this.active(id, execution, () => this.emit(id, { status: "done" }, { type: "error", message: providerError(err, harness) }));
      return;
    }
    await text.done();

    await this.active(id, execution, async () => {
      const [now] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, id));
      if (!now) return;
      const after: ChatItem[] = [...items, { role: "assistant", text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw }];
      execution.text = "";
      if (turn.toolCalls.length > 0) return this.write(id, { items: after });
      if (turn.stop === "refusal") return this.emit(id, { items: after, status: "done" }, { type: "error", message: stored("cloud.fail.refused") });
      if (turn.stop === "max_tokens") return this.emit(id, { items: after, status: "done" }, { type: "error", message: stored("cloud.fail.tokenLimit") });
      // More messages came meanwhile: their turn runs next, so the session isn't waiting yet.
      if (now.queued.length > 0) return this.write(id, { items: after });
      const fields = start.expectedOutputs;
      if (!start.interactive && fields.length === 0) return this.emit(id, { items: after, status: "done" }, { type: "result", text: cut(turn.text, TEXT) });
      if (start.interactive) return this.emit(id, { items: after, status: "idle", turnId: null }, { type: "turn-end", turnId: execution.turnId });
      if (now.reminded) return this.emit(id, { items: after, status: "done" }, { type: "error", message: stored("engine.fail.noOutputs") });
      return this.write(id, { items: [...after, { role: "user", text: TEXTS.reminder(fields) }], reminded: true });
    });
  }

  /** One tool call of the model's last answer: answered at once, asked about, or run. */
  private async handleCall(row: Row, call: ToolCall, execution: Execution) {
    const id = row.id;
    const items = (text: string, isError: boolean): ChatItem[] => [...row.items, { role: "tool", callId: call.id, name: call.name, result: text, isError }];
    const consults = row.start.consults ?? [];
    // `read_skill` is reserved (`tool-names.ts`): no other tool can take its name.
    const builtin =
      call.name === ASK_USER || (call.name === SUBMIT_OUTPUTS && offersSubmit(row.start)) || call.name === REQUEST_APPROVAL || call.name === READ_SKILL || (call.name === CONSULT && consults.length > 0);
    const { specs, names } = await this.specs(row.id);
    const key = builtin ? undefined : names.fromName(call.name);
    const selected = specs.find((s) => s.key === key);
    const label = cut(selected?.label ?? call.name, ID);
    // Provider call ids may repeat across model responses in one turn; each read owns its snapshot.
    const recordCall = isRecordTool(selected) && typeof call.args === "object" && call.args !== null && "id" in call.args && typeof call.args.id === "string" ? { toolCallId: newId("call"), turnId: execution.turnId, args: { id: call.args.id } } : undefined;
    const approved = row.approvedCall === call.id;
    const done = (text: string, isError: boolean, extra: Patch = {}) =>
      this.emit(id, { items: items(text, isError), ...extra }, { type: "tool", name: label, status: "done" });
    const run = await this.active(id, execution, async (): Promise<string | null> => {
      // Stopped while this call was being prepared: nothing more is asked, written or run.
      const [now] = await this.db.select({ status: cloudSessions.status }).from(cloudSessions).where(eq(cloudSessions.id, id));
      if (now?.status !== "running") return null;
      // Shown once per call: not again when it runs after the owner allowed it.
      if (!approved) await this.emit(id, {}, recordCall ? { type: "record-start", ...recordCall } : { type: "tool", name: label, status: "started" });
      const ask = async (payload: QuestionPayload, askedKey?: string) => {
        const questionId = newId("cq");
        const event = questionEvent(questionId, payload);
        // The owner approves exactly what they see: what the protocol can't carry whole isn't asked.
        if (!event) return done(payload.kind === "permission" ? TEXTS.tooLargeToAsk : "These values can't be shown to the owner.", true);
        return this.emit(id, { status: "waiting", pending: { questionId, callId: call.id, payload, ...(askedKey ? { key: askedKey } : {}) } }, event);
      };
      const args = call.args;
      if (typeof args === "object" && args !== null && "__invalid" in args) {
        await done(TEXTS.invalidArgs(call.name), true);
        return null;
      }
      if (call.name === ASK_USER) {
        const asked = askUserPayload(args);
        await ("error" in asked ? done(asked.error, true) : ask(asked.payload));
        return null;
      }
      if (call.name === REQUEST_APPROVAL) {
        // Each request waits for its own answer: nothing here is ever allowed for the session.
        if (approved) return (await done(TEXTS.approved, false, { approvedCall: null, approvedKey: null }), null);
        const words = approvalMessage(args);
        await ("error" in words ? done(words.error, true) : ask({ kind: "permission", toolName: REQUEST_APPROVAL, input: words, canAlwaysAllow: false }));
        return null;
      }
      if (call.name === CONSULT && consults.length > 0) {
        // Dispand answers it with the consulted agent's Job (or why there is none): the owner isn't asked.
        const asked = consultQuestion(args, consults);
        await ("error" in asked ? done(asked.error, true) : ask({ kind: "consult", ...asked }));
        return null;
      }
      if (call.name === READ_SKILL) {
        // Reading what the agent was given asks nobody; what it may read is checked at the call.
        const read = await readSkill(this.db, id, args);
        await done(read.text, read.isError);
        return null;
      }
      if (call.name === SUBMIT_OUTPUTS && offersSubmit(row.start)) {
        const given = outputValues(args, row.start.expectedOutputs);
        if ("error" in given) await done(given.error, true);
        else if (row.start.interactive && row.start.expectedOutputs.length > 0) await ask({ kind: "confirm-outputs", values: given.values });
        else await this.emit(id, { items: items(TEXTS.confirmed, false), status: "done" }, { type: "outputs-accepted", values: given.values });
        return null;
      }
      if (!key) {
        await done(TEXTS.unknownTool(call.name), true);
        return null;
      }
      // Dispand's own tools are authorized on every call: the owner isn't asked.
      const spec = specs.find((s) => s.key === key);
      const asks = spec?.ask !== false;
      // The model's names follow the session's tools as they are: a call approved for one tool
      // whose name now means another (the first was taken back) is not that approval's to run.
      if (approved && row.approvedKey && row.approvedKey !== key) {
        await done(TEXTS.unknownTool(call.name), true, { approvedCall: null, approvedKey: null });
        return null;
      }
      if (asks && !approved) {
        await ask({ kind: "permission", toolName: label, input: args, canAlwaysAllow: spec?.always === true }, key);
        return null;
      }
      // Recorded before it runs: a restart meanwhile answers it instead of running it again.
      await this.write(id, { inFlight: { callId: call.id, key }, approvedCall: null, approvedKey: null });
      return key;
    });
    if (run == null) return;
    let outcome: { text: string; isError: boolean };
    try {
      outcome = await cancellable(execution.controller.signal, () => this.tools.call(id, run, call.args, execution.controller.signal));
    } catch (err) {
      if (execution.controller.signal.aborted) return;
      logError("cloud tool call failed", err, { ref: id });
      outcome = { text: "The tool call failed.", isError: true };
    }
    // A stopped session keeps its state as the stop left it.
    await this.active(id, execution, async () => {
      const record = !outcome.isError && recordCall ? recordResultOf(outcome) : undefined;
      if (record && recordCall) return this.emit(id, { items: items(outcome.text, false), inFlight: null }, { type: "record-result", ...recordCall, args: { id: record.rowId }, record });
      await done(outcome.text, outcome.isError, { inFlight: null });
    });
  }

  /** The owner (or, `by`, an agent) answered the question the session waits on, for `call`. Call it locked. */
  private async resolve(row: Row, call: ToolCall, payload: QuestionPayload, answer: Answer, by?: AgentAnswerer) {
    const id = row.id;
    const { specs, names } = await this.specs(row.id);
    const key = names.fromName(call.name);
    const label = cut(key ? (specs.find((s) => s.key === key)?.label ?? call.name) : call.name, ID);
    const reply = (text: string, isError: boolean, extra: Patch = {}) =>
      this.emit(
        id,
        { items: [...row.items, { role: "tool", callId: call.id, name: call.name, result: text, isError }], pending: null, status: "running", ...extra },
        { type: "tool", name: label, status: "done" },
      );
    if (payload.kind === "choice") {
      if (answer.kind !== "choice") return reply(TEXTS.notAnswered, true);
      return reply(answerText({ payload, answer, answeredBy: by ?? null }), false);
    }
    if (payload.kind === "consult") {
      if (answer.kind !== "consult") return reply(TEXTS.notAnswered, true);
      return reply(answerText({ payload, answer, answeredBy: by ?? null }), answer.outcome === "failed");
    }
    if (payload.kind === "confirm-outputs") {
      if (answer.kind !== "confirm-outputs" || !answer.confirmed) {
        const feedback = answer.kind === "confirm-outputs" ? answer.feedback : undefined;
        return reply(feedback || TEXTS.notConfirmed, false);
      }
      return this.emit(
        id,
        { items: [...row.items, { role: "tool", callId: call.id, name: call.name, result: TEXTS.confirmed, isError: false }], pending: null, status: "done" },
        { type: "outputs-accepted", values: payload.values },
      );
    }
    if (call.name === REQUEST_APPROVAL && answer.kind === "permission" && answer.decision === "deny") {
      // Said in words: some providers don't carry a tool result's error flag to the model.
      const denied: ChatItem = { role: "tool", callId: call.id, name: call.name, result: `Denied${answer.message ? `: ${cut(answer.message, SHORT)}` : "."}`, isError: true };
      // The "no" covers what the model asked in the same turn: its other calls are not run.
      const turn = row.items.findLast((x) => x.role === "assistant");
      const answered = new Set(row.items.flatMap((x) => (x.role === "tool" ? [x.callId] : [])));
      const others = (turn?.role === "assistant" ? turn.toolCalls : []).filter((c) => c.id !== call.id && !answered.has(c.id));
      const skipped: ChatItem[] = others.map((c) => ({ role: "tool", callId: c.id, name: c.name, result: TEXTS.notRunAfterDenial, isError: true }));
      return this.emit(id, { items: [...row.items, denied, ...skipped], pending: null, status: "running" }, { type: "tool", name: label, status: "done" });
    }
    if (answer.kind !== "permission" || answer.decision === "deny") {
      return reply(cut((answer.kind === "permission" && answer.message) || TEXTS.denied, SHORT), true);
    }
    // The answer is for the tool the question was about: if the name means another tool by now, nothing is allowed.
    const asked = row.pending?.key;
    if (asked && asked !== key) return reply(TEXTS.unknownTool(call.name), true);
    // Allowed: it runs next (the loop sees it approved). "Always" is kept where the tool's asking is
    // decided (its caller), never in the session: what asks is read there at every call.
    if (answer.decision === "allow-always" && key) await this.tools.allowAlways?.(id, key);
    await this.write(id, { pending: null, status: "running", approvedCall: call.id, approvedKey: key ?? null });
  }
}

function sqlIncrement() {
  return sql`${cloudSessions.seq} + 1`;
}

/**
 * Text deltas as events, one at a time: what streams in while one is being written goes out as
 * the next one, so a fast model doesn't queue a write per token. Each is within the protocol's size.
 */
export function textStream(emit: (delta: string) => Promise<void>) {
  let buffer = "";
  let pumping: Promise<void> | null = null;
  // Started only with text buffered, so it always awaits before ending; it ends in the same tick
  // as it finds the buffer empty, so a later push starts a new one.
  const pump = async () => {
    try {
      while (buffer) {
        const delta = cut(buffer, TEXT);
        buffer = buffer.slice(Math.min(buffer.length, TEXT));
        await emit(delta);
      }
    } finally {
      pumping = null;
    }
  };
  return {
    push: (delta: string) => {
      if (!delta) return;
      buffer += delta;
      pumping ??= pump();
    },
    done: async () => {
      while (pumping) await pumping;
    },
  };
}
