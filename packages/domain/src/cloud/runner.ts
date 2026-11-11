import { type Answer, type HarnessEvent, ID, type QuestionPayload, SHORT, TEXT } from "@dispand/runner-protocol";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { cloudSessions, stepRuns } from "../db/schema.ts";
import { answerText } from "../engine/engine.ts";
import type { CloudHarness, HarnessAdapter, StartParams } from "../engine/harness.ts";
import { loadCloudHarness } from "../harnesses/cloud.ts";
import { newId } from "../ids.ts";
import { errorKind, logError } from "../log.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { SecretError, type SecretBox } from "../secrets.ts";
import {
  ASK_USER,
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
import { type ChatItem, type ClientHarness, createModelClient, type ModelClient, type ModelTurn, type ToolCall, type ToolSpec } from "./model-client.ts";
import { DEFAULT_BASE_URLS } from "./models.ts";
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
type Handler = (sessionId: string, event: HarnessEvent, seq: number) => Promise<void>;

/** Model calls in one turn (from a user message to the model's answer), as a bound on runaway tool loops. */
export const MAX_CALLS_PER_TURN = 50;

/** Why a model call failed, in a few words: never the provider's body or the key. */
export function providerError(err: unknown, h: { kind: ClientHarness["kind"]; baseUrl?: string }): string {
  if (err instanceof SecretError) return "The harness's API key couldn't be opened";
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return "The provider refused the key";
  if (status === 429) return "The provider is limiting requests for this key: try again later";
  if (typeof status === "number") return `The provider answered with an error (${status})`;
  const base = h.baseUrl ?? (h.kind === "openai-compatible" ? "" : DEFAULT_BASE_URLS[h.kind]);
  let host = "the provider";
  try {
    host = new URL(base).host;
  } catch {
    // An unparsable URL: "the provider".
  }
  return `Couldn't reach ${host}`;
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
  private readonly driving = new Set<string>();
  /** The tool call under way of each session, so a stop can cut it. */
  private readonly calls = new Map<string, AbortController>();
  private readonly again = new Set<string>();
  private readonly client: (h: ClientHarness) => ModelClient;
  private readonly tools: ToolCaller;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    deps: { tools: ToolCaller; client?: (h: ClientHarness) => ModelClient },
  ) {
    this.tools = deps.tools;
    this.client = deps.client ?? ((h) => createModelClient(h));
  }

  onEvent(h: Handler): void {
    this.handler = h;
  }

  /**
   * Starts a session, or continues it (a resume: `start.prompt` joins it as a message). A start
   * for a session that exists and isn't a resume changes nothing: it is already under way.
   */
  async start(harness: CloudHarness, start: StartParams): Promise<boolean> {
    const id = start.sessionId;
    await this.locked(id, async () => {
      const [row] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, id));
      if (!row) {
        const [step] = await this.db.select({ id: stepRuns.id, ownerId: stepRuns.ownerId }).from(stepRuns).where(eq(stepRuns.sessionId, id));
        if (!step) throw new Error("unknown session");
        await this.db.insert(cloudSessions).values({
          id,
          ownerId: step.ownerId,
          stepRunId: step.id,
          harnessId: harness.id,
          model: harness.model ?? null,
          start,
          items: [{ role: "user", text: start.prompt }],
          status: "running",
        });
        await this.emit(id, {}, { type: "cli-session", cliSessionId: id });
        return;
      }
      if (!start.resumeCliSessionId) return;
      // Its question can't be answered by id any more: the engine sends the answer as words.
      const call = row.pending ? nextCall(row.items) : undefined;
      const items: ChatItem[] = call ? [...row.items, { role: "tool", callId: call.id, name: call.name, result: TEXTS.notAnswered, isError: true }] : row.items;
      await this.write(id, { items, pending: null, queued: [...row.queued, start.prompt], status: "running" });
    });
    this.kick(id);
    return true;
  }

  /** Ends the session without an event (its run was stopped): the loop stops before its next model or tool call. */
  async stop(sessionId: string): Promise<boolean> {
    await this.locked(sessionId, () => this.db.update(cloudSessions).set({ status: "done" }).where(eq(cloudSessions.id, sessionId)));
    // Its tool call under way is cut; one not dispatched yet finds the session done.
    this.calls.get(sessionId)?.abort();
    return true;
  }

  async send(sessionId: string, text: string): Promise<boolean> {
    const known = await this.locked(sessionId, async () => {
      const [row] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, sessionId));
      if (!row) return false;
      if (row.status === "done") return true;
      await this.write(sessionId, { queued: [...row.queued, text], ...(row.status === "idle" ? { status: "running" as const } : {}) });
      return true;
    });
    if (known) this.kick(sessionId);
    return known;
  }

  async answer(sessionId: string, questionId: string, answer: Answer): Promise<boolean> {
    const known = await this.locked(sessionId, async () => {
      const [row] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, sessionId));
      if (!row) return false;
      // An answer to a question the session no longer waits on finds nothing to resolve.
      if (row.status !== "waiting" || row.pending?.questionId !== questionId) return true;
      const call = nextCall(row.items);
      if (!call) return true;
      await this.resolve(row, call, row.pending.payload, answer);
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
      .where(inArray(stepRuns.status, ["pending", "running", "waiting"]));
    const live: string[] = [];
    for (const { s, runId } of rows) {
      // A turn of a root paused at a checkpoint isn't run again: not live, the engine holds it to resume.
      const paused = s.status === "running" && !(await going(runId));
      await this.locked(s.id, async () => {
        if (s.lastEvent) await this.deliver(s.id, s.lastEvent, s.seq);
        if (s.status === "done" || paused) return;
        live.push(s.id);
        if (s.inFlight) {
          const call = nextCall(s.items);
          const items: ChatItem[] = call?.id === s.inFlight.callId ? [...s.items, { role: "tool", callId: call.id, name: call.name, result: TEXTS.restarted, isError: true }] : s.items;
          await this.emit(s.id, { items, inFlight: null, approvedCall: null }, { type: "tool", name: await this.labelOf(s.id, s.inFlight.key), status: "done" });
        }
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
  private async emit(id: string, patch: Patch, event: HarnessEvent) {
    const [row] = await this.db
      .update(cloudSessions)
      .set({ ...patch, seq: sqlIncrement(), lastEvent: event })
      .where(eq(cloudSessions.id, id))
      .returning({ seq: cloudSessions.seq });
    if (row) await this.deliver(id, event, row.seq);
  }

  private async deliver(id: string, event: HarnessEvent, seq: number) {
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
    this.driving.add(id);
    void this.drive(id)
      .catch(async (err: unknown) => {
        logError("cloud session failed", err, { ref: id });
        await this.locked(id, () => this.emit(id, { status: "done" }, { type: "error", message: "The cloud session stopped on an internal error" })).catch(
          (e: unknown) => logError("cloud session failed", e, { ref: id }),
        );
      })
      .finally(() => {
        this.driving.delete(id);
        if (this.again.delete(id)) this.kick(id);
      });
  }

  private async drive(id: string) {
    for (;;) {
      const [row] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, id));
      if (row?.status !== "running") return;
      const call = nextCall(row.items);
      if (call) await this.handleCall(row, call);
      else await this.modelCall(row);
    }
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

  private async modelCall(row: Row) {
    const id = row.id;
    const start = row.start;
    // Messages that came during the turn join it now: no tool call is waiting for its result.
    let items = row.items;
    await this.locked(id, async () => {
      const [now] = await this.db.select({ queued: cloudSessions.queued }).from(cloudSessions).where(eq(cloudSessions.id, id));
      if (now && now.queued.length > 0) {
        items = [...items, ...now.queued.map((text): ChatItem => ({ role: "user", text }))];
        await this.write(id, { items, queued: [] });
      }
    });
    const sinceUser = items.length - 1 - items.findLastIndex((x) => x.role === "user");
    const calls = items.slice(-sinceUser || items.length).filter((x) => x.role === "assistant").length;
    if (sinceUser > 0 && calls >= MAX_CALLS_PER_TURN) {
      await this.locked(id, () => this.emit(id, { status: "done" }, { type: "error", message: "the agent made too many tool calls in one turn" }));
      return;
    }

    let harness: ClientHarness & { systemPrompt: string };
    try {
      const h = await loadCloudHarness(this.db, this.secrets, row.ownerId, row.harnessId);
      harness = { ...h, ...(row.model ? { model: row.model } : {}) };
    } catch (err) {
      const message = err instanceof SecretError ? providerError(err, { kind: "openai-compatible" }) : "The agent's harness no longer exists";
      await this.locked(id, () => this.emit(id, { status: "done" }, { type: "error", message }));
      return;
    }
    const text = textStream((delta) => this.locked(id, () => this.emit(id, {}, { type: "text", delta })));
    let turn: ModelTurn;
    try {
      const { specs, names } = await this.specs(row.id);
      const tools = [askUserSpec, submitOutputsSpec(start.expectedOutputs), requestApprovalSpec, ...specs.map((s) => ({ ...s.spec, name: names.toName(s.key) }))];
      turn = await modelCall(harness.kind, id, () =>
        this.client(harness).turn({
          system: [harness.systemPrompt, start.systemPrompt].filter(Boolean).join("\n\n"),
          items,
          tools,
          signal: new AbortController().signal,
          onText: text.push,
        }),
      );
    } catch (err) {
      await text.done();
      await this.locked(id, () => this.emit(id, { status: "done" }, { type: "error", message: providerError(err, harness) }));
      return;
    }
    await text.done();

    await this.locked(id, async () => {
      const [now] = await this.db.select().from(cloudSessions).where(eq(cloudSessions.id, id));
      if (!now) return;
      const after: ChatItem[] = [...items, { role: "assistant", text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw }];
      if (turn.toolCalls.length > 0) return this.write(id, { items: after });
      if (turn.stop === "refusal") return this.emit(id, { items: after, status: "done" }, { type: "error", message: "The model refused to answer" });
      if (turn.stop === "max_tokens") return this.emit(id, { items: after, status: "done" }, { type: "error", message: "The model's answer reached its token limit" });
      // More messages came meanwhile: their turn runs next, so the session isn't waiting yet.
      if (now.queued.length > 0) return this.write(id, { items: after });
      const fields = start.expectedOutputs;
      if (!start.interactive && fields.length === 0) return this.emit(id, { items: after, status: "done" }, { type: "result", text: cut(turn.text, TEXT) });
      if (start.interactive) return this.emit(id, { items: after, status: "idle" }, { type: "turn-end" });
      if (now.reminded) return this.emit(id, { items: after, status: "done" }, { type: "error", message: "the agent finished without its outputs" });
      return this.write(id, { items: [...after, { role: "user", text: TEXTS.reminder(fields) }], reminded: true });
    });
  }

  /** One tool call of the model's last answer: answered at once, asked about, or run. */
  private async handleCall(row: Row, call: ToolCall) {
    const id = row.id;
    const items = (text: string, isError: boolean): ChatItem[] => [...row.items, { role: "tool", callId: call.id, name: call.name, result: text, isError }];
    const builtin = call.name === ASK_USER || call.name === SUBMIT_OUTPUTS || call.name === REQUEST_APPROVAL;
    const { specs, names } = await this.specs(row.id);
    const key = builtin ? undefined : names.fromName(call.name);
    const label = cut(specs.find((s) => s.key === key)?.label ?? call.name, ID);
    const approved = row.approvedCall === call.id;
    const done = (text: string, isError: boolean, extra: Patch = {}) =>
      this.emit(id, { items: items(text, isError), ...extra }, { type: "tool", name: label, status: "done" });
    const run = await this.locked(id, async (): Promise<string | null> => {
      // Stopped while this call was being prepared: nothing more is asked, written or run.
      const [now] = await this.db.select({ status: cloudSessions.status }).from(cloudSessions).where(eq(cloudSessions.id, id));
      if (now?.status !== "running") return null;
      // Shown once per call: not again when it runs after the owner allowed it.
      if (!approved) await this.emit(id, {}, { type: "tool", name: label, status: "started" });
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
      if (call.name === SUBMIT_OUTPUTS) {
        const given = outputValues(args, row.start.expectedOutputs);
        if ("error" in given) await done(given.error, true);
        else if (row.start.interactive) await ask({ kind: "confirm-outputs", values: given.values });
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
    if (run === null) return;
    let outcome: { text: string; isError: boolean };
    const stopped = new AbortController();
    this.calls.set(id, stopped);
    try {
      outcome = await this.tools.call(id, run, call.args, stopped.signal);
    } catch (err) {
      logError("cloud tool call failed", err, { ref: id });
      outcome = { text: "The tool call failed.", isError: true };
    } finally {
      this.calls.delete(id);
    }
    // A stopped session keeps its state as the stop left it.
    if (stopped.signal.aborted) return;
    await this.locked(id, () => done(outcome.text, outcome.isError, { inFlight: null }));
  }

  /** The owner answered the question the session waits on, for `call`. Call it locked. */
  private async resolve(row: Row, call: ToolCall, payload: QuestionPayload, answer: Answer) {
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
      return reply(answerText({ payload, answer }), false);
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
