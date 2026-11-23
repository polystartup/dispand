import { toolPermissionTarget } from "../agents/tool-ask.ts";
import { runnerServerName } from "./tooling.ts";
import { call } from "@orpc/server";
import { type Answer, type HarnessEvent, parseServerMessage, type ServerToRunner, SESSION_ALREADY_RUNNING, SESSION_NOT_RUNNING, TEXT } from "@dispand/runner-protocol";
import { and, eq, or } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { attachments, audit, agents as agentsTable, agentTools, agentConsults, chatQueue, harnesses as harnessesTable, messages, questions, runners, runs, stepRuns, tools, workspaces, organizations, organizationMembers, user, workflows } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { createRunner, pair } from "../runners/pairing.ts";
import { runnerWithClis, asCli, ownerContext } from "../runners/test-support.ts";
import type { ArgValue } from "../tools/arguments.ts";
import type { ToolExecutor } from "../tools/executor.ts";
import type { AgentStep, ToolStep, WorkflowDef } from "../workflows/model.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { CloudRunner, noTools } from "../cloud/runner.ts";
import { CliHarnessAdapter } from "./cli-harness.ts";
import { RoutingAdapter } from "./routing-adapter.ts";
import { exposedName } from "../platform/exposed.ts";
import { jobTokenOf, jobOfToken } from "../platform/token.ts";
import { stopTelemetry } from "../telemetry/index.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { packageForRunner } from "../skills/runner-access.ts";
import { Engine } from "./engine.ts";
import { RESUME_PROMPT } from "./answers.ts";
import { STOPPED, TOOL_RESTARTED } from "./errors.ts";
import { CLOUD_SOURCE, type CliHarness, type Harness, type HarnessAdapter, type StartParams } from "./harness.ts";
import { stored, storedText } from "../messages/index.ts";
import type { RecordToolResult } from "../messages/record-result.ts";
import { messageView, runView } from "./views.ts";

/** Records what the engine asks of the harness. Online, every message reaches it at once; offline, none does. */
class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  sent: [string, string][] = [];
  answers: [string, string, Answer][] = [];
  online = true;
  interruptOutcome: "requested" | "stale" | "failed" = "requested";
  interrupts: [string, string][] = [];
  async interrupt(sessionId: string, turnId: string) {
    this.interrupts.push([sessionId, turnId]);
    return this.online ? this.interruptOutcome : "failed" as const;
  }
  /** While set, starts don't settle until it does (a write still under way). */
  hold: Promise<void> | undefined;
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    if (this.hold) await this.hold;
    return this.online;
  }
  async send(sessionId: string, text: string) {
    this.sent.push([sessionId, text]);
    return this.online;
  }
  /** Each steer: session, turn, request id (the queued item's), text. */
  steers: [string, string, string, string][] = [];
  async steer(sessionId: string, turnId: string, requestId: string, text: string) {
    this.steers.push([sessionId, turnId, requestId, text]);
    return this.online;
  }
  async answer(sessionId: string, questionId: string, answer: Answer) {
    this.answers.push([sessionId, questionId, answer]);
    return this.online;
  }
  stops: string[] = [];
  stopSources: string[] = [];
  async stop(sessionId: string, source: string) {
    this.stops.push(sessionId);
    this.stopSources.push(source);
    return this.online;
  }
}

test("Codex admits queued followups only after turn end and harness capacity", async () => {
  const { context, adapter, engine, emit, workflow, harness, agent, runnerId } = await setup(chatThenStep);
  await context.db.update(harnessesTable).set({ kind: "codex", permissionMode: "default", maxWorking: 1 }).where(eq(harnessesTable.id, harness.id));
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Ask what to build.", config: { kind: "manual", placement: "chat" } }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const chat = async () => (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)))[0]!;
  const queuedAudit = () => context.db.select().from(audit).where(and(eq(audit.jobId, runId), eq(audit.action, "job.queued")));
  const session = adapter.starts[0]!.start.sessionId;
  await engine.sendChat(runId, "First followup");
  await engine.sendChat(runId, "Second followup");
  expect(adapter.sent).toEqual([]);
  await emit(session, { type: "turn-start", turnId: "initial", interruptible: true });
  await emit(session, { type: "question", questionId: "approval", payload: { kind: "confirm-outputs", values: {} } });
  const otherRun = await engine.startRun(workflow.id);
  expect((await runOf(engine, otherRun)).steps.n_chat!.working).toBe(true);
  vi.spyOn(adapter, "interrupt").mockImplementation(async () => {
    await emit(session, { type: "turn-end", turnId: "initial" });
    return "requested";
  });
  await engine.interruptChat(runId, "initial");
  expect(adapter.sent).toEqual([]);
  expect(await chat()).toMatchObject({ working: false, queueClass: "person", pendingAction: { kind: "deliver" } });
  const queuedAt = (await chat()).queuedAt;
  expect(await queuedAudit()).toHaveLength(1);
  await engine.reconcile(runnerId, adapter.starts.map(({ start }) => start.sessionId));
  expect((await chat()).queuedAt).toEqual(queuedAt);
  expect(await queuedAudit()).toHaveLength(1);
  await engine.stopRun(otherRun);
  await vi.waitFor(() => expect(adapter.sent).toEqual([[session, "First followup"]]));
  await engine.sendChat(runId, "Third followup");
  expect(adapter.sent).toHaveLength(1);
  await emit(session, { type: "turn-start", turnId: "next", interruptible: true });
  await emit(session, { type: "turn-end", turnId: "next" });
  await vi.waitFor(() => expect(adapter.sent).toEqual([[session, "First followup"], [session, "Second followup"]]));
});

test("Codex retries only its admitted input after an engine restart", async () => {
  const { context, adapter, engine, emit, workflow, harness, runnerId } = await setup(chatThenStep);
  await context.db.update(harnessesTable).set({ kind: "codex", permissionMode: "default", maxWorking: 1 }).where(eq(harnessesTable.id, harness.id));
  const runId = await engine.startRun(workflow.id);
  const session = adapter.starts[0]!.start.sessionId;
  await emit(session, { type: "turn-start", turnId: "initial", interruptible: true });
  await emit(session, { type: "turn-end", turnId: "initial" });
  adapter.online = false;
  await engine.sendChat(runId, "Retry me");
  await vi.waitFor(() => expect(adapter.sent).toEqual([[session, "Retry me"]]));
  await engine.sendChat(runId, "Later");
  const restarted = new Engine(context.db, adapter);
  onTestFinished(() => restarted.stop());
  adapter.online = true;
  await restarted.reconcile(runnerId, [session]);
  await vi.waitFor(async () => {
    const rows = await context.db.select().from(messages).where(eq(messages.runId, runId)).orderBy(messages.position);
    expect(rows[0]!.deliveredAt).not.toBeNull();
    expect(rows[1]!.deliveredAt).toBeNull();
  });
  await restarted.reconcile(runnerId, [session]);
  expect(adapter.sent).toEqual([[session, "Retry me"], [session, "Retry me"]]);
  await restarted.onHarnessEvent(session, { type: "turn-start", turnId: "retry", interruptible: true }, { runnerId, seq: 100 });
  await restarted.onHarnessEvent(session, { type: "turn-end", turnId: "retry" }, { runnerId, seq: 101 });
  await vi.waitFor(() => expect(adapter.sent.at(-1)).toEqual([session, "Later"]));
  expect(adapter.sent).toHaveLength(3);
});

test("cloud continuation queue entry has person priority and one audit event", async () => {
  const { context, adapter, engine, workflow, harness, agent } = await setup(chatThenStep);
  await context.db.update(harnessesTable).set({ maxWorking: 1 }).where(eq(harnessesTable.id, harness.id));
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const session = adapter.starts[0]!.start.sessionId;
  await context.db.update(stepRuns).set({ runnerId: CLOUD_SOURCE }).where(eq(stepRuns.sessionId, session));
  const queuedAudit = () => context.db.select().from(audit).where(and(eq(audit.jobId, runId), eq(audit.action, "job.queued")));
  expect(await engine.claimCloudTurn(session)).toBe(true);
  expect(await queuedAudit()).toHaveLength(0);
  await engine.onHarnessEvent(session, { type: "turn-start", turnId: "first", interruptible: true }, { runnerId: CLOUD_SOURCE, seq: 1 });
  await engine.onHarnessEvent(session, { type: "turn-end", turnId: "first" }, { runnerId: CLOUD_SOURCE, seq: 2 });
  await engine.startRun(workflow.id);
  expect(await engine.claimCloudTurn(session)).toBe(false);
  expect(await Promise.all([engine.claimCloudTurn(session), engine.claimCloudTurn(session)])).toEqual([false, false]);
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  expect(step).toMatchObject({ queueClass: "person", working: false, pendingAction: { kind: "deliver" } });
  expect(await queuedAudit()).toHaveLength(1);
});

test("Codex admits a resumed question's answer before queued chat messages", async () => {
  const { context, adapter, engine, emit, workflow, harness, runnerId } = await setup(chatThenStep);
  await context.db.update(harnessesTable).set({ kind: "codex", permissionMode: "default", maxWorking: 1 }).where(eq(harnessesTable.id, harness.id));
  const runId = await engine.startRun(workflow.id);
  const session = adapter.starts[0]!.start.sessionId;
  await emit(session, { type: "cli-session", cliSessionId: "cli_saved" });
  await emit(session, { type: "turn-start", turnId: "initial", interruptible: true });
  await emit(session, { type: "question", questionId: "approval", payload: { kind: "confirm-outputs", values: {} } });
  await engine.reconcile(runnerId, []);
  const [question] = await context.db.select().from(questions).where(eq(questions.runId, runId));
  await engine.answer(question!.id, { kind: "confirm-outputs", confirmed: false });
  await engine.sendChat(runId, "Next input");
  expect(adapter.sent).toEqual([]);
  await emit(session, { type: "turn-start", turnId: "resumed", interruptible: true });
  await emit(session, { type: "turn-end", turnId: "resumed" });
  await vi.waitFor(() => expect(adapter.sent).toEqual([[session, "The owner did not confirm your values."]]));
  await emit(session, { type: "turn-start", turnId: "answer", interruptible: true });
  await emit(session, { type: "turn-end", turnId: "answer" });
  await vi.waitFor(() => expect(adapter.sent.at(-1)).toEqual([session, "Next input"]));
});

test("Codex lost-session resume preserves attachment order and does not repeat a completed input", async () => {
  const { context, adapter, engine, emit, workflow, harness, runnerId } = await setup(chatThenStep);
  await context.db.update(harnessesTable).set({ kind: "codex", permissionMode: "default", maxWorking: 1 }).where(eq(harnessesTable.id, harness.id));
  const send = vi.spyOn(adapter, "send");
  const runId = await engine.startRun(workflow.id);
  const session = adapter.starts[0]!.start.sessionId;
  await emit(session, { type: "cli-session", cliSessionId: "cli_saved" });
  await emit(session, { type: "turn-start", turnId: "initial", interruptible: true });
  await emit(session, { type: "turn-end", turnId: "initial" });
  await engine.sendChat(runId, "Completed input");
  await vi.waitFor(() => expect(adapter.sent).toHaveLength(1));
  await emit(session, { type: "turn-start", turnId: "completed", interruptible: true });
  await engine.sendChat(runId, "File input");
  const files = [{ id: "att_saved", name: "notes.txt" }];
  // Sent during the turn, it is queued, and goes with its files at the turn's end.
  await context.db.update(chatQueue).set({ files }).where(and(eq(chatQueue.runId, runId), eq(chatQueue.text, "File input")));
  await engine.sendChat(runId, "After file");
  // The completed input is acknowledged, while queued inputs survive a lost session.
  await emit(session, { type: "turn-end", turnId: "completed" });
  await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith(session, "File input", files));
  await engine.reconcile(runnerId, []);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  expect(adapter.starts[1]!.start.prompt).not.toContain("Completed input");
  expect(adapter.starts[1]!.start.prompt).not.toContain("After file");
  expect(adapter.sent).toHaveLength(2);
  await emit(session, { type: "turn-start", turnId: "resumed", interruptible: true });
  await emit(session, { type: "turn-end", turnId: "resumed" });
  await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith(session, "File input", files));
  await vi.waitFor(() => expect(adapter.sent).toHaveLength(3));
  await emit(session, { type: "turn-start", turnId: "file", interruptible: true });
  await emit(session, { type: "turn-end", turnId: "file" });
  await vi.waitFor(() => expect(adapter.sent.at(-1)).toEqual([session, "After file"]));
});

/** Records each Tool step call; answers with `answer`, or, without one, only when the engine stops (a call under way). */
class FakeTools implements ToolExecutor {
  calls: { step: ToolStep; values: Map<string, ArgValue> }[] = [];
  /** The signal each call got: aborted when its call is cut. */
  signals: AbortSignal[] = [];
  constructor(private readonly answer?: (values: Map<string, ArgValue>) => Awaited<ReturnType<ToolExecutor["run"]>>) {}
  run(_ownerId: string, step: ToolStep, values: Map<string, ArgValue>, signal: AbortSignal): ReturnType<ToolExecutor["run"]> {
    this.calls.push({ step, values });
    this.signals.push(signal);
    if (this.answer) return Promise.resolve(this.answer(values));
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, error: "cancelled" })));
  }
}

async function setup(def: (agentId: string) => WorkflowDef, toolSteps?: ToolExecutor) {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(
    await call(
      router.harnesses.create,
      { name: "Claude", runnerId, kind: "claude-code", permissionMode: "acceptEdits", model: "opus" },
      { context },
    ),
  );
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  // `create_repository(name)`, for Tool steps (`toolId: "tool_gh"`).
  await context.db.insert(tools).values({
    id: "tool_gh",
    ownerId: context.ownerId, workspaceId: context.workspaceId,
    name: "GitHub",
    kind: "http",
    url: "https://mcp.example.com/",
    transport: "streamable-http",
    actions: [{ name: "create_repository", description: "", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
  });
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: def(agent.id) }, { context });
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter, undefined, undefined, toolSteps);
  onTestFinished(() => engine.stop());
  let seq = 0;
  /** Delivers an event as the runner would, numbered like the hub does. */
  const emit = (sessionId: string, event: Parameters<Engine["onHarnessEvent"]>[1]) =>
    engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  return { context, runnerId, harness, agent, workflow, adapter, engine, emit };
}

const chatThenStep = (agentId: string): WorkflowDef => ({
  trigger: {
    type: "manual",
    field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId, prompt: "Ask what to build." },
  },
  steps: [{ id: "n_plan", key: "plan", type: "agent", name: "Plan", agentId, prompt: "Plan {{brief.idea}} for {{brief.audience}}." }],
  edges: [{ from: "n_chat", to: "n_plan" }],
});

const buttonThenStep = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
  steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId, prompt: "Write a note." }],
  edges: [{ from: "n_go", to: "n_note" }],
});

async function runOf(engine: Engine, runId: string) {
  const [run] = await engine.db.select().from(runs).where(eq(runs.id, runId));
  const steps = await engine.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  return { run: run!, steps: Object.fromEntries(steps.map((s) => [s.nodeId, s])) };
}

/** A chat whose first turn is under way, on a Claude Code runner. */
async function busyChat() {
  const env = await setup(chatThenStep);
  const runId = await env.engine.startRun(env.workflow.id);
  const sessionId = env.adapter.starts[0]!.start.sessionId;
  await env.emit(sessionId, { type: "turn-start", turnId: "first", interruptible: true });
  const queue = () => env.engine.db.select().from(chatQueue).where(eq(chatQueue.runId, runId)).orderBy(chatQueue.position);
  const userMessages = async () => (await env.engine.db.select().from(messages).where(and(eq(messages.runId, runId), eq(messages.role, "user"))).orderBy(messages.position)).map((m) => m.text);
  return { ...env, runId, sessionId, queue, userMessages };
}

test("a message sent during a turn is queued, then sent one per turn, under its own id", async () => {
  const { context, adapter, engine, emit, runId, sessionId, runnerId, queue, userMessages } = await busyChat();
  const first = await engine.sendChat(runId, "First queued");
  const second = await engine.sendChat(runId, "Second queued");
  expect(first.queuedId).toBeDefined();
  expect(adapter.sent).toEqual([]);
  expect(await userMessages()).toEqual([]);
  expect((await call(router.runs.get, { runId }, { context })).queue.map((q) => [q.id, q.state, q.text])).toEqual([[first.queuedId, "pending", "First queued"], [second.queuedId, "pending", "Second queued"]]);
  await emit(sessionId, { type: "turn-end", turnId: "first" });
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionId, "First queued"]]));
  const [message] = await engine.db.select().from(messages).where(eq(messages.text, "First queued"));
  expect(message!.id).toBe(first.queuedId);
  expect((await queue()).map((q) => q.state)).toEqual(["dispatched", "pending"]);
  // A replayed turn-end, and a send while the next item still waits, deliver nothing twice.
  await engine.onHarnessEvent(sessionId, { type: "turn-end", turnId: "first" }, { runnerId, seq: 1 });
  await engine.sendChat(runId, "Third queued");
  expect(await userMessages()).toEqual(["First queued"]);
  await emit(sessionId, { type: "turn-start", turnId: "second", interruptible: true });
  await emit(sessionId, { type: "turn-end", turnId: "second" });
  await vi.waitFor(() => expect(adapter.sent.map(([, text]) => text)).toEqual(["First queued", "Second queued"]));
  await emit(sessionId, { type: "turn-start", turnId: "third", interruptible: true });
  await emit(sessionId, { type: "turn-end", turnId: "third" });
  await vi.waitFor(() => expect(adapter.sent.map(([, text]) => text)).toEqual(["First queued", "Second queued", "Third queued"]));
  expect(await userMessages()).toEqual(["First queued", "Second queued", "Third queued"]);
  expect((await call(router.runs.get, { runId }, { context })).queue).toEqual([]);
});

test("an edit or a removal and the dispatch of a queued message have one winner", async () => {
  const { context, adapter, engine, emit, runId, sessionId, userMessages } = await busyChat();
  const { queuedId: kept } = await engine.sendChat(runId, "Draft");
  const { queuedId: dropped } = await engine.sendChat(runId, "Never mind");
  await call(router.runs.editQueued, { runId, queuedId: kept!, text: "Edited" }, { context });
  await call(router.runs.removeQueued, { runId, queuedId: dropped! }, { context });
  await emit(sessionId, { type: "turn-end", turnId: "first" });
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionId, "Edited"]]));
  // Once dispatched, it is the conversation's: neither changes it.
  await expect(call(router.runs.editQueued, { runId, queuedId: kept!, text: "Too late" }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(call(router.runs.removeQueued, { runId, queuedId: kept! }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(call(router.runs.editQueued, { runId, queuedId: dropped!, text: "Back" }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await userMessages()).toEqual(["Edited"]);
  // Racing the turn's end: the edit lands before the dispatch (sent edited) or loses to it (refused, sent as it was).
  await emit(sessionId, { type: "turn-start", turnId: "second", interruptible: true });
  const { queuedId: raced } = await engine.sendChat(runId, "Original");
  const [edit] = await Promise.allSettled([call(router.runs.editQueued, { runId, queuedId: raced!, text: "Raced edit" }, { context }), emit(sessionId, { type: "turn-end", turnId: "second" })]);
  await vi.waitFor(() => expect(adapter.sent).toHaveLength(2));
  expect(adapter.sent[1]![1]).toBe(edit.status === "fulfilled" ? "Raced edit" : "Original");
  expect(await userMessages()).toEqual(["Edited", adapter.sent[1]![1]]);
});

test.each(["claude-code", "codex"] as const)("send now steers a pending queued message into the running %s turn over the runner protocol", async (kind) => {
  const { context, harness, workflow, runnerId } = await setup(chatThenStep);
  if (kind === "codex") await context.db.update(harnessesTable).set({ kind, permissionMode: "default" }).where(eq(harnessesTable.id, harness.id));
  const sent: ServerToRunner[] = [];
  const engine = new Engine(context.db, new CliHarnessAdapter(context.db, { send: (_: string, msg: ServerToRunner) => (sent.push(msg), true) } as unknown as RunnerHub));
  onTestFinished(() => engine.stop());
  let seq = 0;
  const emit = (event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  const runId = await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const sessionId = (sent[0] as Extract<ServerToRunner, { type: "session.start" }>).start.sessionId;
  await emit({ type: "turn-start", turnId: "first", interruptible: true });
  const { queuedId: later } = await engine.sendChat(runId, "Later");
  const { queuedId: now } = await engine.sendChat(runId, "Also this");
  await engine.steerQueued(runId, now!);
  const sends = () => sent.filter((m) => m.type === "session.send");
  await vi.waitFor(() => expect(sends()).toEqual([{ type: "session.send", sessionId, text: "Also this", steer: { turnId: "first", requestId: now } }]));
  const item = async (id: string) => (await context.db.select().from(chatQueue).where(eq(chatQueue.id, id)))[0]!;
  expect((await item(now!)).state).toBe("steering");
  await emit({ type: "steer-result", turnId: "first", requestId: now!, outcome: "steered" });
  expect(await item(now!)).toMatchObject({ state: "dispatched", ackedAt: expect.any(Date) });
  // The one waiting before it goes at the turn's end, as any message.
  expect((await item(later!)).state).toBe("pending");
  await emit({ type: "turn-end", turnId: "first" });
  await vi.waitFor(() => expect(sends().map((m) => [m.text, m.steer])).toEqual([["Also this", { turnId: "first", requestId: now }], ["Later", undefined]]));
  // Claude Code takes it by cutting the running tools; Codex beside them.
  const chat = (await call(router.runs.get, { runId }, { context })).steps.find((s) => s.interactive)!;
  expect(chat.steering).toEqual({ interruptsTools: kind === "claude-code" });
});

test.each([
  ["steered", "before"],
  ["steered", "after"],
  ["queued", "before"],
] as const)("a steer whose result is %s %s the turn's end is delivered once, and the next item waits for it", async (outcome, order) => {
  const { adapter, engine, emit, runId, sessionId, userMessages } = await busyChat();
  await engine.sendChat(runId, "Next");
  const { queuedId: now } = await engine.sendChat(runId, "Now");
  await engine.steerQueued(runId, now!);
  await vi.waitFor(() => expect(adapter.steers).toEqual([[sessionId, "first", now, "Now"]]));
  await emit(sessionId, { type: "steer-result", turnId: "first", requestId: now!, outcome });
  if (outcome === "steered") {
    if (order === "after") await emit(sessionId, { type: "steer-result", turnId: "first", requestId: now!, outcome });
    await emit(sessionId, { type: "turn-end", turnId: "first" });
  } else {
    // The harness holds it as its next message and reports no end of the turn it missed: the
    // next item waits for the end of the turn it starts.
    await emit(sessionId, { type: "turn-start", turnId: "second", interruptible: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.sent).toEqual([]);
    await emit(sessionId, { type: "turn-end", turnId: "second" });
  }
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionId, "Next"]]));
  expect(adapter.steers).toHaveLength(1);
  expect(await userMessages()).toEqual(["Now", "Next"]);
});

test("a steer whose result arrives after the turn's end still lets the next item go", async () => {
  const { adapter, engine, emit, runId, sessionId } = await busyChat();
  await engine.sendChat(runId, "Next");
  const { queuedId: now } = await engine.sendChat(runId, "Now");
  await engine.steerQueued(runId, now!);
  await emit(sessionId, { type: "turn-end", turnId: "first" });
  // Not known yet whether it joined that turn: the next item waits.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(adapter.sent).toEqual([]);
  await emit(sessionId, { type: "steer-result", turnId: "first", requestId: now!, outcome: "steered" });
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionId, "Next"]]));
});

test("a steer claimed before a restart that never reached the runner goes as any message, and the queue moves on", async () => {
  const { adapter, engine, emit, runId, sessionId, runnerId } = await busyChat();
  await engine.sendChat(runId, "Next");
  const { queuedId: now } = await engine.sendChat(runId, "Now");
  adapter.online = false;
  await engine.steerQueued(runId, now!);
  await vi.waitFor(() => expect(adapter.steers).toHaveLength(1));
  // As a restart between the claim and the write leaves it: claimed, never written.
  await engine.db.update(chatQueue).set({ state: "steering" }).where(eq(chatQueue.id, now!));
  adapter.online = true;
  // The live session is reconciled: what it never got is sent again, as any message.
  await engine.reconcile(runnerId, [sessionId]);
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionId, "Now"]]));
  await emit(sessionId, { type: "turn-end", turnId: "first" });
  await emit(sessionId, { type: "turn-start", turnId: "second", interruptible: true });
  await emit(sessionId, { type: "turn-end", turnId: "second" });
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionId, "Now"], [sessionId, "Next"]]));
});

test("a Codex steer its lost session never settled is sent again, as any message, once", async () => {
  const { context, adapter, engine, emit, harness, workflow, runnerId } = await setup(chatThenStep);
  await context.db.update(harnessesTable).set({ kind: "codex", permissionMode: "default" }).where(eq(harnessesTable.id, harness.id));
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.start.sessionId;
  await emit(sessionId, { type: "cli-session", cliSessionId: "cli_saved" });
  await emit(sessionId, { type: "turn-start", turnId: "first", interruptible: true });
  const { queuedId: now } = await engine.sendChat(runId, "Now");
  await engine.steerQueued(runId, now!);
  await vi.waitFor(async () => expect((await engine.db.select().from(messages).where(eq(messages.id, now!)))[0]!.deliveredAt).not.toBeNull());
  await engine.reconcile(runnerId, []);
  const [item] = await engine.db.select().from(chatQueue).where(eq(chatQueue.id, now!));
  expect(item).toMatchObject({ state: "dispatched", ackedAt: null });
  // The resume carries what Codex may never have taken, and nothing sends it again after.
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  expect(adapter.starts[1]!.start.prompt).toContain("The owner wrote: Now");
  await emit(sessionId, { type: "turn-start", turnId: "resumed", interruptible: true });
  await emit(sessionId, { type: "turn-end", turnId: "resumed" });
  expect((await engine.db.select().from(chatQueue).where(eq(chatQueue.id, now!)))[0]!.ackedAt).not.toBeNull();
  expect(adapter.sent).toEqual([]);
  expect(adapter.steers).toHaveLength(1);
});

test.each([1, 2, 3])("send now, an edit, a removal and the turn's end have one winner (round %i)", async () => {
  const { context, adapter, engine, emit, runId, sessionId } = await busyChat();
  const { queuedId } = await engine.sendChat(runId, "Original");
  const [steer, edit, remove] = await Promise.allSettled([
    engine.steerQueued(runId, queuedId!),
    call(router.runs.editQueued, { runId, queuedId: queuedId!, text: "Edited" }, { context }),
    call(router.runs.removeQueued, { runId, queuedId: queuedId! }, { context }),
    emit(sessionId, { type: "turn-end", turnId: "first" }),
  ]);
  const deliveries = () => adapter.steers.length + adapter.sent.length;
  const written = async () => engine.db.select().from(messages).where(eq(messages.id, queuedId!));
  if (remove.status === "fulfilled") {
    expect(steer.status).toBe("rejected");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deliveries()).toBe(0);
    expect(await written()).toEqual([]);
  } else {
    await vi.waitFor(() => expect(deliveries()).toBe(1));
    expect(adapter.steers).toHaveLength(steer.status === "fulfilled" ? 1 : 0);
    const [message] = await written();
    expect(message!.text).toBe(edit.status === "fulfilled" ? "Edited" : "Original");
  }
});

test("send now is refused, leaving the item queued, when no turn runs or the message calls a skill", async () => {
  const { context, adapter, engine, emit, runId, sessionId, queue } = await busyChat();
  const { queuedId: skill } = await engine.sendChat(runId, "/review it");
  const { queuedId: plain } = await engine.sendChat(runId, "Plain");
  await engine.db.update(chatQueue).set({ skillId: "skill_x" }).where(eq(chatQueue.id, skill!));
  // A skill may replace the session: it waits for the turn's end.
  await expect(call(router.runs.steerQueued, { runId, queuedId: skill! }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  await call(router.runs.removeQueued, { runId, queuedId: skill! }, { context });
  // The turn just ended, before its event was applied: nothing to steer into.
  await engine.db.update(stepRuns).set({ turnStatus: "idle" }).where(eq(stepRuns.sessionId, sessionId));
  await expect(call(router.runs.steerQueued, { runId, queuedId: plain! }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await queue()).map((q) => q.state)).toEqual(["removed", "pending"]);
  await emit(sessionId, { type: "turn-end", turnId: "first" });
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionId, "Plain"]]));
  expect(adapter.steers).toEqual([]);
  // Sent, it can't be sent now again.
  await expect(engine.steerQueued(runId, plain!)).rejects.toMatchObject({ code: "NOT_PENDING" });
});

test("a queued message takes its files for the Job, and gives them back when removed", async () => {
  const { context, engine, runId } = await busyChat();
  await engine.db.insert(attachments).values({ id: "att_q", workspaceId: context.workspaceId, ownerId: context.ownerId, name: "notes.txt", mime: "application/octet-stream", size: 3, image: false });
  const { queuedId } = await engine.sendChat(runId, "With a file", undefined, ["att_q"]);
  const file = async () => (await engine.db.select().from(attachments).where(eq(attachments.id, "att_q")))[0]!;
  expect((await file()).jobId).toBe(runId);
  await call(router.runs.removeQueued, { runId, queuedId: queuedId! }, { context });
  expect((await file()).jobId).toBeNull();
});

test("queued messages of a stopped chat fail, saying why; a failed one can be removed", async () => {
  const { context, engine, runId } = await busyChat();
  const { queuedId } = await engine.sendChat(runId, "Later");
  await engine.stopRun(runId);
  const [item] = (await call(router.runs.get, { runId }, { context })).queue;
  expect(item).toMatchObject({ id: queuedId, state: "failed" });
  expect(storedText(item!.error!)).toMatchObject({ key: "engine.chatOver" });
  await call(router.runs.removeQueued, { runId, queuedId: queuedId! }, { context });
  expect((await call(router.runs.get, { runId }, { context })).queue).toEqual([]);
});

test("a queued message survives a restart and goes once its chat is idle", async () => {
  const { context, adapter, engine, runId, sessionId } = await busyChat();
  const { queuedId } = await engine.sendChat(runId, "After restart");
  // The turn ended before the process stopped, which then couldn't send it.
  await engine.db.update(stepRuns).set({ turnStatus: "idle", turnId: null, working: false }).where(eq(stepRuns.sessionId, sessionId));
  await engine.stop();
  const after = new FakeAdapter();
  const recovered = new Engine(context.db, after);
  onTestFinished(() => recovered.stop());
  await recovered.recover();
  await vi.waitFor(() => expect(after.sent).toEqual([[sessionId, "After restart"]]));
  expect((await engine.db.select().from(chatQueue).where(eq(chatQueue.id, queuedId!)))[0]!.state).toBe("dispatched");
  expect(adapter.sent).toEqual([]);
});

test("a cloud chat queues during its turn and sends at the turn's end", async () => {
  const { adapter, engine, runId, sessionId, queue } = await busyChat();
  await engine.db.update(stepRuns).set({ runnerId: CLOUD_SOURCE }).where(eq(stepRuns.sessionId, sessionId));
  await engine.sendChat(runId, "Cloud followup");
  expect(adapter.sent).toEqual([]);
  await engine.onHarnessEvent(sessionId, { type: "turn-end", turnId: "first" }, { runnerId: CLOUD_SOURCE, seq: 100 });
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionId, "Cloud followup"]]));
  expect((await queue()).map((q) => q.state)).toEqual(["dispatched"]);
});

test("chat turn activity follows ordered execution events, not slot allocation or message submission", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.start.sessionId;
  const chat = async () => (await runOf(engine, runId)).steps.n_chat!;
  expect(await chat()).toMatchObject({ working: true, turnStatus: "unknown" });
  await emit(sessionId, { type: "turn-start", turnId: "turn_test", interruptible: true });
  expect((await chat()).turnStatus).toBe("running");
  const runningSeq = (await chat()).eventSeq;
  await engine.onHarnessEvent(sessionId, { type: "turn-end", turnId: "turn_test" }, { runnerId, seq: runningSeq });
  expect((await chat()).turnStatus).toBe("running");
  await emit(sessionId, { type: "turn-end", turnId: "turn_test" });
  expect((await chat()).turnStatus).toBe("idle");
  adapter.online = false;
  await engine.sendChat(runId, "Another request");
  expect((await chat()).turnStatus).toBe("idle");
  await emit(sessionId, { type: "turn-start", turnId: "turn_test", interruptible: true });
  expect((await chat()).turnStatus).toBe("running");
  await engine.stopRun(runId);
  expect(await chat()).toMatchObject({ status: "failed", turnStatus: "idle" });
  await emit(sessionId, { type: "turn-start", turnId: "turn_test", interruptible: true });
  expect((await chat()).turnStatus).toBe("idle");
});

test("chat turn activity remains separate from questions and becomes unknown after session loss", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, sessionId);
  await emit(sessionId, { type: "turn-start", turnId: "turn_test", interruptible: true });
  await emit(sessionId, { type: "question", questionId: "rq_turn", payload: { kind: "confirm-outputs", values: {} } });
  expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ status: "waiting", working: false, turnStatus: "running" });
  await emit(sessionId, { type: "turn-end", turnId: "turn_test" });
  expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ status: "waiting", turnStatus: "idle" });
  await emit(sessionId, { type: "turn-start", turnId: "turn_test", interruptible: true });
  await engine.reconcile(runnerId, []);
  expect((await runOf(engine, runId)).steps.n_chat!.turnStatus).toBe("unknown");
  await emit(sessionId, { type: "turn-start", turnId: "turn_test", interruptible: true });
  expect((await runOf(engine, runId)).steps.n_chat!.turnStatus).toBe("running");
  await emit(sessionId, { type: "outputs-accepted", values: { idea: "test", audience: "teams" } });
  expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ status: "succeeded", turnStatus: "idle" });
});

test("interrupt targets only the active supported turn and expires questions only after acknowledgment", async () => {
  const { adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.start.sessionId;
  const state = async () => (await runOf(engine, runId)).steps.n_chat!;
  expect(await engine.interruptChat(runId, "old")).toEqual({ outcome: "stale" });
  await emit(sessionId, { type: "turn-start", turnId: "one", interruptible: false });
  expect(await engine.interruptChat(runId, "one")).toEqual({ outcome: "stale" });
  await emit(sessionId, { type: "turn-start", turnId: "two", interruptible: true });
  await emit(sessionId, { type: "question", questionId: "rq_interrupt", payload: { kind: "confirm-outputs", values: {} } });
  adapter.online = false;
  expect(await engine.interruptChat(runId, "two")).toEqual({ outcome: "failed" });
  expect((await engine.db.select().from(questions))[0]!.status).toBe("pending");
  adapter.online = true;
  expect(await engine.interruptChat(runId, "two")).toEqual({ outcome: "requested" });
  expect((await engine.db.select().from(questions))[0]).toMatchObject({ status: "expired", answer: null });
  expect(await state()).toMatchObject({ status: "running", turnStatus: "running", interruptible: false, sessionId });
  expect(adapter.stops).toEqual([]);
  expect(adapter.answers).toEqual([]);
  await emit(sessionId, { type: "turn-end", turnId: "one" });
  expect((await state()).turnStatus).toBe("running");
  await emit(sessionId, { type: "turn-end", turnId: "two" });
  expect(await state()).toMatchObject({ status: "running", turnStatus: "idle", working: false, sessionId });
  await emit(sessionId, { type: "turn-start", turnId: "three", interruptible: true });
  expect(await engine.interruptChat(runId, "two")).toEqual({ outcome: "stale" });
  expect(adapter.interrupts).toEqual([[sessionId, "two"], [sessionId, "two"]]);
});

test("a late interrupt acknowledgment cannot withdraw a newer turn's question", async () => {
  const { adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.start.sessionId;
  await emit(sessionId, { type: "turn-start", turnId: "old", interruptible: true });
  await emit(sessionId, { type: "question", questionId: "rq_old", payload: { kind: "confirm-outputs", values: {} } });
  let acknowledge!: (outcome: "requested") => void;
  const held = new Promise<"requested">((resolve) => { acknowledge = resolve; });
  const interrupt = vi.spyOn(adapter, "interrupt").mockImplementation(() => held);
  const requested = engine.interruptChat(runId, "old");
  await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
  // Queued native/cloud input starts its next turn without an idle event for the old one.
  await emit(sessionId, { type: "turn-start", turnId: "new", interruptible: true });
  await emit(sessionId, { type: "question", questionId: "rq_new", payload: { kind: "confirm-outputs", values: {} } });
  acknowledge("requested");
  expect(await requested).toEqual({ outcome: "requested" });
  expect((await engine.db.select().from(questions).where(eq(questions.runnerQuestionId, "rq_old")))[0]!.status).toBe("expired");
  expect((await engine.db.select().from(questions).where(eq(questions.runnerQuestionId, "rq_new")))[0]!.status).toBe("pending");
  expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ turnId: "new", interruptible: true, turnStatus: "running" });
});

test.each([[false, false], [true, false], [false, true], [true, true]])("interrupted slot respects newer accepted input (new input: %s, end before acknowledgment: %s)", async (newInput, endFirst) => {
  const { adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.start.sessionId;
  await engine.sendChat(runId, "First input");
  await emit(sessionId, { type: "turn-start", turnId: "first", interruptible: true });
  let acknowledge!: (outcome: "requested") => void;
  const held = new Promise<"requested">((resolve) => { acknowledge = resolve; });
  const interrupt = vi.spyOn(adapter, "interrupt").mockImplementation(() => held);
  const requested = engine.interruptChat(runId, "first");
  await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
  if (newInput) await engine.sendChat(runId, "New input");
  if (endFirst) await emit(sessionId, { type: "turn-end", turnId: "first" });
  acknowledge("requested");
  await requested;
  if (!endFirst) await emit(sessionId, { type: "turn-end", turnId: "first" });
  expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ turnStatus: "idle", working: newInput });
  expect((await engine.db.select().from(messages).where(eq(messages.role, "user")).orderBy(messages.position)).map((m) => m.text)).toEqual(newInput ? ["First input", "New input"] : ["First input"]);
  if (newInput) {
    await emit(sessionId, { type: "turn-start", turnId: "second", interruptible: true });
    await emit(sessionId, { type: "text", delta: "New answer" });
    await emit(sessionId, { type: "turn-end", turnId: "second" });
    expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ turnStatus: "idle", working: false, interruptAfterPosition: null });
  }
});

test("repeated interrupt cleanup preserves a cloud continuation queued after its turn ended", async () => {
  const { context, adapter, engine, workflow, harness } = await setup(chatThenStep);
  await context.db.update(harnessesTable).set({ maxWorking: 1 }).where(eq(harnessesTable.id, harness.id));
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.start.sessionId;
  await context.db.update(stepRuns).set({ runnerId: CLOUD_SOURCE }).where(eq(stepRuns.sessionId, sessionId));
  let seq = 0;
  const cloudEvent = (event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId: CLOUD_SOURCE, seq: ++seq });
  await cloudEvent({ type: "turn-start", turnId: "first", interruptible: true });
  await engine.sendChat(runId, "Queued before Stop");
  await cloudEvent({ type: "question", questionId: "approval", payload: { kind: "confirm-outputs", values: {} } });
  const otherRun = await engine.startRun(workflow.id);
  expect((await runOf(engine, otherRun)).steps.n_chat!.working).toBe(true);
  let queuedAt: Date | null = null;
  vi.spyOn(adapter, "interrupt").mockImplementation(async () => {
    await cloudEvent({ type: "turn-end", turnId: "first" });
    expect(await engine.claimCloudTurn(sessionId)).toBe(false);
    queuedAt = (await runOf(engine, runId)).steps.n_chat!.queuedAt;
    expect(queuedAt).not.toBeNull();
    return "requested";
  });
  expect(await engine.interruptChat(runId, "first")).toEqual({ outcome: "requested" });
  expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ queuedAt, pendingAction: { kind: "deliver" }, working: false, turnStatus: "idle" });
  // A replayed acknowledgment must leave the same queue position intact too.
  await cloudEvent({ type: "interrupt-result", requestId: "replay", turnId: "first", outcome: "requested" });
  expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ queuedAt, pendingAction: { kind: "deliver" }, working: false });
  await engine.stopRun(otherRun);
  await vi.waitFor(async () => expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ working: true, queuedAt: null }));
});

test("a replayed interrupt acknowledgment withdraws only its matching turn", async () => {
  const { adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.start.sessionId;
  await emit(sessionId, { type: "turn-start", turnId: "current", interruptible: true });
  await emit(sessionId, { type: "question", questionId: "rq_replay", payload: { kind: "confirm-outputs", values: {} } });
  await emit(sessionId, { type: "interrupt-result", requestId: "int_old", turnId: "previous", outcome: "requested" });
  expect((await engine.db.select().from(questions))[0]!.status).toBe("pending");
  await emit(sessionId, { type: "interrupt-result", requestId: "int_current", turnId: "current", outcome: "requested" });
  expect((await engine.db.select().from(questions))[0]).toMatchObject({ status: "expired", answer: null });
  expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ status: "running", turnStatus: "running", interruptible: false });
});

test("a persisted interruption boundary settles a replayed turn-end without the lost acknowledgment", async () => {
  const { adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.start.sessionId;
  await engine.sendChat(runId, "Input");
  await emit(sessionId, { type: "turn-start", turnId: "current", interruptible: true });
  await emit(sessionId, { type: "question", questionId: "rq_interrupted", payload: { kind: "confirm-outputs", values: {} } });
  adapter.interruptOutcome = "failed";
  expect(await engine.interruptChat(runId, "current")).toEqual({ outcome: "failed" });
  // The harness did stop; its persisted end arrives after the request timed out or the server restarted.
  await emit(sessionId, { type: "turn-end", turnId: "current" });
  expect((await engine.db.select().from(questions))[0]).toMatchObject({ status: "expired", answer: null });
  expect((await runOf(engine, runId)).steps.n_chat).toMatchObject({ working: false, turnStatus: "idle", status: "running" });
});

test.each(["requested", "stale", "failed"] as const)("native interruption awaits its correlated acknowledgment (%s)", async (outcome) => {
  const { context, adapter: fake, engine, workflow, runnerId } = await setup(chatThenStep);
  await engine.startRun(workflow.id);
  const sessionId = fake.starts[0]!.start.sessionId;
  const send = vi.fn<(runnerId: string, message: ServerToRunner) => Promise<boolean>>().mockResolvedValue(true);
  const adapter = new CliHarnessAdapter(context.db, { send } as unknown as RunnerHub);
  const pending = adapter.interrupt(sessionId, "turn_native");
  let settled = false;
  void pending.then(() => { settled = true; });
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  const request = send.mock.calls[0]![1] as unknown as { requestId: string };
  expect(settled).toBe(false);
  adapter.acknowledge("different_runner", sessionId, { type: "interrupt-result", requestId: request.requestId, turnId: "turn_native", outcome });
  await Promise.resolve();
  expect(settled).toBe(false);
  adapter.acknowledge(runnerId, sessionId, { type: "interrupt-result", requestId: request.requestId, turnId: "turn_native", outcome });
  expect(await pending).toBe(outcome);
});

test("the agent's model overrides the harness's", async () => {
  const { context, adapter, engine, agent, workflow } = await setup(buttonThenStep);
  await call(router.agents.update, { ...agent, model: "claude-sonnet-4-5" }, { context });
  await engine.startRun(workflow.id);
  expect(adapter.starts[0]!.harness.model).toBe("claude-sonnet-4-5");
});

test("chat run waits for outputs then starts the step with rendered prompt", async () => {
  const { adapter, engine, emit, harness, agent, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);

  expect(adapter.starts).toHaveLength(1);
  const chat = adapter.starts[0]!;
  expect(chat.harness).toEqual({ id: harness.id, runnerId: harness.runnerId, kind: "claude-code", permissionMode: "acceptEdits", model: "opus" });
  expect(chat.start).toEqual({
    sessionId: expect.stringMatching(/^ses_/),
    runKey: expect.stringMatching(new RegExp(`^${runId}-step_`)),
    systemPrompt: agent.systemPrompt,
    prompt: "Ask what to build.",
    expectedOutputs: [
      { name: "idea", type: "string" },
      { name: "audience", type: "string" },
    ],
    interactive: true,
  });

  const chatSession = chat.start.sessionId;
  await emit(chatSession, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(chatSession, { type: "text", delta: "What " });
  await emit(chatSession, { type: "text", delta: "shall we build?" });
  await emit(chatSession, { type: "turn-end" });
  await engine.sendChat(runId, "A chat app for teams");
  expect(adapter.sent).toEqual([[chatSession, "A chat app for teams"]]);
  expect(adapter.starts).toHaveLength(1);

  await emit(chatSession, { type: "outputs-accepted", values: { idea: "a chat app", audience: "teams" } });
  expect(adapter.starts).toHaveLength(2);
  // Each session gets its own folder: the runner refuses to start one in an existing folder.
  expect(adapter.starts[1]!.start.runKey).toMatch(new RegExp(`^${runId}-step_`));
  expect(adapter.starts[1]!.start.runKey).not.toBe(chat.start.runKey);
  expect(adapter.starts[1]!.start).toMatchObject({
    prompt: "Plan a chat app for teams.",
    expectedOutputs: [],
    interactive: false,
  });
  const { steps } = await runOf(engine, runId);
  expect(steps.n_chat).toMatchObject({ status: "succeeded", outputs: { idea: "a chat app", audience: "teams" }, cliSessionId: "cli_1" });
  expect(steps.n_plan).toMatchObject({ status: "running" });

  const transcript = await engine.db.select().from(messages).where(eq(messages.runId, runId)).orderBy(messages.position);
  expect(transcript.map((m) => [m.role, m.text])).toEqual([
    ["assistant", "What shall we build?"],
    ["user", "A chat app for teams"],
  ]);
});

test("step result is stored", async () => {
  const { adapter, engine, emit, workflow } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  // A button trigger completes at once.
  expect(adapter.starts).toHaveLength(1);
  const { sessionId } = adapter.starts[0]!.start;
  expect(adapter.starts[0]!.start.interactive).toBe(false);

  await emit(sessionId, { type: "result", text: "Done: the note." });
  // Delivered twice (at-least-once): handled once.
  await engine.onHarnessEvent(sessionId, { type: "result", text: "Done: the note." }, { runnerId: (adapter.starts[0]!.harness as CliHarness).runnerId, seq: 1 });
  const { run, steps } = await runOf(engine, runId);
  expect(steps.n_note).toMatchObject({ status: "succeeded", outputs: { result: "Done: the note." } });
  expect(steps.n_go).toMatchObject({ status: "succeeded" });
  expect(run.status).toBe("succeeded");
});

test("a step without expected outputs takes the agent's last message as its result, even after submit_outputs", async () => {
  const { adapter, engine, emit, workflow } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  expect(adapter.starts[0]!.start.expectedOutputs).toEqual([]);
  // A runner's Claude Code or Codex offers submit_outputs with no fields: called, it hands back nothing.
  await emit(sessionId, { type: "outputs-accepted", values: {} });
  expect((await runOf(engine, runId)).steps.n_note).toMatchObject({ status: "running" });
  await emit(sessionId, { type: "result", text: "Done: the note." });
  const { run, steps } = await runOf(engine, runId);
  expect(steps.n_note).toMatchObject({ status: "succeeded", outputs: { result: "Done: the note." } });
  expect(run.status).toBe("succeeded");
});

test("events from another runner or a replayed seq are ignored", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  await engine.onHarnessEvent(sessionId, { type: "error", message: "spoofed" }, { runnerId: "runner_other", seq: 99 });
  await emit(sessionId, { type: "text", delta: "a" });
  await engine.onHarnessEvent(sessionId, { type: "text", delta: "a" }, { runnerId, seq: 1 });
  const { run } = await runOf(engine, runId);
  expect(run.status).toBe("running");
  const transcript = await engine.db.select().from(messages).where(eq(messages.runId, runId));
  expect(transcript.map((m) => m.text)).toEqual(["a"]);
});

test("cloud record snapshots update their started tool once and survive transcript reload", async () => {
  const { adapter, engine, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  await engine.db.update(stepRuns).set({ runnerId: CLOUD_SOURCE }).where(eq(stepRuns.sessionId, sessionId));
  const result: RecordToolResult = {
    toolCallId: "call_1", turnId: "turn_1", args: { id: "row_1" },
    record: { kind: "record", tableId: "table_1", rowId: "row_1", fields: [{ id: "field_1", name: "Name", type: "text", value: "Ada" }] },
  };
  await engine.onCloudEvent(sessionId, { type: "turn-start", turnId: "turn_1", interruptible: true }, 1);
  await engine.onCloudEvent(sessionId, { type: "record-start", ...result }, 2);
  const [started] = await engine.db.select().from(messages).where(eq(messages.runId, runId));
  expect(messageView(started!)).toMatchObject({ role: "tool", text: "rows_get" });
  expect(messageView(started!)).not.toHaveProperty("result");
  await engine.onCloudEvent(sessionId, { type: "record-result", ...result }, 3);
  await engine.onCloudEvent(sessionId, { type: "record-result", ...result }, 3);
  const rows = await engine.db.select().from(messages).where(eq(messages.runId, runId));
  expect(rows).toHaveLength(1);
  expect(messageView(rows[0]!)).toMatchObject({ id: started!.id, role: "tool", result });
  expect(messageView(rows[0]!)).not.toHaveProperty("toolCall");
  // A late result from the previous turn cannot replace the saved snapshot.
  await engine.onCloudEvent(sessionId, { type: "turn-start", turnId: "turn_2", interruptible: true }, 4);
  await engine.onCloudEvent(sessionId, { type: "record-result", ...result, record: { ...result.record, fields: [] } }, 5);
  const [reloaded] = await engine.db.select().from(messages).where(eq(messages.id, started!.id));
  expect(messageView(reloaded!).result).toEqual(result);
  // Providers may reuse a call id in a later turn: the earlier card stays unchanged.
  const next = { ...result, turnId: "turn_2", record: { ...result.record, fields: [] } };
  await engine.onCloudEvent(sessionId, { type: "record-start", ...next }, 6);
  await engine.onCloudEvent(sessionId, { type: "record-result", ...next }, 7);
  const all = await engine.db.select().from(messages).where(eq(messages.runId, runId));
  expect(all).toHaveLength(2);
  expect(all.find((row) => row.id === started!.id)!.result).toEqual(result);
  expect(all.find((row) => row.id !== started!.id)!.result).toEqual(next);
});

test("runner events cannot create authoritative record snapshots", async () => {
  const { adapter, engine, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  const forged = { type: "record-start", toolCallId: "call_1", turnId: "turn_1", args: { id: "row_other_owner" } };
  await engine.onHarnessEvent(sessionId, forged as unknown as Parameters<Engine["onHarnessEvent"]>[1], { runnerId, seq: 1 });
  await engine.onCloudEvent(sessionId, forged as Parameters<Engine["onCloudEvent"]>[1], 2);
  await engine.onHarnessEvent(sessionId, { ...forged, type: "record-result", record: { kind: "record", tableId: "other", rowId: "row_other_owner", fields: [] } } as unknown as Parameters<Engine["onHarnessEvent"]>[1], { runnerId, seq: 3 });
  expect(await engine.db.select().from(messages).where(eq(messages.runId, runId))).toEqual([]);
});

test("a runner's error text shaped like a stored message fails the step with its words", async () => {
  const { adapter, engine, emit, workflow } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "error", message: '{"key":"engine.fail.stopped"}' });
  const { steps } = await runOf(engine, runId);
  expect(storedText(steps.n_note!.error!)).toEqual({ text: '{"key":"engine.fail.stopped"}' });
});

test("error fails the run", async () => {
  const { adapter, engine, emit, workflow } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "error", message: "the agent finished without its outputs" });
  const { run, steps } = await runOf(engine, runId);
  expect(steps.n_note).toMatchObject({ status: "failed", error: "the agent finished without its outputs" });
  expect(run).toMatchObject({ status: "failed", error: "the agent finished without its outputs" });
});

/** Waits until the row `where` selects has its delivery recorded. */
async function delivered(engine: Engine, table: typeof questions | typeof messages, id: string) {
  await vi.waitFor(async () => {
    const [row] = await engine.db.select({ at: table.deliveredAt }).from(table).where(eq(table.id, id));
    expect(row!.at).toBeInstanceOf(Date);
  });
}

async function startDelivered(engine: Engine, sessionId: string) {
  await vi.waitFor(async () => {
    const [row] = await engine.db.select({ at: stepRuns.startDeliveredAt }).from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
    expect(row!.at).toBeInstanceOf(Date);
  });
}

test("run survives engine restart", async () => {
  const { context, adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(chatSession, {
    type: "question",
    questionId: "rq_1",
    payload: { kind: "confirm-outputs", values: { idea: "notes", audience: "me" } },
  });
  const [question] = await context.db.select().from(questions).where(eq(questions.runId, runId));
  expect(question).toMatchObject({ status: "pending", placement: "chat", runnerQuestionId: "rq_1" });
  expect((await runOf(engine, runId)).run.status).toBe("waiting");

  // The app restarts: a new engine on the same database.
  const adapter2 = new FakeAdapter();
  const engine2 = new Engine(context.db, adapter2);
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  // The runner comes back still running the chat: nothing to resume.
  await engine2.reconcile(runnerId, [chatSession]);
  expect(adapter2.starts).toEqual([]);

  await engine2.answer(question!.id, { kind: "confirm-outputs", confirmed: true });
  expect(adapter2.answers).toEqual([[chatSession, "rq_1", { kind: "confirm-outputs", confirmed: true }]]);
  await delivered(engine2, questions, question!.id);
  await engine2.onHarnessEvent(chatSession, { type: "outputs-accepted", values: { idea: "notes", audience: "me" } }, { runnerId, seq: 101 });
  const step = adapter2.starts[0]!.start;
  expect(step.prompt).toBe("Plan notes for me.");
  await engine2.onHarnessEvent(step.sessionId, { type: "result", text: "Planned." }, { runnerId, seq: 102 });
  expect((await runOf(engine2, runId)).run.status).toBe("succeeded");
});

test("an answer that didn't reach the runner goes to the live session once it is back", async () => {
  const { context, adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "question", questionId: "rq_1", payload: { kind: "confirm-outputs", values: {} } });
  const [question] = await context.db.select().from(questions).where(eq(questions.runId, runId));
  adapter.online = false;
  await engine.answer(question!.id, { kind: "confirm-outputs", confirmed: true });
  await vi.waitFor(() => expect(adapter.answers).toHaveLength(1));

  adapter.online = true;
  await engine.reconcile(runnerId, [chatSession]);
  await vi.waitFor(() => expect(adapter.answers).toHaveLength(2));
  await delivered(engine, questions, question!.id);
  // Delivered: the next reconcile has nothing to resend.
  await engine.reconcile(runnerId, [chatSession]);
  expect(adapter.answers).toHaveLength(2);
});

test("a runner restart leaves an idle chat asleep until its next message", async () => {
  const { context, adapter, engine, emit, agent, runnerId } = await setup(chatThenStep);
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Chat.", config: { kind: "manual", placement: "chat" } }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const { sessionId } = adapter.starts[0]!.start;
  await startDelivered(engine, sessionId);
  await emit(sessionId, { type: "cli-session", cliSessionId: "cli_chat" });
  await emit(sessionId, { type: "turn-start", turnId: "first", interruptible: true });
  await emit(sessionId, { type: "text", delta: "Hello" });
  await emit(sessionId, { type: "turn-end", turnId: "first" });
  const chat = async () => (await engine.db.select().from(stepRuns).where(eq(stepRuns.sessionId, sessionId)))[0]!;
  const { idleSince } = await chat();
  expect(idleSince).toBeInstanceOf(Date);
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(1);
  expect(await chat()).toMatchObject({ turnStatus: "idle", idleSince });

  await engine.sendChat(runId, "A followup");
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionId, "A followup"]]));
  await emit(sessionId, SESSION_NOT_RUNNING);
  expect(adapter.starts).toHaveLength(2);
  expect(adapter.starts[1]!.start).toMatchObject({ resumeCliSessionId: "cli_chat", prompt: expect.stringContaining("A followup") });
});

test("a session that finished while the runner was away is not resumed", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  await startDelivered(engine, sessionId);
  await emit(sessionId, { type: "cli-session", cliSessionId: "cli_1" });
  // Back online: the hub hands the backlog (the session's result) first, then reconciles.
  await emit(sessionId, { type: "result", text: "Done." });
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(1);
  expect((await runOf(engine, runId)).run.status).toBe("succeeded");
  // Late events of a closed step change nothing.
  await emit(sessionId, { type: "text", delta: "late" });
  await emit(sessionId, { type: "question", questionId: "rq_late", payload: { kind: "confirm-outputs", values: {} } });
  expect(await engine.db.select().from(messages).where(eq(messages.runId, runId))).toEqual([]);
  expect(await engine.db.select().from(questions).where(eq(questions.runId, runId))).toEqual([]);
});

test("runner restart while the app runs: steps resume, and a pending question's later answer reaches them", async () => {
  const { context, adapter, engine, emit, workflow, runnerId } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  await startDelivered(engine, sessionId);
  await emit(sessionId, { type: "cli-session", cliSessionId: "cli_1" });

  // The runner restarted and lost the session: it resumes from its CLI session.
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(2);
  expect(adapter.starts[1]!.start).toMatchObject({ sessionId, resumeCliSessionId: "cli_1", interactive: false, prompt: RESUME_PROMPT });

  // It asks a question, and the runner restarts again before the owner answers.
  await emit(sessionId, {
    type: "question",
    questionId: "rq_1",
    payload: { kind: "permission", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: false },
  });
  await startDelivered(engine, sessionId);
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(3);
  expect(adapter.starts[2]!.start.prompt).toContain("Still waiting for the owner: permission to use Bash");
  const [question] = await context.db.select().from(questions).where(eq(questions.runId, runId));
  expect(question).toMatchObject({ status: "pending", orphaned: true });

  // The answer reaches the resumed session as a message.
  await engine.answer(question!.id, { kind: "permission", decision: "allow" });
  expect(adapter.sent).toEqual([[sessionId, "The owner allowed Bash."]]);
  expect(adapter.answers).toEqual([]);
  await delivered(engine, questions, question!.id);
  await emit(sessionId, { type: "result", text: "Listed." });
  expect((await runOf(engine, runId)).run.status).toBe("succeeded");
});

test("a lost session's resume carries the answers and chat messages it missed, then marks them delivered", async () => {
  const { context, adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(chatSession, {
    type: "question",
    questionId: "rq_1",
    payload: { kind: "choice", questions: [{ question: "Who for?", header: "Audience", options: [{ label: "Teams" }], multiSelect: false }] },
  });
  const [question] = await context.db.select().from(questions).where(eq(questions.runId, runId));
  adapter.online = false;
  await engine.answer(question!.id, { kind: "choice", answers: { "Who for?": "Teams" } });
  await engine.sendChat(runId, "Make it small.");
  const [chat] = await context.db.select().from(messages).where(eq(messages.runId, runId));

  // A restart of the app too: a new engine, and the runner has lost the chat.
  const later = new FakeAdapter();
  const engine2 = new Engine(context.db, later);
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  await engine2.reconcile(runnerId, []);
  expect(later.answers).toEqual([]);
  expect(later.sent).toEqual([]);
  expect(later.starts).toHaveLength(1);
  expect(later.starts[0]!.start).toMatchObject({ sessionId: chatSession, resumeCliSessionId: "cli_1", interactive: true });
  expect(later.starts[0]!.start.prompt).toBe(
    `${RESUME_PROMPT}\n\nThe owner answered: “Who for?”: Teams.\n\nThe owner wrote: Make it small.`,
  );
  await delivered(engine2, questions, question!.id);
  await delivered(engine2, messages, chat!.id);
});

test("a start not written yet is sent once when the runner is back, never twice", async () => {
  const { adapter, engine, workflow, runnerId } = await setup(buttonThenStep);
  adapter.online = false;
  await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  await vi.waitFor(async () => expect(await engine.db.select().from(stepRuns).where(eq(stepRuns.sessionId, sessionId))).toHaveLength(1));

  // Back: the start was never written, so it goes now, as it was.
  adapter.online = true;
  let release!: () => void;
  adapter.hold = new Promise((resolve) => (release = resolve));
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(2);
  expect(adapter.starts[1]!.start).toEqual(adapter.starts[0]!.start);
  // Its write is still under way: another reconcile doesn't send it again.
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(2);
  // The write ends, so the engine can stop when the test does.
  release();
});

const diamond = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
  steps: [
    { id: "n_a", key: "a", type: "agent", name: "A", agentId, prompt: "Do A." },
    { id: "n_b", key: "b", type: "agent", name: "B", agentId, prompt: "Do B." },
    { id: "n_c", key: "c", type: "agent", name: "C", agentId, prompt: "Join {{a.x}} and {{b.y}}." },
  ],
  edges: [
    { from: "n_go", to: "n_a" },
    { from: "n_go", to: "n_b" },
    { from: "n_a", to: "n_c" },
    { from: "n_b", to: "n_c" },
  ],
});

test("parallel branches start together and a join waits for both", async () => {
  const { adapter, engine, emit, workflow } = await setup(diamond);
  const runId = await engine.startRun(workflow.id);
  expect(adapter.starts.map((s) => s.start.prompt).sort()).toEqual(["Do A.", "Do B."]);
  const session = (prompt: string) => adapter.starts.find((s) => s.start.prompt === prompt)!.start.sessionId;
  expect((await runOf(engine, runId)).steps.n_c).toMatchObject({ status: "pending" });

  await emit(session("Do A."), { type: "outputs-accepted", values: { x: "left" } });
  expect(adapter.starts).toHaveLength(2);
  expect((await runOf(engine, runId)).steps.n_c).toMatchObject({ status: "pending" });

  await emit(session("Do B."), { type: "outputs-accepted", values: { y: "right" } });
  expect(adapter.starts).toHaveLength(3);
  expect(adapter.starts[2]!.start.prompt).toBe("Join left and right.");
  expect((await runOf(engine, runId)).steps.n_c).toMatchObject({ status: "running" });
});

const buttonThenTwo = (agentId: string): WorkflowDef => {
  const def = buttonThenStep(agentId);
  def.steps.push({ id: "n_more", key: "more", type: "agent", name: "More", agentId, prompt: "More." });
  def.edges.push({ from: "n_note", to: "n_more" });
  return def;
};

/** A step whose session asked a question, then was lost by the runner and resumed: its question is orphaned. */
async function orphanedQuestion(def: (agentId: string) => WorkflowDef) {
  const ctx = await setup(def);
  const runId = await ctx.engine.startRun(ctx.workflow.id);
  const { sessionId } = ctx.adapter.starts[0]!.start;
  await startDelivered(ctx.engine, sessionId);
  await ctx.emit(sessionId, { type: "cli-session", cliSessionId: "cli_1" });
  await ctx.emit(sessionId, { type: "question", questionId: "rq_1", payload: { kind: "confirm-outputs", values: {} } });
  await ctx.engine.reconcile(ctx.runnerId, []);
  const [question] = await ctx.context.db.select().from(questions).where(eq(questions.runId, runId));
  expect(question).toMatchObject({ status: "pending", orphaned: true });
  return { ...ctx, runId, sessionId, question: question! };
}

test("a step that completes expires its orphaned questions: the run isn't left waiting", async () => {
  const { engine, emit, runId, sessionId, question, adapter } = await orphanedQuestion(buttonThenTwo);
  expect((await runOf(engine, runId)).run.status).toBe("waiting");
  await emit(sessionId, { type: "result", text: "Noted." });
  const [q] = await engine.db.select().from(questions).where(eq(questions.id, question.id));
  expect(q!.status).toBe("expired");
  const { run, steps } = await runOf(engine, runId);
  expect(run.status).toBe("running");
  expect(steps.n_more!.status).toBe("running");
  // Nothing is sent to the finished session.
  await expect(engine.answer(question.id, { kind: "confirm-outputs", confirmed: true })).rejects.toMatchObject({ code: "NOT_PENDING" });
  expect(adapter.sent).toEqual([]);
});

test("a resumed session's new question replaces the orphaned ones", async () => {
  const { engine, emit, runId, sessionId, question } = await orphanedQuestion(buttonThenStep);
  await emit(sessionId, { type: "question", questionId: "rq_2", payload: { kind: "confirm-outputs", values: {} } });
  const rows = await engine.db.select().from(questions).where(eq(questions.runId, runId));
  expect(rows.map((q) => [q.runnerQuestionId, q.status]).sort()).toEqual([
    ["rq_1", "expired"],
    ["rq_2", "pending"],
  ]);
  expect(rows.find((q) => q.id === question.id)!.status).toBe("expired");
  expect((await runOf(engine, runId)).run.status).toBe("waiting");
});

test("an answer racing a reconcile reaches the resumed session, never the lost one", async () => {
  const { context, adapter, engine, emit, workflow, runnerId } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  await startDelivered(engine, sessionId);
  await emit(sessionId, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(sessionId, {
    type: "question",
    questionId: "rq_1",
    payload: { kind: "permission", toolName: "Bash", input: {}, canAlwaysAllow: false },
  });
  const [question] = await context.db.select().from(questions).where(eq(questions.runId, runId));

  // The runner is back without the session; the owner answers while the reconcile runs.
  const reconciled = engine.reconcile(runnerId, []);
  await engine.answer(question!.id, { kind: "permission", decision: "allow" });
  await reconciled;
  await delivered(engine, questions, question!.id);
  // Not as a `session.answer` to the session the runner no longer has...
  expect(adapter.answers).toEqual([]);
  // ...but in the resume prompt, or as a message once the resumed session runs.
  expect(adapter.starts).toHaveLength(2);
  const reached = adapter.starts[1]!.start.prompt.includes("The owner allowed Bash.") || adapter.sent.some(([, t]) => t === "The owner allowed Bash.");
  expect(reached).toBe(true);
});

test("the runner saying a session isn't running resumes it instead of failing the step", async () => {
  const { adapter, engine, emit, workflow } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  await startDelivered(engine, sessionId);
  await emit(sessionId, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(sessionId, SESSION_NOT_RUNNING);
  expect(adapter.starts).toHaveLength(2);
  expect(adapter.starts[1]!.start).toMatchObject({ sessionId, resumeCliSessionId: "cli_1" });
  const { run, steps } = await runOf(engine, runId);
  expect(run.status).toBe("running");
  expect(steps.n_note!.status).toBe("running");
});

test("a start resent to a session the runner already runs doesn't fail the step", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(buttonThenStep);
  adapter.online = false;
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  // The first start did arrive after all (its write was reported lost): the resend is refused.
  adapter.online = true;
  await engine.reconcile(runnerId, []);
  await emit(sessionId, SESSION_ALREADY_RUNNING);
  const { run, steps } = await runOf(engine, runId);
  expect(run.status).toBe("running");
  expect(steps.n_note).toMatchObject({ status: "running", startDeliveredAt: expect.any(Date) });
});

test("a prompt too long once filled in fails its step, and is never sent or resent", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup((agentId) => {
    const def = chatThenStep(agentId);
    (def.steps[0] as AgentStep).prompt = "Plan {{brief.idea}} and again {{brief.idea}} for {{brief.audience}}.";
    return def;
  });
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "outputs-accepted", values: { idea: "x".repeat(150_000), audience: "me" } });
  await vi.waitFor(async () => expect((await runOf(engine, runId)).run.status).toBe("failed"));
  expect(adapter.starts).toHaveLength(1);
  const { run, steps } = await runOf(engine, runId);
  expect(steps.n_plan).toMatchObject({ status: "failed", error: stored("engine.fail.promptTooLong", { length: 300024, max: 200000 }) });
  expect(run.error).toBe(steps.n_plan!.error);
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(1);
});

test("chat sent before the start reached the runner follows the start when the runner is back", async () => {
  const { adapter, engine, workflow, runnerId } = await setup(chatThenStep);
  adapter.online = false;
  const runId = await engine.startRun(workflow.id);
  await engine.sendChat(runId, "Hello");
  const chatSession = adapter.starts[0]!.start.sessionId;
  adapter.online = true;
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(2);
  expect(adapter.starts[1]!.start).toEqual(adapter.starts[0]!.start);
  await vi.waitFor(() => expect(adapter.sent).toEqual([[chatSession, "Hello"], [chatSession, "Hello"]]));
  const [m] = await engine.db.select().from(messages).where(eq(messages.runId, runId));
  await delivered(engine, messages, m!.id);
});

test("a replayed event retries the advance that failed after it was applied", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(buttonThenTwo);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  // The result commits, then advancing fails (say the database dropped the connection).
  const advance = vi.spyOn(engine as unknown as { advance: (id: string) => Promise<void> }, "advance").mockRejectedValueOnce(new Error("down"));
  await expect(emit(sessionId, { type: "result", text: "Noted." })).rejects.toThrow("down");
  expect(adapter.starts).toHaveLength(1);
  advance.mockRestore();
  // The hub didn't ack it: the runner resends the same event, and the run goes on.
  await engine.onHarnessEvent(sessionId, { type: "result", text: "Noted." }, { runnerId, seq: 1 });
  expect(adapter.starts).toHaveLength(2);
  expect((await runOf(engine, runId)).steps.n_more!.status).toBe("running");
});

test("a session stopped for too many waiting messages fails its step with the runner's error", async () => {
  const { adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  const message = "too many messages waiting for the agent: the session was stopped";
  await emit(chatSession, { type: "error", message });
  const { steps } = await runOf(engine, runId);
  expect(steps.n_chat).toMatchObject({ status: "failed", error: message });
});

test("a lost chat resumes with what fits the prompt limit; the rest follows as messages", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "cli-session", cliSessionId: "cli_1" });
  adapter.online = false;
  await engine.sendChat(runId, "a".repeat(100_000));
  await engine.sendChat(runId, "b".repeat(100_000));
  adapter.online = true;
  adapter.sent = [];
  await engine.reconcile(runnerId, []);
  const resumed = adapter.starts.at(-1)!.start;
  expect(resumed.resumeCliSessionId).toBe("cli_1");
  expect(resumed.prompt.length).toBeLessThanOrEqual(TEXT);
  expect(resumed.prompt).toContain("a".repeat(100_000));
  expect(resumed.prompt).not.toContain("b".repeat(1000));
  await vi.waitFor(() => expect(adapter.sent).toEqual([[chatSession, "b".repeat(100_000)]]));
  for (const m of await engine.db.select().from(messages).where(eq(messages.runId, runId))) await delivered(engine, messages, m.id);
  expect((await runOf(engine, runId)).run.status).toBe("running");
});

test("a message the runner rejected for a missing session is carried by the resume", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(chatSession, { type: "turn-end" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Written to the socket, so marked delivered; but the runner had lost the session.
  await engine.sendChat(runId, "Make it short");
  const [m] = await engine.db.select().from(messages).where(and(eq(messages.runId, runId), eq(messages.role, "user")));
  await delivered(engine, messages, m!.id);
  await emit(chatSession, SESSION_NOT_RUNNING);
  const resumed = adapter.starts.at(-1)!.start;
  expect(resumed.resumeCliSessionId).toBe("cli_1");
  expect(resumed.prompt).toContain("The owner wrote: Make it short");
  void runnerId;
});

test("a session lost before its CLI session id came starts again in a fresh folder", async () => {
  const { adapter, engine, workflow, runnerId } = await setup(buttonThenStep);
  await engine.startRun(workflow.id);
  const first = adapter.starts[0]!.start;
  await startDelivered(engine, first.sessionId);
  await engine.reconcile(runnerId, []);
  const again = adapter.starts[1]!.start;
  expect(again.resumeCliSessionId).toBeUndefined();
  expect(again.runKey).not.toBe(first.runKey);
  expect(again.runKey.startsWith(first.runKey)).toBe(true);
  const [row] = await engine.db.select().from(stepRuns).where(eq(stepRuns.sessionId, first.sessionId));
  expect(row!.start!.runKey).toBe(again.runKey);
});

test("a revoked runner fails the steps on it, and no new step starts on it", async () => {
  const { context, adapter, engine, workflow, runnerId } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  await engine.runnerRevoked(runnerId);
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: stored("engine.fail.runnerRevoked") });
  await context.db.update(runners).set({ revokedAt: new Date() }).where(eq(runners.id, runnerId));
  const second = await engine.startRun(workflow.id);
  expect(adapter.starts).toHaveLength(1);
  expect((await runOf(engine, second)).run.status).toBe("failed");
});

test("signed-out runner fails the step with the sign-in message", async () => {
  const { context, adapter, engine, workflow, runnerId, harness } = await setup(buttonThenStep);
  await call(router.harnesses.update, { ...harness, kind: "codex", permissionMode: "default" }, { context });
  const reported = (clis: (typeof runners.$inferSelect)["clis"]) =>
    context.db.update(runners).set({ clis, lastSeenAt: new Date() }).where(eq(runners.id, runnerId));

  await reported({ claude: "2.1.0" });
  const missing = await engine.startRun(workflow.id);
  expect((await runOf(engine, missing)).run).toMatchObject({ status: "failed", error: stored("engine.fail.codexMissing", { runner: "Workstation" }) });

  await reported({ codex: { version: "0.166.0", signedIn: false } });
  const signedOut = await engine.startRun(workflow.id);
  expect((await runOf(engine, signedOut)).run).toMatchObject({
    status: "failed",
    error: stored("engine.fail.codexSignIn", { runner: "Workstation" }),
  });
  expect(adapter.starts).toHaveLength(0);

  await reported({ codex: { version: "0.166.0", signedIn: true } });
  await engine.startRun(workflow.id);
  expect(adapter.starts[0]!.harness).toEqual({ id: harness.id, runnerId, kind: "codex", permissionMode: "default", model: "opus" });
});

test("a Codex step on a runner that never reported starts: the runner decides", async () => {
  const { context, adapter, engine, workflow, harness, runnerId } = await setup(buttonThenStep);
  await call(router.harnesses.update, { ...harness, kind: "codex", permissionMode: "bypassPermissions" }, { context });
  await context.db.update(runners).set({ lastSeenAt: null, clis: {} }).where(eq(runners.id, runnerId));
  await engine.startRun(workflow.id);
  expect(adapter.starts[0]!.harness).toMatchObject({ kind: "codex", permissionMode: "bypassPermissions" });
});

test("a Codex start reaches the runner as a Codex session", async () => {
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_: string, msg: ServerToRunner) => (sent.push(msg), true) } as unknown as RunnerHub;
  const { context } = await setup(buttonThenStep);
  const adapter = new CliHarnessAdapter(context.db, hub);
  const start: StartParams = { sessionId: "ses_1", runKey: "run-1", systemPrompt: "", prompt: "Hi", expectedOutputs: [], interactive: false };
  await adapter.start({ id: "h", runnerId: "r", kind: "codex", permissionMode: "default" }, start);
  expect(parseServerMessage(JSON.stringify(sent[0]))).toMatchObject({ type: "session.start", start: { harness: "codex", permissionMode: "default" } });
});

test("an answer too long to go as words is refused", async () => {
  const { context, adapter, engine, emit, workflow } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "question", questionId: "rq_1", payload: { kind: "confirm-outputs", values: {} } });
  const [q] = await context.db.select().from(questions).where(eq(questions.runId, runId));
  await expect(engine.answer(q!.id, { kind: "confirm-outputs", confirmed: false, feedback: "x".repeat(TEXT) })).rejects.toMatchObject({ code: "INVALID" });
  const [still] = await context.db.select().from(questions).where(eq(questions.id, q!.id));
  expect(still!.status).toBe("pending");
});

test("a runner back without the session: what was written after its last activity is carried by the resume", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(chatSession, { type: "turn-end" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Written to the socket, then the runner restarted before the CLI read it.
  await engine.sendChat(runId, "Make it short");
  const [m] = await engine.db.select().from(messages).where(and(eq(messages.runId, runId), eq(messages.role, "user")));
  await delivered(engine, messages, m!.id);
  await engine.reconcile(runnerId, []);
  const resumed = adapter.starts.at(-1)!.start;
  expect(resumed.resumeCliSessionId).toBe("cli_1");
  expect(resumed.prompt).toContain("The owner wrote: Make it short");
});

test("run uses the version current at start", async () => {
  const { context, adapter, engine, workflow, agent } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  const next = buttonThenStep(agent.id);
  (next.steps[0] as AgentStep).prompt = "Write a poem.";
  next.steps.push({ id: "n_more", key: "more", type: "agent", name: "More", agentId: agent.id, prompt: "More." });
  next.edges.push({ from: "n_note", to: "n_more" });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: next }, { context });

  const first = adapter.starts[0]!.start;
  expect(first.prompt).toBe("Write a note.");
  await engine.onHarnessEvent(first.sessionId, { type: "result", text: "ok" }, { runnerId: (adapter.starts[0]!.harness as CliHarness).runnerId, seq: 1 });
  // The edit added a step, but this run started on the version without it.
  expect(adapter.starts).toHaveLength(1);
  expect((await runOf(engine, runId)).run.status).toBe("succeeded");

  const second = await engine.startRun(workflow.id);
  expect(adapter.starts[1]!.start).toMatchObject({ runKey: expect.stringMatching(new RegExp(`^${second}-`)), prompt: "Write a poem." });
});

test("a job cannot dispatch to the same owner's runner in another workspace", async () => {
  const { context, engine, adapter, runnerId, agent, harness } = await setup(buttonThenStep);
  const { id: triggerId } = await call(router.triggers.create, { agentId: agent.id, name: "Start", instructions: "Begin.", config: { kind: "manual", placement: "button" } }, { context });
  await context.db.insert(workspaces).values({ id: "sibling", organizationId: context.organizationId });
  await context.db.update(agentsTable).set({ workspaceId: "sibling" }).where(eq(agentsTable.id, agent.id));
  const runId = await engine.startJob(triggerId, context.ownerId);
  expect((await runOf(engine, runId)).run.status).toBe("failed");
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(0);

  const selected = await createRunner(context.db, context.ownerId, "Second machine", { organizationId: context.organizationId, workspaceId: "sibling" });
  const paired = await pair(context.db, selected.pairingCode);
  // The agent's harness and runner of its own workspace.
  await context.db.update(harnessesTable).set({ runnerId: paired.runnerId, workspaceId: "sibling" }).where(eq(harnessesTable.id, harness.id));
  const next = await engine.startJob(triggerId, context.ownerId);
  expect(adapter.starts[0]!.harness).toMatchObject({ runnerId: paired.runnerId });
  await engine.onHarnessEvent(adapter.starts[0]!.start.sessionId, { type: "result", text: "done" }, { runnerId: paired.runnerId, seq: 1 });
  expect((await runOf(engine, next)).run.status).toBe("succeeded");
});

test("reconnecting does not deliver an offline session whose workspace differs from the runner", async () => {
  const { context, engine, adapter, runnerId, workflow } = await setup(buttonThenStep);
  adapter.online = false;
  const runId = await engine.startRun(workflow.id);
  expect(adapter.starts).toHaveLength(1);
  await context.db.insert(workspaces).values({ id: "sibling", organizationId: context.organizationId });
  await context.db.update(runs).set({ workspaceId: "sibling" }).where(eq(runs.id, runId));
  const sessionId = adapter.starts[0]!.start.sessionId;
  await engine.onHarnessEvent(sessionId, { type: "result", text: "done" }, { runnerId, seq: 1 });
  expect((await runOf(engine, runId)).run.status).toBe("running");
  adapter.online = true;
  await engine.reconcile(runnerId, [sessionId]);
  expect(adapter.starts).toHaveLength(1);
  expect((await runOf(engine, runId)).run.status).toBe("failed");
  expect(adapter.stops).toContain(sessionId);
});

test("jobs keep the source workspace when the resource owner changes organizations", async () => {
  const { context, engine, workflow, agent } = await setup(buttonThenStep);
  const { id: triggerId } = await call(router.triggers.create, { agentId: agent.id, name: "Start", instructions: "Begin.", config: { kind: "manual", placement: "button" } }, { context });
  await context.db.delete(organizationMembers).where(eq(organizationMembers.userId, context.ownerId));
  await context.db.insert(organizations).values({ id: "another-org" });
  await context.db.insert(workspaces).values({ id: "another-workspace", organizationId: "another-org" });
  await context.db.insert(organizationMembers).values({ organizationId: "another-org", userId: context.ownerId, role: "owner" });
  const workflowRun = await engine.startRun(workflow.id);
  const agentRun = await engine.startJob(triggerId, context.ownerId);
  const placed = await context.db.select({ id: runs.id, workspaceId: runs.workspaceId }).from(runs);
  expect(placed).toHaveLength(2);
  expect(placed).toEqual(expect.arrayContaining([workflowRun, agentRun].map((id) => ({ id, workspaceId: context.workspaceId }))));
  // A new workflow goes to the only workspace the person can open now, never the one they left.
  const unscoped = await call(router.workflows.create, { name: "Unscoped" }, { context });
  expect((await context.db.select({ workspaceId: workflows.workspaceId }).from(workflows).where(eq(workflows.id, unscoped.id)))[0]!.workspaceId).toBe("another-workspace");
});

test("start refuses a workflow with issues", async () => {
  const { workflow, context } = await setup((agentId) => {
    const def = buttonThenStep(agentId);
    (def.steps[0] as AgentStep).prompt = "{{nobody.x}}";
    return def;
  });
  await expect(call(router.runs.start, { workflowId: workflow.id }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("the CLI adapter builds the runner's session.start from the harness and reports the write", async () => {
  const { context, harness, runnerId } = await setup(buttonThenStep);
  const sent: [string, ServerToRunner][] = [];
  let online = true;
  const hub = {
    send: async (id: string, msg: ServerToRunner) => {
      sent.push([id, msg]);
      return online;
    },
  };
  const adapter = new CliHarnessAdapter(context.db, hub as unknown as RunnerHub);
  const params: StartParams = { sessionId: "ses_x", runKey: "run_1", systemPrompt: "S", prompt: "P", expectedOutputs: [], interactive: false };
  expect(await adapter.start({ ...harness, kind: "claude-code", model: "opus" }, params)).toBe(true);
  expect(sent[0]).toEqual([
    runnerId,
    {
      type: "session.start",
      start: {
        sessionId: "ses_x",
        harness: "claude-code",
        cwd: { mode: "per-run", runKey: "run_1" },
        systemPrompt: "S",
        prompt: "P",
        expectedOutputs: [],
        interactive: false,
        permissionMode: "acceptEdits",
        model: "opus",
        // None until sessions get their agents' skills and tools.
        skills: [],
        mcpServers: [],
      },
    },
  ]);
  // What the adapter sends is what a protocol 2 runner parses.
  expect(parseServerMessage(JSON.stringify(sent[0]![1]))).toEqual(sent[0]![1]);
  online = false;
  expect(await adapter.start({ ...harness, kind: "claude-code" }, params)).toBe(false);
  expect(sent).toHaveLength(2);
});

test("a start whose write wasn't recorded resumes from the CLI session its events reported, not afresh", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(buttonThenStep);
  await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  await startDelivered(engine, sessionId);
  // The server stopped between writing the start and recording it.
  await engine.db.update(stepRuns).set({ startDeliveredAt: null }).where(eq(stepRuns.sessionId, sessionId));
  // The runner restarted too: its backlog brings the CLI session id, and it no longer runs the session.
  await emit(sessionId, { type: "cli-session", cliSessionId: "cli_1" });
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(2);
  expect(adapter.starts[1]!.start).toMatchObject({ sessionId, resumeCliSessionId: "cli_1", prompt: RESUME_PROMPT });
});

test("a chat message is carried by the resume even if the session reported something after it was written", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "cli-session", cliSessionId: "cli_1" });
  await engine.sendChat(runId, "Make it small.");
  const [chat] = await engine.db.select().from(messages).where(eq(messages.runId, runId));
  await delivered(engine, messages, chat!.id);
  // Text the session sent before it read the message arrives after the message was written;
  // then the runner restarts without having read it.
  await emit(chatSession, { type: "text", delta: "Thinking..." });
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(2);
  expect(adapter.starts[1]!.start.prompt).toContain("The owner wrote: Make it small.");
});

test("a chat message sent while the runner's 'not running' resumes the session goes after the resumed start", async () => {
  const { adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "cli-session", cliSessionId: "cli_1" });
  // What the runner sees, in order.
  const order: string[] = [];
  const { start, send } = adapter;
  adapter.start = (h, st) => (order.push("start"), start.call(adapter, h, st));
  adapter.send = (id, text) => (order.push(text), send.call(adapter, id, text));
  const resumed = emit(chatSession, SESSION_NOT_RUNNING);
  await engine.sendChat(runId, "Still there?");
  await resumed;
  // Never written to the lost session before its resume: in the resume prompt, or sent after it.
  await vi.waitFor(() => expect(order[0]).toBe("start"));
  const carried = adapter.starts[1]!.start.prompt.includes("The owner wrote: Still there?");
  if (!carried) await vi.waitFor(() => expect(order).toEqual(["start", "Still there?"]));
});

test("a chat message whose write is under way when the session is found lost is carried by the resume", async () => {
  const { adapter, engine, emit, workflow, runnerId } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chatSession = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chatSession);
  await emit(chatSession, { type: "cli-session", cliSessionId: "cli_1" });
  // The write to the (already lost) session hasn't settled yet.
  let settle!: (ok: boolean) => void;
  adapter.send = async (id, text) => (adapter.sent.push([id, text]), new Promise<boolean>((r) => (settle = r)));
  await engine.sendChat(runId, "Make it small.");
  // It settles once the session is found lost, before the resume reads what to carry: the write
  // went to the lost session, so it proves nothing.
  const internals = engine as unknown as { resume: (step: unknown) => Promise<void> };
  const resume = internals.resume.bind(engine);
  vi.spyOn(internals, "resume").mockImplementationOnce(async (step) => {
    settle(true);
    await new Promise((r) => setTimeout(r, 100));
    return resume(step);
  });
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(2);
  expect(adapter.starts[1]!.start.prompt).toContain("The owner wrote: Make it small.");
});

/** An engine whose cloud sessions run on a CloudRunner with a scripted model; CLI ones go to the fake adapter. */
async function withCloud(context: Awaited<ReturnType<typeof setup>>["context"], adapter: FakeAdapter, texts: string[]) {
  const inputs: unknown[] = [];
  const cloud = new CloudRunner(context.db, context.secrets, {
    tools: noTools,
    client: () => ({ turn: async (input) => {
      inputs.push(input);
      const { onText } = input;
      const text = texts.shift() ?? "";
      onText(text);
      return { text, toolCalls: [], raw: null, stop: "end" };
    } }),
  });
  const engine = new Engine(context.db, new RoutingAdapter(context.db, adapter, cloud), cloud);
  onTestFinished(() => engine.stop());
  cloud.onEvent((sessionId, event, seq) => engine.onCloudEvent(sessionId, event, seq));
  const harness = await call(
    router.harnesses.create,
    { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", model: "m", systemPrompt: "" },
    { context },
  );
  const agent = await call(router.agents.create, { name: "Cloud writer", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  return { engine, cloudAgent: agent, inputs };
}

test("a CLI chat continued on a cloud harness tells the cloud model the conversation so far", async () => {
  const { context, adapter, agent, runnerId, workflow } = await setup(chatThenStep);
  const { engine, cloudAgent, inputs } = await withCloud(context, adapter, ["Hello from the cloud"]);
  const runId = await engine.startRun(workflow.id);
  const old = adapter.starts[0]!.start.sessionId;
  let seq = 0;
  const say = (event: HarnessEvent) => engine.onHarnessEvent(old, event, { runnerId, seq: ++seq });
  await say({ type: "cli-session", cliSessionId: "history" });
  await say({ type: "text", delta: "Earlier answer" });
  await say({ type: "error", message: "Disconnected" });
  await call(router.agents.update, { id: agent.id, name: agent.name, harnessId: cloudAgent.harnessId, systemPrompt: agent.systemPrompt }, { context });
  await engine.sendChat(runId, "Go on in the cloud", undefined, [], true);
  await vi.waitFor(() => expect(JSON.stringify(inputs)).toContain("Go on in the cloud"));
  expect(JSON.stringify(inputs[0])).toContain("You answered: Earlier answer");
});

test("a run whose agent uses a cloud harness completes through CloudRunner", async () => {
  const { context, adapter, workflow, agent } = await setup(buttonThenStep);
  const { engine, cloudAgent } = await withCloud(context, adapter, ["The note."]);
  await call(router.agents.update, { id: agent.id, name: agent.name, harnessId: cloudAgent.harnessId, systemPrompt: agent.systemPrompt }, { context });
  const runId = await engine.startRun(workflow.id);
  await vi.waitFor(async () => expect((await runOf(engine, runId)).run.status).toBe("succeeded"));
  const { steps } = await runOf(engine, runId);
  expect(steps.n_note).toMatchObject({ runnerId: CLOUD_SOURCE, outputs: { result: "The note." }, harness: { type: "cloud", kind: "openai-compatible" } });
  expect(adapter.starts).toHaveLength(0);
});

test("cloud and CLI steps in one run each go to their adapter", async () => {
  const { context, adapter, workflow } = await setup((agentId) => ({
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [
      { id: "n_cli", key: "cli", type: "agent", name: "CLI", agentId, prompt: "On the Workstation." },
      { id: "n_cloud", key: "cloud", type: "agent", name: "Cloud", agentId, prompt: "In the cloud." },
    ],
    edges: [
      { from: "n_go", to: "n_cli" },
      { from: "n_go", to: "n_cloud" },
    ],
  }));
  const { engine, cloudAgent } = await withCloud(context, adapter, ["From the cloud."]);
  const def = (await call(router.workflows.get, { id: workflow.id }, { context })).def as WorkflowDef;
  def.steps = def.steps.map((s) => (s.id === "n_cloud" ? { ...s, agentId: cloudAgent.id } : s));
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def }, { context });
  const runId = await engine.startRun(workflow.id);
  expect(adapter.starts.map((s) => s.start.prompt)).toEqual(["On the Workstation."]);
  await vi.waitFor(async () => expect((await runOf(engine, runId)).steps.n_cloud!.status).toBe("succeeded"));
  expect((await runOf(engine, runId)).run.status).toBe("running");
  // The CLI step's events still come from its runner, through this engine.
  const runnerId = (adapter.starts[0]!.harness as CliHarness).runnerId;
  await engine.onHarnessEvent(adapter.starts[0]!.start.sessionId, { type: "result", text: "From the Workstation." }, { runnerId, seq: 1 });
  const { run, steps } = await runOf(engine, runId);
  expect(run.status).toBe("succeeded");
  expect(steps.n_cli!.outputs).toEqual({ result: "From the Workstation." });
  expect(steps.n_cloud!.outputs).toEqual({ result: "From the cloud." });
});

const approval = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId, prompt: "Ask." } },
  steps: [
    { id: "n_if", key: "if", type: "condition", name: "If", value: { type: "output", nodeId: "n_chat", name: "approved" }, op: "equals", operand: "yes" },
    { id: "n_ship", key: "ship", type: "agent", name: "Ship", agentId, prompt: "Ship it." },
    { id: "n_stop", key: "stop", type: "agent", name: "Stop", agentId, prompt: "Say no." },
  ],
  edges: [
    { from: "n_chat", to: "n_if" },
    { from: "n_if", to: "n_ship", branch: "then" },
    { from: "n_if", to: "n_stop", branch: "else" },
  ],
});

test("if/else runs the matching branch and the run succeeds", async () => {
  const { adapter, engine, emit, workflow } = await setup(approval);
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { approved: "yes" } });
  expect(adapter.starts.map((s) => s.start.prompt)).toEqual(["Ask.", "Ship it."]);
  let state = await runOf(engine, runId);
  expect(state.steps.n_if).toMatchObject({ status: "succeeded", outputs: { matched: "true" } });
  expect(state.steps.n_stop).toMatchObject({ status: "skipped" });
  expect(state.steps.n_stop!.finishedAt).not.toBeNull();
  await emit(adapter.starts[1]!.start.sessionId, { type: "result", text: "done" });
  state = await runOf(engine, runId);
  expect(state.run.status).toBe("succeeded");
});

test("a condition that can't compare fails the run with its reason", async () => {
  const { adapter, engine, emit, workflow } = await setup((agentId) => {
    const def = approval(agentId);
    def.steps[0] = { ...def.steps[0]!, op: "greater_than", operand: "3" } as WorkflowDef["steps"][number];
    return def;
  });
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { approved: "abc" } });
  const state = await runOf(engine, runId);
  expect(state.steps.n_if).toMatchObject({ status: "failed", error: stored("engine.fail.notNumber", { text: "abc" }) });
  expect(state.run).toMatchObject({ status: "failed", error: stored("engine.fail.notNumber", { text: "abc" }) });
});

/** Chat "list" gives `items` → loop "each" over it, body: "do" (`Do {{each.item}}`). */
const forEach = (maxIterations = 20) => (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_chat", key: "list", type: "chat", label: "List", agentId, prompt: "Ask." } },
  steps: [
    { id: "n_each", key: "each", type: "loop", name: "Each", list: { type: "output", nodeId: "n_chat", name: "items" }, maxIterations },
    { id: "n_do", key: "do", type: "agent", name: "Do", agentId, prompt: "Do {{each.item}}.", loopId: "n_each" },
  ],
  edges: [{ from: "n_chat", to: "n_each" }],
});

async function bodyRows(engine: Engine, runId: string) {
  const rows = await engine.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, "n_do")));
  return rows.sort((a, b) => a.iteration - b.iteration);
}

test("each iteration's agent step gets its own session and folder", async () => {
  const { adapter, engine, emit, workflow } = await setup(forEach());
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { items: '["a","b"]' } });
  expect(adapter.starts.map((s) => s.start.prompt)).toEqual(["Ask.", "Do a."]);
  expect((await runOf(engine, runId)).steps.n_each).toMatchObject({ status: "running", sessionId: null });
  // The second iteration opens only once the first is done.
  expect((await bodyRows(engine, runId)).map((r) => r.iteration)).toEqual([1]);
  await emit(adapter.starts[1]!.start.sessionId, { type: "result", text: "did a" });
  expect(adapter.starts.map((s) => s.start.prompt)).toEqual(["Ask.", "Do a.", "Do b."]);
  const rows = await bodyRows(engine, runId);
  expect(rows.map((r) => [r.iteration, r.status])).toEqual([[1, "succeeded"], [2, "running"]]);
  expect(adapter.starts[2]!.start.runKey).toBe(`${runId}-${rows[1]!.id}`);
  expect(adapter.starts[1]!.start.runKey).not.toBe(adapter.starts[2]!.start.runKey);
  await emit(adapter.starts[2]!.start.sessionId, { type: "result", text: "did b" });
  const state = await runOf(engine, runId);
  expect(state.steps.n_each).toMatchObject({
    status: "succeeded",
    outputs: { count: "2", results: JSON.stringify([{ do: { result: "did a" } }, { do: { result: "did b" } }]) },
  });
  expect(state.run.status).toBe("succeeded");
});

test("empty list skips the body", async () => {
  const { adapter, engine, emit, workflow } = await setup(forEach());
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { items: "[]" } });
  expect(await bodyRows(engine, runId)).toEqual([]);
  const state = await runOf(engine, runId);
  expect(state.steps.n_each).toMatchObject({ status: "succeeded", outputs: { count: "0", results: "[]" } });
  expect(state.run.status).toBe("succeeded");
  expect(adapter.starts).toHaveLength(1);
});

test("list over the cap fails before any iteration", async () => {
  const { adapter, engine, emit, workflow } = await setup(forEach(2));
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { items: "[1,2,3]" } });
  expect(await bodyRows(engine, runId)).toEqual([]);
  const state = await runOf(engine, runId);
  expect(state.steps.n_each).toMatchObject({ status: "failed", error: stored("engine.fail.loopTooMany", { items: 3, max: 2 }) });
  expect(state.run).toMatchObject({ status: "failed", error: stored("engine.fail.loopTooMany", { items: 3, max: 2 }) });
  expect(adapter.starts).toHaveLength(1);
});

test("a list that isn't a JSON array fails the loop", async () => {
  const { adapter, engine, emit, workflow } = await setup(forEach());
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { items: "a, b" } });
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: stored("engine.fail.loopNotList", { list: "items" }) });
});

test("a failed iteration fails its loop with the run", async () => {
  const { adapter, engine, emit, workflow } = await setup(forEach());
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { items: '["a","b"]' } });
  await emit(adapter.starts[1]!.start.sessionId, { type: "error", message: "boom" });
  const state = await runOf(engine, runId);
  expect((await bodyRows(engine, runId)).map((r) => [r.iteration, r.status])).toEqual([[1, "failed"]]);
  expect(state.steps.n_each).toMatchObject({ status: "failed", error: "boom" });
  expect(state.run).toMatchObject({ status: "failed", error: "boom" });
});

test("a run waiting in iteration 2 survives an engine restart", async () => {
  const { context, adapter, engine, emit, workflow, runnerId } = await setup(forEach());
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { items: '["a","b"]' } });
  await emit(adapter.starts[1]!.start.sessionId, { type: "result", text: "did a" });
  const second = adapter.starts[2]!.start.sessionId;
  await startDelivered(engine, second);
  await emit(second, { type: "question", questionId: "rq_1", payload: { kind: "choice", questions: [{ question: "Go on?", header: "Go", multiSelect: false, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }] } });
  expect((await runOf(engine, runId)).run.status).toBe("waiting");

  const adapter2 = new FakeAdapter();
  const engine2 = new Engine(context.db, adapter2);
  await engine2.recover();
  await engine2.reconcile(runnerId, [second]);
  expect(adapter2.starts).toEqual([]);
  const [question] = await context.db.select().from(questions).where(eq(questions.runId, runId));
  await engine2.answer(question!.id, { kind: "choice", answers: { "Go on?": "Yes" } });
  await engine2.onHarnessEvent(second, { type: "result", text: "did b" }, { runnerId, seq: 101 });
  const state = await runOf(engine2, runId);
  expect(state.steps.n_each).toMatchObject({ status: "succeeded", outputs: { count: "2" } });
  expect(state.run.status).toBe("succeeded");
});

const createRepo = (name: ToolStep["inputs"][number]["source"], loopId?: string): ToolStep => ({
  id: "n_repo",
  key: "create_repo",
  type: "tool",
  name: "Create repo",
  toolId: "tool_gh",
  action: "create_repository",
  inputs: [{ param: "name", source: name }],
  ...(loopId ? { loopId } : {}),
});

/** Chat "brief" gives `name` → Tool "create_repo" → agent "note" (`Announce {{create_repo.html_url}}.`). */
const chatToolAgent = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId, prompt: "Ask." } },
  steps: [
    createRepo({ type: "output", nodeId: "n_chat", name: "name" }),
    { id: "n_note", key: "note", type: "agent", name: "Note", agentId, prompt: "Announce {{create_repo.html_url}}." },
  ],
  edges: [
    { from: "n_chat", to: "n_repo" },
    { from: "n_repo", to: "n_note" },
  ],
});

test("a tool step's outputs reach the next agent step", async () => {
  const fake = new FakeTools(() => ({ ok: true, outputs: { result: "done", html_url: "https://x" } }));
  const { adapter, engine, emit, workflow } = await setup(chatToolAgent, fake);
  const runId = await engine.startRun(workflow.id);
  // The chat is asked for the parameter's value.
  expect(adapter.starts[0]!.start.expectedOutputs).toEqual([{ name: "name", type: "string", description: "For “name” of GitHub" }]);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "acme" } });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  expect(fake.calls.map((c) => [c.step.id, [...c.values]])).toEqual([["n_repo", [["name", "acme"]]]]);
  expect(adapter.starts[1]!.start.prompt).toBe("Announce https://x.");
  const state = await runOf(engine, runId);
  expect(state.steps.n_repo).toMatchObject({ status: "succeeded", outputs: { result: "done", html_url: "https://x" }, sessionId: null });
});

test("a tool step's error fails the run", async () => {
  const { adapter, engine, emit, workflow } = await setup(chatToolAgent, new FakeTools(() => ({ ok: false, error: stored("tools.call.answeredError", { text: "nope" }) })));
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "acme" } });
  await vi.waitFor(async () => expect((await runOf(engine, runId)).run.status).toBe("failed"));
  const state = await runOf(engine, runId);
  expect(state.steps.n_repo).toMatchObject({ status: "failed", error: stored("tools.call.answeredError", { text: "nope" }) });
  expect(state.run.error).toBe(stored("tools.call.answeredError", { text: "nope" }));
  expect(adapter.starts).toHaveLength(1);
});

test("a tool step in a loop runs once per item", async () => {
  const fake = new FakeTools((values) => ({ ok: true, outputs: { result: `made ${String(values.get("name"))}` } }));
  const def = (agentId: string): WorkflowDef => ({
    trigger: { type: "manual", field: { id: "n_chat", key: "list", type: "chat", label: "List", agentId, prompt: "Ask." } },
    steps: [
      { id: "n_each", key: "each", type: "loop", name: "Each", list: { type: "output", nodeId: "n_chat", name: "items" }, maxIterations: 20 },
      createRepo({ type: "output", nodeId: "n_each", name: "item" }, "n_each"),
    ],
    edges: [{ from: "n_chat", to: "n_each" }],
  });
  const { adapter, engine, emit, workflow } = await setup(def, fake);
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { items: '["a","b"]' } });
  await vi.waitFor(async () => expect((await runOf(engine, runId)).run.status).toBe("succeeded"));
  expect(fake.calls.map((c) => c.values.get("name"))).toEqual(["a", "b"]);
  expect((await runOf(engine, runId)).steps.n_each).toMatchObject({
    outputs: { count: "2", results: JSON.stringify([{ create_repo: { result: "made a" } }, { create_repo: { result: "made b" } }]) },
  });
});

test("the harness event path doesn't wait for a tool call", async () => {
  const fake = new FakeTools();
  const { adapter, engine, emit, workflow } = await setup(chatToolAgent, fake);
  const runId = await engine.startRun(workflow.id);
  // Resolves while the call is still under way.
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "acme" } });
  expect(fake.calls).toHaveLength(1);
  expect((await runOf(engine, runId)).steps.n_repo).toMatchObject({ status: "running", startedAt: expect.any(Date) });
});

test("a tool step running at restart fails without a second call", async () => {
  const fake = new FakeTools();
  const { context, adapter, engine, emit, workflow } = await setup(chatToolAgent, fake);
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "acme" } });
  expect(fake.calls).toHaveLength(1);
  // A stop cuts the call and writes nothing: the step is still running when Dispand comes back.
  await engine.stop();
  expect((await runOf(engine, runId)).steps.n_repo!.status).toBe("running");

  const engine2 = new Engine(context.db, new FakeAdapter(), undefined, undefined, fake);
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  expect(fake.calls).toHaveLength(1);
  const state = await runOf(engine2, runId);
  expect(state.steps.n_repo).toMatchObject({ status: "failed", error: TOOL_RESTARTED });
  expect(state.run).toMatchObject({ status: "failed", error: TOOL_RESTARTED });
});

test("a call that settles after another process failed its step changes nothing", async () => {
  let settle!: () => void;
  const late = new Promise<void>((resolve) => (settle = resolve));
  const fake = new FakeTools();
  fake.run = (_ownerId, step, values) => {
    fake.calls.push({ step, values });
    return late.then(() => ({ ok: true, outputs: { result: "done", html_url: "https://x" } }));
  };
  const { context, adapter, engine, emit, workflow } = await setup(chatToolAgent, fake);
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "acme" } });
  // A crash: another process recovers while this one's call is still under way.
  await new Engine(context.db, new FakeAdapter(), undefined, undefined, fake).recover();
  settle();
  await engine.stop();
  const state = await runOf(engine, runId);
  expect(state.steps.n_repo).toMatchObject({ status: "failed", error: TOOL_RESTARTED, outputs: null });
  expect(adapter.starts).toHaveLength(1);
});

// Jobs: runs of an agent, started by one of its triggers, with their own definition.

async function jobSetup(placement: "chat" | "button" = "button", instructions = "Sort the mail.") {
  const s = await setup(buttonThenStep);
  const trigger = await call(
    router.triggers.create,
    { agentId: s.agent.id, name: "Mail", instructions, config: { kind: "manual", placement } },
    { context: s.context },
  );
  return { ...s, trigger };
}

test("native rules are filtered per CLI on Job starts and re-read after removal on resume", async () => {
  const { context, harness, agent, trigger } = await jobSetup();
  await context.db.update(agentsTable).set({ cliRules: [
    { cli: "claude-code", rule: "Bash(npm test:*)", decision: "allow" },
    { cli: "claude-code", rule: "Edit", decision: "deny" },
    { cli: "codex", rule: "FileChange", decision: "deny" },
    { cli: "claude-code", rule: "Read(//etc/**)", decision: "allow" },
  ] }).where(eq(agentsTable.id, agent.id));
  const sent: ServerToRunner[] = [];
  const adapter = new CliHarnessAdapter(context.db, { send: (_: string, msg: ServerToRunner) => (sent.push(msg), true) } as unknown as RunnerHub, context.secrets);
  const engine = new Engine(context.db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const first = sent[0] as Extract<ServerToRunner, { type: "session.start" }>;
  expect(first.start.rules).toEqual({ allow: ["Bash(npm test:*)"], deny: ["Edit"] });
  await call(router.agents.removeCliRule, { id: agent.id, cli: "claude-code", rule: "Bash(npm test:*)" }, { context });
  const params = { sessionId: first.start.sessionId, runKey: runId, systemPrompt: "S", prompt: "P", expectedOutputs: [], interactive: false, resumeCliSessionId: "cli-1" };
  await adapter.start(harness, params);
  expect(sent[1]).toMatchObject({ start: { rules: { allow: [], deny: ["Edit"] }, resumeCliSessionId: "cli-1" } });
  await adapter.start({ ...harness, kind: "codex", permissionMode: "default" }, params);
  expect(sent[2]).toMatchObject({ start: { rules: { allow: [], deny: ["FileChange"] } } });
  await adapter.start(harness, { ...params, sessionId: "not-a-job" });
  expect(sent[3]).not.toHaveProperty("start.rules");
  expect(first.start.rules).toEqual({ allow: ["Bash(npm test:*)"], deny: ["Edit"] });
});

test.each(["claude-code", "codex"] as const)("%s native approval is offered, saved and sent only to that agent's next Jobs", async (cli) => {
  const { context, engine, agent, starts, harness, runnerId } = await toolingSetup();
  await context.db.update(harnessesTable).set({ kind: cli, permissionMode: "default" }).where(eq(harnessesTable.id, harness.id));
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Work.", config: { kind: "manual", placement: "chat" } }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  const remembers = cli === "codex" ? "Shell=npm test" : "Bash(npm test:*)";
  await engine.onHarnessEvent(starts()[0]!.sessionId, { type: "question", questionId: "native_1", payload: { kind: "permission", toolName: cli === "codex" ? "Shell" : "Bash", input: { command: "npm test" }, canAlwaysAllow: true, remembers } }, { runnerId, seq: 1 });
  const [q] = await context.db.select().from(questions).where(eq(questions.runId, runId));
  expect(q!.remember).toMatchObject({ subject: { kind: "cli", agentId: agent.id, cli, rule: remembers }, scopes: ["run", "always"] });
  await engine.answer(q!.id, { kind: "permission", decision: "allow", remember: "always" }, { type: "user", userId: context.ownerId });
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  expect(starts()[1]!.rules).toEqual({ allow: [remembers], deny: [] });
  await call(router.agents.removeCliRule, { id: agent.id, cli, rule: remembers }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(starts()).toHaveLength(3));
  expect(starts()[2]).not.toHaveProperty("rules");
});

test("a resumed Job merges its run's native rules and refuses denial overflow", async () => {
  const { context, harness, agent, trigger } = await jobSetup();
  const sent: ServerToRunner[] = [];
  const adapter = new CliHarnessAdapter(context.db, { send: (_: string, msg: ServerToRunner) => (sent.push(msg), true) } as unknown as RunnerHub, context.secrets);
  const engine = new Engine(context.db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const first = sent[0] as Extract<ServerToRunner, { type: "session.start" }>;
  const subject = { kind: "cli" as const, agentId: agent.id, cli: "claude-code" as const, rule: "Bash(npm test:*)" };
  await context.db.update(runs).set({ remembered: { allow: [subject, { ...subject, agentId: "another-agent", rule: "Bash" }], deny: [{ ...subject, rule: "Edit" }] } }).where(eq(runs.id, runId));
  await context.db.update(agentsTable).set({ cliRules: [{ cli: "claude-code", rule: subject.rule, decision: "allow" }] }).where(eq(agentsTable.id, agent.id));
  const params = { sessionId: first.start.sessionId, runKey: runId, systemPrompt: "S", prompt: "P", expectedOutputs: [], interactive: false, resumeCliSessionId: "cli-1" };
  await adapter.start(harness, params);
  expect(sent[1]).toMatchObject({ start: { rules: { allow: [subject.rule], deny: ["Edit"] } } });
  await context.db.update(agentsTable).set({ cliRules: Array.from({ length: 200 }, (_, i) => ({ cli: "claude-code" as const, rule: `Bash(command${i})`, decision: "deny" as const })) }).where(eq(agentsTable.id, agent.id));
  await expect(adapter.start(harness, params)).rejects.toThrow("Too many native denial rules");
  expect(sent).toHaveLength(2);
});

test("a manual button Job runs the agent and finishes", async () => {
  const { context, adapter, engine, emit, agent, trigger } = await jobSetup();
  const runId = await engine.startJob(trigger.id, context.ownerId);
  expect(adapter.starts).toHaveLength(1);
  expect(adapter.starts[0]!.start).toMatchObject({ systemPrompt: agent.systemPrompt, prompt: "Sort the mail.", interactive: false });
  expect(adapter.starts[0]!.harness.model).toBe("opus");

  await emit(adapter.starts[0]!.start.sessionId, { type: "result", text: "Sorted." });
  const { run, steps } = await runOf(engine, runId);
  expect(run).toMatchObject({
    status: "succeeded",
    source: "agent",
    workflowId: null,
    agentId: agent.id,
    triggerId: trigger.id,
    cause: { kind: "user", depth: 0 },
    trigger: { type: "manual" },
  });
  expect(run.snapshot).toEqual({ id: agent.id, name: "Writer", harnessId: agent.harnessId, systemPrompt: "Be brief.", skills: [], tools: [], bundles: [], tables: "all", selfLearning: [], consults: [], revision: 0 });
  expect(steps.job).toMatchObject({ status: "succeeded", outputs: { result: "Sorted." } });
});

test("a chat Job talks like a chat trigger", async () => {
  const { context, adapter, engine, trigger } = await jobSetup("chat", "Help with the mail.");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  expect(adapter.starts).toHaveLength(1);
  expect(adapter.starts[0]!.start).toMatchObject({ prompt: "Help with the mail.", interactive: true, expectedOutputs: [] });
  await engine.sendChat(runId, "Anything urgent?");
  expect(adapter.sent).toEqual([[adapter.starts[0]!.start.sessionId, "Anything urgent?"]]);
});

test("two quick starts make two Jobs with distinct sessions", async () => {
  const { context, adapter, engine, trigger } = await jobSetup("chat");
  const [a, b] = await Promise.all([engine.startJob(trigger.id, context.ownerId), engine.startJob(trigger.id, context.ownerId)]);
  expect(a).not.toBe(b);
  expect(adapter.starts).toHaveLength(2);
  const [first, second] = adapter.starts.map((s) => s.start);
  expect(first!.sessionId).not.toBe(second!.sessionId);
  expect(first!.runKey).not.toBe(second!.runKey);
});

test("editing the trigger leaves the running Job's def unchanged", async () => {
  const { context, adapter, engine, trigger } = await jobSetup("chat", "Old instructions.");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await call(router.triggers.update, { id: trigger.id, instructions: "New instructions." }, { context });
  const { run } = await runOf(engine, runId);
  expect(run.def!.trigger.field).toMatchObject({ prompt: "Old instructions." });

  await engine.startJob(trigger.id, context.ownerId);
  expect(adapter.starts[1]!.start.prompt).toBe("New instructions.");
});

test("editing the agent leaves a created Job's session unchanged", async () => {
  const { context, adapter, engine, agent, trigger } = await jobSetup();
  const runId = await engine.db.transaction((tx) =>
    engine.createJob(tx, { ownerId: context.ownerId, agentId: agent.id, triggerId: trigger.id, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } }),
  );
  await call(router.agents.update, { ...agent, systemPrompt: "Be long.", model: "claude-sonnet-4-5" }, { context });
  await engine.continueRun(runId);
  expect(adapter.starts[0]!.start.systemPrompt).toBe("Be brief.");
  expect(adapter.starts[0]!.harness.model).toBe("opus");
});

test("a Job is refused for a disabled trigger or another agent's trigger", async () => {
  const { context, engine, agent, harness, trigger } = await jobSetup();
  const other = await call(router.agents.create, { name: "Other", harnessId: harness.id, systemPrompt: "" }, { context });
  const job = (ownerId: string, agentId: string) =>
    engine.db.transaction((tx) =>
      engine.createJob(tx, { ownerId, agentId, triggerId: trigger.id, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } }),
    );
  await expect(job(context.ownerId, other.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  // Who may start a trigger is `jobs.start`'s check (its workspace, and no other person's Assistant): `rpc/levels.test.ts`.
  await call(router.triggers.update, { id: trigger.id, enabled: false }, { context });
  await expect(job(context.ownerId, agent.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await engine.db.select().from(runs)).toEqual([]);
});

test("recover continues a Job after a restart", async () => {
  const { context, adapter, engine, agent, trigger, runnerId } = await jobSetup();
  // Created, and the app stops before anything started.
  const runId = await engine.db.transaction((tx) =>
    engine.createJob(tx, { ownerId: context.ownerId, agentId: agent.id, triggerId: trigger.id, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } }),
  );
  expect(adapter.starts).toEqual([]);
  const adapter2 = new FakeAdapter();
  const engine2 = new Engine(context.db, adapter2);
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  expect(adapter2.starts).toHaveLength(1);
  expect(adapter2.starts[0]!.start.prompt).toBe("Sort the mail.");
  await engine2.onHarnessEvent(adapter2.starts[0]!.start.sessionId, { type: "result", text: "Sorted." }, { runnerId, seq: 1 });
  expect((await runOf(engine2, runId)).run.status).toBe("succeeded");
});

test("deleting an agent keeps its finished Jobs, their link to it cleared and its name kept", async () => {
  const { context, adapter, engine, emit, agent, workflow, trigger } = await jobSetup();
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await emit(adapter.starts[0]!.start.sessionId, { type: "result", text: "Sorted." });
  expect((await runOf(engine, runId)).run.status).toBe("succeeded");
  const steps = (await runOf(engine, runId)).steps;
  await call(router.workflows.delete, { id: workflow.id }, { context });
  await call(router.agents.update, { id: agent.id, name: "Order drafter", harnessId: agent.harnessId, systemPrompt: "" }, { context });
  await call(router.agents.delete, { id: agent.id }, { context });
  expect(await engine.db.select({ id: runs.id, agentId: runs.agentId, agentName: runs.agentName, status: runs.status }).from(runs)).toEqual([
    { id: runId, agentId: null, agentName: "Order drafter", status: "succeeded" },
  ]);
  // Its steps stay as they were.
  expect((await runOf(engine, runId)).steps).toEqual(steps);
});

// Stopping a run by hand.

test("stopping a run fails its open steps and the run, expires its questions and stops its session", async () => {
  const { context, adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const session = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, session);
  await emit(session, { type: "question", questionId: "rq_1", payload: { kind: "confirm-outputs", values: { idea: "notes", audience: "me" } } });

  await engine.stopRun(runId);
  const { run, steps } = await runOf(engine, runId);
  expect(run).toMatchObject({ status: "failed", error: STOPPED });
  expect(run.finishedAt).toBeInstanceOf(Date);
  expect(steps.n_chat).toMatchObject({ status: "failed", error: STOPPED });
  // A step that never started is closed too: nothing of the run is left open.
  expect(steps.n_plan).toMatchObject({ status: "failed", error: STOPPED });
  expect(await context.db.select({ status: questions.status }).from(questions).where(eq(questions.runId, runId))).toEqual([{ status: "expired" }]);
  await vi.waitFor(() => expect(adapter.stops).toEqual([session]));

  // What the session still says changes nothing, and the chat is over.
  await emit(session, { type: "outputs-accepted", values: { idea: "notes", audience: "me" } });
  await emit(session, { type: "error", message: "Stopped" });
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: STOPPED });
  expect(adapter.starts).toHaveLength(1);
  await expect(engine.sendChat(runId, "hello?")).rejects.toMatchObject({ code: "CLOSED" });
  await expect(engine.stopRun(runId)).rejects.toMatchObject({ code: "CLOSED" });
  await expect(engine.stopRun("run_nobody")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("stopping a chat Job ends it", async () => {
  const { context, adapter, engine, trigger } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await engine.stopRun(runId);
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: STOPPED });
  await vi.waitFor(() => expect(adapter.stops).toEqual([adapter.starts[0]!.start.sessionId]));
});

test("a stop that didn't reach the runner is sent again when the runner is back with the session", async () => {
  const { adapter, engine, workflow, runnerId } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  const session = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, session);
  adapter.online = false;
  await engine.stopRun(runId);
  await vi.waitFor(() => expect(adapter.stops).toEqual([session]));

  adapter.online = true;
  // The runner comes back still running it, and a session whose run is gone (its workflow or
  // agent deleted since): no step of Dispand's is waiting on either, so both are ended.
  await engine.reconcile(runnerId, [session, "ses_gone"]);
  await vi.waitFor(() => expect(adapter.stops).toEqual([session, session, "ses_gone"]));
  expect(adapter.stopSources).toEqual([runnerId, runnerId, runnerId]);
  // Nothing is resumed or started again.
  expect(adapter.starts).toHaveLength(1);
});

test("a reconcile leaves the sessions of steps still going alone", async () => {
  const { adapter, engine, workflow, runnerId } = await setup(buttonThenStep);
  await engine.startRun(workflow.id);
  const session = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, session);
  await engine.reconcile(runnerId, [session]);
  expect(adapter.stops).toEqual([]);
});

test("stopping a run cuts its Tool step's call, and only that run's", async () => {
  const fake = new FakeTools();
  const { adapter, engine, emit, workflow } = await setup(chatToolAgent, fake);
  const first = await engine.startRun(workflow.id);
  const second = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "acme" } });
  await emit(adapter.starts[1]!.start.sessionId, { type: "outputs-accepted", values: { name: "other" } });
  expect(fake.calls).toHaveLength(2);

  await engine.stopRun(first);
  expect(fake.signals.map((s) => s.aborted)).toEqual([true, false]);
  const state = await runOf(engine, first);
  expect(state.steps.n_repo).toMatchObject({ status: "failed", error: STOPPED });
  expect(state.run).toMatchObject({ status: "failed", error: STOPPED });
  expect((await runOf(engine, second)).steps.n_repo!.status).toBe("running");
});

test("a session being resumed when its run is stopped is not started again", async () => {
  const { adapter, engine, workflow, runnerId } = await setup(buttonThenStep);
  const runId = await engine.startRun(workflow.id);
  const session = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, session);
  await engine.onHarnessEvent(session, { type: "cli-session", cliSessionId: "cli_1" }, { runnerId, seq: 1 });
  // The runner comes back without the session, and the owner's stop lands after the reconcile
  // read the step as still going, right before it is resumed.
  const internals = engine as unknown as { resume(step: unknown): Promise<void> };
  const resume = internals.resume.bind(engine);
  internals.resume = async (step) => {
    await engine.stopRun(runId);
    await resume(step);
  };
  await engine.reconcile(runnerId, []);
  await engine.stop();
  // No start follows the stop: a stopped run is never resumed.
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: STOPPED });
  expect(adapter.starts).toHaveLength(1);
});


test("a Job's snapshot keeps the agent's bundles and tables as they were", async () => {
  const { context, engine, agent, trigger } = await jobSetup();
  const table = await call(router.tables.create, { name: "Clients" }, { context });
  await call(router.agents.update, { ...agent, bundles: ["data"], dataTables: [table.id] }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await call(router.agents.update, { ...agent, bundles: [], dataTables: "all" }, { context });
  expect((await runOf(engine, runId)).run.snapshot).toMatchObject({ bundles: ["data"], tables: [table.id] });
});

test("a Job's CLI session start carries the Job's token; a workflow run's has none, and the token is never stored with the step", async () => {
  const { context, harness, runnerId, agent } = await setup(buttonThenStep);
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_id: string, msg: ServerToRunner) => (sent.push(msg), true) };
  const adapter = new CliHarnessAdapter(context.db, hub as unknown as RunnerHub, context.secrets);
  const engine = new Engine(context.db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
  const token = jobTokenOf(context.secrets, run!)!;
  expect(sent[0]).toMatchObject({ type: "session.start", start: { jobToken: token, mcpServers: [] } });
  const [step] = await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, "job")));
  expect(JSON.stringify(step)).not.toContain(token);

  // The runner lost the session: the resumed start carries the token again.
  await vi.waitFor(async () => expect((await context.db.select().from(stepRuns).where(eq(stepRuns.id, step!.id)))[0]!.startDeliveredAt).toBeInstanceOf(Date));
  await engine.reconcile(runnerId, []);
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({ type: "session.start", start: { jobToken: token } });

  // A workflow run's session has no Job, so no token.
  const params: StartParams = { sessionId: "ses_x", runKey: "run_1", systemPrompt: "S", prompt: "P", expectedOutputs: [], interactive: false };
  await adapter.start({ ...harness, kind: "claude-code" }, params);
  expect((sent[2] as { start: Record<string, unknown> }).start).not.toHaveProperty("jobToken");
});

// Sessions get their agent's skills and runner tools.

async function toolingSetup() {
  const s = await setup(buttonThenStep);
  const { context, runnerId, agent } = s;
  await context.db.insert(tools).values({ id: "tool_fetch", ownerId: context.ownerId, workspaceId: context.workspaceId, name: "Fetch", kind: "runner", runnerId, runnerTool: "fetch" });
  const { packageId } = await call(router.skills.create, { name: "review", description: "Reviews.", instructions: "x", requiredToolIds: [] }, { context });
  const withTooling = { ...agent, skillPackageIds: [packageId], toolIds: ["tool_fetch", "tool_gh"] };
  await call(router.agents.update, withTooling, { context });
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_id: string, msg: ServerToRunner) => (sent.push(msg), true) };
  const adapter = new CliHarnessAdapter(context.db, hub as unknown as RunnerHub, context.secrets);
  const engine = new Engine(context.db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const starts = () => sent.flatMap((m) => (m.type === "session.start" ? [m.start] : []));
  return { ...s, engine, packageId, withTooling, starts, sent };
}

test("a Job's CLI start carries its agent's skill packages and runner tools, and never an HTTP tool", async () => {
  const { context, engine, agent, packageId, starts, runnerId } = await toolingSetup();
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  expect(starts()[0]).toMatchObject({
    skills: [{ packageId, name: "review" }],
    // The HTTP tool (GitHub) stays on the server: its address and headers never travel.
    mcpServers: [{ name: runnerServerName({ id: "tool_fetch", runnerId, tool: "fetch" }), type: "runner", tool: "fetch" }],
  });
  expect(JSON.stringify(starts()[0])).not.toContain("mcp.example.com");
});

test("a workflow step's CLI start carries its agent's skills and runner tools too", async () => {
  const { engine, workflow, packageId, starts, runnerId } = await toolingSetup();
  await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  expect(starts()[0]).toMatchObject({ skills: [{ packageId, name: "review" }], mcpServers: [{ name: runnerServerName({ id: "tool_fetch", runnerId, tool: "fetch" }), type: "runner", tool: "fetch" }] });
  expect(starts()[0]).not.toHaveProperty("jobToken");
});

test("a tool of another runner than the harness's is not sent", async () => {
  const { context, engine, workflow, harness, starts } = await toolingSetup();
  // The harness moved to another runner since the tool was attached.
  const other = await call(router.runners.create, { name: "Laptop" }, { context });
  await context.db.update(harnessesTable).set({ runnerId: other.runnerId }).where(eq(harnessesTable.id, harness.id));
  await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  expect(starts()[0]!.mcpServers).toEqual([]);
});

test("a resume carries the tooling as it is then", async () => {
  const { context, engine, workflow, runnerId, withTooling, starts } = await toolingSetup();
  const runId = await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  const [step] = await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, "n_note")));
  await vi.waitFor(async () => expect((await context.db.select().from(stepRuns).where(eq(stepRuns.id, step!.id)))[0]!.startDeliveredAt).toBeInstanceOf(Date));
  // The skill and the tool are taken back, then the runner loses the session.
  await call(router.agents.update, { ...withTooling, skillPackageIds: [], toolIds: [] }, { context });
  await engine.reconcile(runnerId, []);
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  expect(starts()[1]).toMatchObject({ skills: [], mcpServers: [] });
  // Nothing of the tooling is kept with the step.
  expect(JSON.stringify(step!.start)).not.toMatch(/review|fetch/);
});

test("a start only carries the skill packages its runner may fetch", async () => {
  const { context, engine, agent, packageId, withTooling, runnerId, starts } = await toolingSetup();
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  // The Job is created, then its agent moves to a harness on another runner: the Job still
  // starts on the runner of its snapshot's harness, which is no longer served the package.
  const runId = await engine.db.transaction((tx) =>
    engine.createJob(tx, { ownerId: context.ownerId, agentId: agent.id, triggerId: trigger.id, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } }),
  );
  expect(await packageForRunner(context.db, runnerId, packageId)).not.toBeNull();
  const other = await runnerWithClis(context, "Laptop");
  const elsewhere = await call(router.harnesses.create, { name: "Elsewhere", runnerId: other.runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  await call(router.agents.update, { ...withTooling, harnessId: elsewhere.id, toolIds: ["tool_gh"] }, { context });
  expect(await packageForRunner(context.db, runnerId, packageId)).toBeNull();
  await engine.continueRun(runId);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  expect(starts()[0]).toMatchObject({ skills: [], mcpServers: [] });
});

test("a Job's CLI session start names the actions that run unasked, at most 500; a workflow run's names none", async () => {
  const { context, harness, agent } = await setup(buttonThenStep);
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_id: string, msg: ServerToRunner) => (sent.push(msg), true) };
  const adapter = new CliHarnessAdapter(context.db, hub as unknown as RunnerHub, context.secrets);
  const engine = new Engine(context.db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const action = (name: string) => ({ name, description: "", inputSchema: { type: "object" }, readOnly: true as const });
  const toolIds = ["tool_a", "tool_b", "tool_c"];
  for (const id of toolIds) {
    await context.db.insert(tools).values({ id, ownerId: context.ownerId, workspaceId: context.workspaceId, name: id, kind: "http", url: "https://example.com/mcp", transport: "streamable-http", actions: Array.from({ length: 200 }, (_, i) => action(`read_${i}`)) });
  }
  const fields = { id: agent.id, name: agent.name, harnessId: agent.harnessId, systemPrompt: agent.systemPrompt };
  await call(router.agents.update, { ...fields, toolIds: ["tool_a"] }, { context });
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: "tool_a", action: "read_7", permission: "ask" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const unasked = (i: number) => (sent[i] as { start: { unasked?: string[] } }).start.unasked;
  expect(unasked(0)).toHaveLength(199);
  expect(unasked(0)).toContain(exposedName({ id: "tool_a", name: "tool_a" }, "read_8"));
  expect(unasked(0)).not.toContain(exposedName({ id: "tool_a", name: "tool_a" }, "read_7"));

  // More than the protocol carries: the start still goes, with 500 names (the CLI prompts for the rest).
  await call(router.agents.update, { ...fields, toolIds }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(unasked(1)).toHaveLength(500);
  expect(() => parseServerMessage(JSON.stringify(sent[1]))).not.toThrow();

  const params: StartParams = { sessionId: "ses_x", runKey: "run_1", systemPrompt: "S", prompt: "P", expectedOutputs: [], interactive: false };
  await adapter.start({ ...harness, kind: "claude-code" }, params);
  expect((sent[2] as { start: Record<string, unknown> }).start).not.toHaveProperty("unasked");
});

test("a Job's CLI session start lists the agents it may consult, by name, at most 50; an agent that may consult none gets no list", async () => {
  const { context, harness, agent } = await setup(buttonThenStep);
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_id: string, msg: ServerToRunner) => (sent.push(msg), true) };
  const adapter = new CliHarnessAdapter(context.db, hub as unknown as RunnerHub, context.secrets);
  const engine = new Engine(context.db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect((sent[0] as { start: Record<string, unknown> }).start).not.toHaveProperty("consults");

  const consulted = [];
  for (let i = 0; i < 51; i++) {
    consulted.push(await call(router.agents.create, { name: `Expert ${String(i).padStart(2, "0")}`, description: `Knows ${i}`, harnessId: harness.id, systemPrompt: "" }, { context }));
  }
  await context.db.insert(agentConsults).values(consulted.map((c) => ({ agentId: agent.id, consultedId: c.id })));
  await context.db.update(agentsTable).set({ consultMode: "whitelist" }).where(eq(agentsTable.id, agent.id));
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  // More than the protocol carries: the start still goes, with the first 50 by name.
  const consults = (sent[1] as { start: { consults?: unknown[] } }).start.consults;
  expect(consults).toHaveLength(50);
  expect(consults![0]).toEqual({ agentId: consulted[0]!.id, name: "Expert 00", description: "Knows 0" });
  expect(() => parseServerMessage(JSON.stringify(sent[1]))).not.toThrow();
});

test("a Job's session start, its runner events and its question are traced with the Job's id, and none of their words leave", async () => {
  const instructions = "Sort the mail of sentinel-client-name";
  const s = await jobSetup("button", instructions);
  const t = await captureTelemetry();
  onTestFinished(() => stopTelemetry());
  const runId = await s.engine.startJob(s.trigger.id, s.context.ownerId);
  const sessionId = (await vi.waitFor(async () => {
    const [step] = await s.context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    if (!step?.sessionId) throw new Error("not started");
    return step;
  })).sessionId!;
  const start = t.spans().find((x) => x.name === "engine.session.start")!;
  expect(start.attributes).toMatchObject({ "dispand.job.id": runId, "dispand.run.id": runId, "dispand.harness.kind": "claude-code", "dispand.session.id": sessionId });
  await s.emit(sessionId, { type: "text", delta: "sentinel-agent-words" });
  await s.emit(sessionId, { type: "question", questionId: "rq_1", payload: { kind: "permission", toolName: "Bash", input: { command: "echo sentinel-tool-input" }, canAlwaysAllow: false } });
  const event = t.spans().find((x) => x.name === "engine.event")!;
  expect(event.attributes).toMatchObject({ "dispand.event.type": "question", "dispand.job.id": runId });
  // Text deltas are counted, not traced one by one.
  expect(t.spans().filter((x) => x.name === "engine.event")).toHaveLength(1);
  const [q] = await s.context.db.select().from(questions).where(eq(questions.runId, runId));
  await s.engine.answer(q!.id, { kind: "permission", decision: "deny", message: "sentinel-owner-reply" }, { type: "user", userId: s.context.ownerId });
  const points = await t.metrics();
  expect(points).toContainEqual({ name: "dispand.harness.events", attributes: { "dispand.event.type": "text" } });
  expect(points).toContainEqual({ name: "dispand.questions.opened", attributes: { "dispand.question.kind": "approval" } });
  expect(points).toContainEqual({ name: "dispand.questions.answered", attributes: { "dispand.question.kind": "approval", "dispand.answer.decision": "deny", "dispand.answer.by": "user" } });
  expect(points).toContainEqual({ name: "dispand.sessions.started", attributes: { "dispand.harness.kind": "claude-code", "dispand.result": "ok" } });
  const all = await t.all();
  for (const sentinel of ["sentinel-client-name", "sentinel-agent-words", "sentinel-tool-input", "sentinel-owner-reply"]) expect(all).not.toContain(sentinel);
});

test("runner grants start on Jobs and narrowing reaches Job and workflow sessions", async () => {
  const { context, engine, agent, workflow, starts, sent, runnerId } = await toolingSetup();
  const action = { name: "draft_email", description: "", inputSchema: { type: "object" } };
  await context.db.update(tools).set({ actions: [action] }).where(eq(tools.id, "tool_fetch"));
  await context.db.update(agentTools).set({ unasked: [action.name] }).where(and(eq(agentTools.agentId, agent.id), eq(agentTools.toolId, "tool_fetch")));
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  expect(starts()[0]!.mcpServers).toMatchObject([{ unasked: [action.name] }]);
  expect(starts()[1]!.mcpServers[0]).not.toHaveProperty("unasked");
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: "tool_fetch", action: action.name, permission: "ask" }, { context: { ...context, engine } });
  const updates = sent.filter((m) => m.type === "session.permissions");
  expect(updates).toHaveLength(2);
  expect(updates.map((m) => m.sessionId).sort()).toEqual(starts().map((m) => m.sessionId).sort());
  for (const update of updates) expect(update.servers).toEqual([{ name: runnerServerName({ id: "tool_fetch", runnerId, tool: "fetch" }), unasked: [] }]);
  await call(router.agents.setToolPermission, { agentId: agent.id, toolId: "tool_fetch", action: action.name, permission: "off" }, { context: { ...context, engine } });
  const denied = sent.filter((m) => m.type === "session.permissions").slice(2);
  expect(denied).toHaveLength(2);
  for (const update of denied) expect(update.servers).toEqual([{ name: runnerServerName({ id: "tool_fetch", runnerId, tool: "fetch" }), unasked: [], denied: [action.name] }]);
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(starts()).toHaveLength(3));
  expect(starts()[2]!.mcpServers).toMatchObject([{ denied: [action.name] }]);
  expect(starts()[2]!.mcpServers[0]).not.toHaveProperty("unasked");
});


test.each([false, true])("workspace disabling narrows live Job and workflow sessions (skill-only: %s)", async (implicit) => {
  const { context, engine, agent, workflow, withTooling, starts, sent, runnerId } = await toolingSetup();
  const action = { name: "draft_email", description: "", inputSchema: {} };
  await context.db.update(tools).set({ actions: [action] }).where(eq(tools.id, "tool_fetch"));
  if (implicit) {
    const { packageId } = await call(router.skills.create, { name: "mail", description: "Mail", instructions: "Draft", requiredToolIds: ["tool_fetch"] }, { context });
    await call(router.agents.update, { ...withTooling, toolIds: ["tool_gh"], skillPackageIds: [packageId] }, { context });
  }
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  await call(router.tools.setActionEnabled, { toolId: "tool_fetch", action: action.name, enabled: false }, { context: { ...context, engine } });
  const updates = sent.filter((m) => m.type === "session.permissions");
  expect(updates).toHaveLength(2);
  expect(updates.map((m) => m.sessionId).sort()).toEqual(starts().map((m) => m.sessionId).sort());
  for (const update of updates) expect(update.servers).toEqual([{ name: runnerServerName({ id: "tool_fetch", runnerId, tool: "fetch" }), unasked: [], denied: [action.name] }]);
  await call(router.tools.setActionEnabled, { toolId: "tool_fetch", action: action.name, enabled: true }, { context: { ...context, engine } });
  expect(sent.filter((m) => m.type === "session.permissions")).toHaveLength(2);
});


test("workspace disabling narrows the live sessions of another member's agent too", async () => {
  const { context, engine, agent, workflow, starts, sent } = await toolingSetup();
  const action = { name: "draft_email", description: "", inputSchema: {} };
  await context.db.update(tools).set({ actions: [action] }).where(eq(tools.id, "tool_fetch"));
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  await context.db.insert(user).values({ id: "user_bo", name: "Bo", email: "bo@example.com" });
  await context.db.update(agentsTable).set({ ownerId: "user_bo" }).where(eq(agentsTable.id, agent.id));
  await call(router.tools.setActionEnabled, { toolId: "tool_fetch", action: action.name, enabled: false }, { context: { ...context, engine } });
  expect(sent.filter((m) => m.type === "session.permissions")).toHaveLength(2);
});

test("run ceilings and denials are sent on Job and workflow permission updates and resumes", async () => {
  const { context, engine, agent, workflow, starts, sent, runnerId } = await toolingSetup();
  const actions = ["read", "send"].map((name) => ({ name, description: name, inputSchema: {} }));
  await context.db.update(tools).set({ actions }).where(eq(tools.id, "tool_fetch"));
  const [tool] = await context.db.select().from(tools).where(eq(tools.id, "tool_fetch"));
  const subject = { kind: "tool" as const, agentId: agent.id, toolId: tool!.id, action: "read", target: toolPermissionTarget(tool!) };
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const job = await engine.startJob(trigger.id, context.ownerId);
  const run = await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  await context.db.update(runs).set({ remembered: { allow: [subject], deny: [{ ...subject, action: "send" }] } }).where(or(eq(runs.id, job), eq(runs.id, run)));
  await engine.narrowSessions(agent.id, context.db);
  const updates = sent.filter((m) => m.type === "session.permissions");
  expect(updates).toHaveLength(2);
  for (const update of updates) expect(update.servers).toEqual([{ name: runnerServerName({ id: tool!.id, runnerId, tool: "fetch" }), unasked: ["read"], denied: ["send"] }]);
  await vi.waitFor(async () => {
    const steps = await context.db.select().from(stepRuns).where(or(eq(stepRuns.runId, job), eq(stepRuns.runId, run)));
    expect(steps.filter((s) => s.sessionId && s.startDeliveredAt)).toHaveLength(2);
  });
  await engine.reconcile(runnerId, []);
  await vi.waitFor(() => expect(starts()).toHaveLength(4));
  for (const start of starts().slice(2)) expect(start.mcpServers).toMatchObject([{ unasked: ["read"], denied: ["send"] }]);
});


test.each([[["send.email"]], [["send_email"]], [["send.email", "send_email"]]])("Claude startup grants do not authorize an asking action with the same alias: %j", async (names) => {
  const { context, engine, agent, starts } = await toolingSetup();
  await context.db.update(tools).set({ actions: ["send.email", "send_email"].map((name) => ({ name, description: "", inputSchema: {} })) }).where(eq(tools.id, "tool_fetch"));
  await context.db.update(agentTools).set({ unasked: names }).where(and(eq(agentTools.agentId, agent.id), eq(agentTools.toolId, "tool_fetch")));
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  const ref = starts()[0]!.mcpServers[0]!;
  if (names.length === 2) expect(ref).toMatchObject({ unasked: ["send.email", "send_email"] });
  else expect(ref).not.toHaveProperty("unasked");
});

test("retrying a refused Codex start uses the corrected harness in the same Job", async () => {
  const { context, engine, adapter, emit, trigger, harness } = await jobSetup("chat");
  await call(router.harnesses.update, { ...harness, kind: "codex", permissionMode: "bypassPermissions" }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start;
  await emit(old.sessionId, { type: "error", message: "Bypass refused" });
  await expect(engine.sendChat(runId, "First send racing refusal")).rejects.toMatchObject({ code: "CLOSED" });
  await call(router.harnesses.update, { ...harness, kind: "codex", permissionMode: "default" }, { context });
  await engine.sendChat(runId, "Try again.", undefined, [], true);
  await emit(old.sessionId, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  const retry = adapter.starts[1]!;
  expect(retry.harness).toMatchObject({ permissionMode: "default" });
  expect(retry.start.runKey).not.toBe(old.runKey);
  expect(retry.start.prompt).toContain("Try again.");
  const reopened = await runOf(engine, runId);
  expect(reopened.run).toMatchObject({ status: "running", error: null });
  expect(reopened.steps[trigger.id]).toMatchObject({ status: "running", error: null });
  // A person's stop ends the session, not the conversation: the owner can go on in it.
  await engine.stopRun(runId);
  await engine.sendChat(runId, "Again?", undefined, [], true);
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "running", error: null });
});

test("a chat that failed before obtaining a session starts normally on the next owner message", async () => {
  const { context, runnerId, engine, adapter, trigger, harness } = await jobSetup("chat");
  await call(router.harnesses.update, { ...harness, kind: "codex", permissionMode: "default" }, { context });
  await context.db.update(runners).set({ lastSeenAt: new Date(), clis: { claude: "2.1.248" } }).where(eq(runners.id, runnerId));
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const before = await runOf(engine, runId);
  expect(runView(before.run)).toMatchObject({ status: "failed", continuationNodeId: trigger.id });
  expect(storedText(before.run.error!)).toMatchObject({ key: "engine.fail.codexMissing" });
  expect(before.steps[trigger.id]!.sessionId).toBeNull();
  await call(router.harnesses.update, { ...harness, kind: "claude-code", permissionMode: "default" }, { context });
  await context.db.insert(attachments).values({ id: "att_retry", workspaceId: context.workspaceId, ownerId: context.ownerId, name: "notes.txt", mime: "text/plain", size: 3, image: false });
  await engine.sendChat(runId, "Start here", undefined, ["att_retry"], true);
  const [sent] = await context.db.select().from(messages).where(eq(messages.runId, runId));
  expect(sent).toMatchObject({ stepRunId: before.steps[trigger.id]!.id, files: [{ id: "att_retry", name: "notes.txt" }] });
  await vi.waitFor(() => expect(adapter.sent).toEqual([[adapter.starts[0]!.start.sessionId, "Start here"]]));
  const after = await runOf(engine, runId);
  expect(after.run).toMatchObject({ status: "running", error: null });
  expect(after.steps[trigger.id]!.id).toBe(before.steps[trigger.id]!.id);
  await engine.stopRun(runId);
  expect(runView((await runOf(engine, runId)).run)).toMatchObject({ continuationNodeId: trigger.id });
  // Only the owner's explicit continuation reopens it, not a message draining from its queue.
  await expect(engine.sendChat(runId, "Revive?")).rejects.toMatchObject({ code: "CLOSED" });
});

test("a transcript that cannot resume falls back to a fresh session in the same conversation", async () => {
  const { context, adapter, engine, emit, trigger } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start;
  await emit(old.sessionId, { type: "cli-session", cliSessionId: "history" });
  await emit(old.sessionId, { type: "text", delta: "Earlier answer" });
  await emit(old.sessionId, { type: "error", message: "Disconnected" });
  await context.db.insert(attachments).values({ id: "att_go", workspaceId: context.workspaceId, ownerId: context.ownerId, name: "notes.txt", mime: "text/plain", size: 3, image: false });
  await engine.sendChat(runId, "Continue", undefined, ["att_go"], true);
  await emit(old.sessionId, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  const resume = adapter.starts[1]!.start;
  expect(resume.resumeCliSessionId).toBe("history");
  await vi.waitFor(() => expect(adapter.sent.map(([id]) => id)).toContain(resume.sessionId));
  await emit(resume.sessionId, { type: "error", kind: "cannot-resume", message: "Transcript no longer available" });
  await engine.sendChat(runId, "Still here", undefined, [], true);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(3));
  const fresh = adapter.starts[2]!.start;
  expect(fresh).not.toHaveProperty("resumeCliSessionId");
  expect(fresh.runKey).not.toBe(old.runKey);
  // The fresh CLI is told the conversation so far; the turns never answered reach it as messages, files included.
  expect(fresh.prompt).toContain("You answered: Earlier answer");
  expect(fresh.prompt).not.toContain("Continue");
  await vi.waitFor(() => expect(adapter.sent.filter(([id]) => id === fresh.sessionId).map(([, text]) => text)).toEqual(["Continue", "Still here"]));
  const [withFile] = await context.db.select().from(messages).where(and(eq(messages.runId, runId), eq(messages.text, "Continue")));
  expect(withFile).toMatchObject({ files: [{ id: "att_go" }], deliveredAt: expect.any(Date) });
  const view = await call(router.runs.get, { runId }, { context });
  expect(view.messages.map((m) => m.text)).toEqual(["Earlier answer", "Continue", "Still here"]);
});

test("a resume the runner couldn't take starts fresh next time, even once its process has ended", async () => {
  const { context, adapter, engine, emit, trigger } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start;
  await emit(old.sessionId, { type: "cli-session", cliSessionId: "history" });
  await emit(old.sessionId, { type: "error", message: "Disconnected" });
  await engine.sendChat(runId, "Continue", undefined, [], true);
  await emit(old.sessionId, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  const resume = adapter.starts[1]!.start;
  await startDelivered(engine, resume.sessionId);
  await emit(resume.sessionId, { type: "error", kind: "cannot-resume", message: "Transcript no longer available" });
  // The runner says the failed process ended: that is no sign the transcript worked.
  await emit(resume.sessionId, { type: "session-ended" });
  await engine.sendChat(runId, "Still here", undefined, [], true);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(3));
  expect(adapter.starts[2]!.start).not.toHaveProperty("resumeCliSessionId");
  await vi.waitFor(() => expect(adapter.sent).toContainEqual([adapter.starts[2]!.start.sessionId, "Continue"]));
});

test("a resume refused for another reason than its transcript keeps the transcript", async () => {
  const { context, adapter, engine, emit, trigger } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start;
  await emit(old.sessionId, { type: "cli-session", cliSessionId: "history" });
  await emit(old.sessionId, { type: "error", message: "Disconnected" });
  await engine.sendChat(runId, "Continue", undefined, [], true);
  await emit(old.sessionId, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  const resume = adapter.starts[1]!.start;
  await startDelivered(engine, resume.sessionId);
  // Refused before the CLI launched (an MCP server the runner doesn't have): the transcript is still there.
  await emit(resume.sessionId, { type: "error", message: "unknown MCP server" });
  await engine.sendChat(runId, "Still here", undefined, [], true);
  await emit(resume.sessionId, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(3));
  expect(adapter.starts[2]!.start.resumeCliSessionId).toBe("history");
});

test("a resume whose start never reached the runner keeps the transcript", async () => {
  const { context, adapter, engine, emit, trigger } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start;
  await emit(old.sessionId, { type: "cli-session", cliSessionId: "history" });
  await emit(old.sessionId, { type: "error", message: "Disconnected" });
  await engine.sendChat(runId, "Continue", undefined, [], true);
  adapter.online = false;
  await emit(old.sessionId, { type: "session-ended" });
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  await engine.stopRun(runId);
  expect((await context.db.select().from(stepRuns).where(eq(stepRuns.id, step!.id)))[0]).toMatchObject({ startDeliveredAt: null });
  adapter.online = true;
  await engine.sendChat(runId, "Again", undefined, [], true);
  await emit(step!.sessionId!, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts.at(-1)!.start.resumeCliSessionId).toBe("history"));
});

test("a workflow chat goes on after a stop in the same run, and its follow-up then runs once", async () => {
  const { context, adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const first = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, first);
  await emit(first, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(first, { type: "text", delta: "What shall we build?" });
  await engine.stopRun(runId);
  expect((await call(router.runs.get, { runId }, { context })).run).toMatchObject({ status: "failed", continuationNodeId: "n_chat" });
  await engine.sendChat(runId, "A chat app for teams", undefined, [], true);
  expect((await runOf(engine, runId)).steps.n_plan).toMatchObject({ status: "pending", error: null });
  await emit(first, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  const resumed = adapter.starts[1]!.start;
  expect(resumed.resumeCliSessionId).toBe("cli_1");
  await emit(resumed.sessionId, { type: "outputs-accepted", values: { idea: "a chat app", audience: "teams" } });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(3));
  expect(adapter.starts[2]!.start.prompt).toBe("Plan a chat app for teams.");
  await emit(adapter.starts[2]!.start.sessionId, { type: "result", text: "The plan." });
  await vi.waitFor(async () => expect((await runOf(engine, runId)).run.status).toBe("succeeded"));
  expect(adapter.starts).toHaveLength(3);
});

test("a workflow chat that failed goes on in the same run, and its follow-up then runs", async () => {
  const { adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const first = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, first);
  await emit(first, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(first, { type: "text", delta: "What shall we build?" });
  await emit(first, { type: "error", message: "Disconnected" });
  expect((await runOf(engine, runId)).run.status).toBe("failed");
  await engine.sendChat(runId, "A chat app for teams", undefined, [], true);
  await emit(first, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  await emit(adapter.starts[1]!.start.sessionId, { type: "outputs-accepted", values: { idea: "a chat app", audience: "teams" } });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(3));
  expect(adapter.starts[2]!.start.prompt).toBe("Plan a chat app for teams.");
});

test("a finished workflow chat goes on without running its follow-up again", async () => {
  const { context, adapter, engine, emit, workflow } = await setup(chatThenStep);
  const runId = await engine.startRun(workflow.id);
  const chat = adapter.starts[0]!.start.sessionId;
  await startDelivered(engine, chat);
  await emit(chat, { type: "cli-session", cliSessionId: "cli_1" });
  await emit(chat, { type: "outputs-accepted", values: { idea: "notes", audience: "me" } });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  await emit(adapter.starts[1]!.start.sessionId, { type: "result", text: "The plan." });
  await vi.waitFor(async () => expect((await runOf(engine, runId)).run.status).toBe("succeeded"));
  expect((await call(router.runs.get, { runId }, { context })).run).toMatchObject({ continuationNodeId: "n_chat" });
  await engine.sendChat(runId, "One more idea", undefined, [], true);
  await emit(chat, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(3));
  const resumed = adapter.starts[2]!.start;
  expect(resumed).toMatchObject({ resumeCliSessionId: "cli_1", interactive: true });
  await emit(resumed.sessionId, { type: "outputs-accepted", values: { idea: "better notes", audience: "me" } });
  await vi.waitFor(async () => expect((await runOf(engine, runId)).run.status).toBe("succeeded"));
  expect(adapter.starts).toHaveLength(3);
  expect((await runOf(engine, runId)).steps.n_plan).toMatchObject({ status: "succeeded" });
});

test("a message queued before a stop fails without reviving the chat; the owner's next one reopens it", async () => {
  const { context, engine, runId } = await busyChat();
  const { queuedId } = await engine.sendChat(runId, "Later");
  await engine.stopRun(runId);
  expect((await call(router.runs.get, { runId }, { context })).run.status).toBe("failed");
  await engine.sendChat(runId, "Go on", undefined, [], true);
  const view = await call(router.runs.get, { runId }, { context });
  expect(view.run.status).toBe("running");
  expect(view.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["Go on"]);
  expect(view.queue).toMatchObject([{ id: queuedId, state: "failed" }]);
});

test("a finished Job chat reopens with a new token and waits for the old process to exit", async () => {
  const { context, adapter, trigger, runnerId } = await jobSetup("chat");
  const engine = new Engine(context.db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  let seq = 0;
  const emit = (id: string, event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(id, event, { runnerId, seq: ++seq });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start;
  await emit(old.sessionId, { type: "cli-session", cliSessionId: "cli_history" });
  await emit(old.sessionId, { type: "text", delta: "First answer." });
  await emit(old.sessionId, { type: "outputs-accepted", values: {} });
  const before = await runOf(engine, runId);
  const token = jobTokenOf(context.secrets, before.run)!;
  await engine.sendChat(runId, "One more thing.");
  const reopened = await runOf(engine, runId);
  expect(reopened.run).toMatchObject({ status: "running", finishedAt: null });
  expect(reopened.run.rootId).not.toBe(before.run.rootId);
  expect(jobTokenOf(context.secrets, reopened.run)).not.toBe(token);
  expect(await jobOfToken(context.db, token)).toBeNull();
  expect(reopened.steps[trigger.id]).toMatchObject({ id: before.steps[trigger.id]!.id, cliSessionId: "cli_history", status: "running", finishedAt: null });
  expect(reopened.steps[trigger.id]!.sessionId).not.toBe(old.sessionId);
  expect(adapter.stops).toContain(old.sessionId);
  expect(adapter.starts).toHaveLength(1);
  await emit(old.sessionId, { type: "result", text: "Late old result." });
  expect((await runOf(engine, runId)).run.status).toBe("running");
  await emit(old.sessionId, { type: "session-ended" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  const resumed = adapter.starts[1]!.start;
  expect(resumed).toMatchObject({ sessionId: reopened.steps[trigger.id]!.sessionId, resumeCliSessionId: "cli_history", runKey: old.runKey });
  expect(resumed.prompt).toContain("One more thing.");
  expect(adapter.sent).toEqual([]);
  await emit(resumed.sessionId, { type: "text", delta: "Second answer." });
  await emit(resumed.sessionId, { type: "outputs-accepted", values: {} });
  expect((await runOf(engine, runId)).run.status).toBe("succeeded");
  const transcript = await context.db.select().from(messages).where(eq(messages.runId, runId)).orderBy(messages.position);
  expect(transcript.map((m) => m.text)).toEqual(["First answer.", "One more thing.", "Second answer."]);
  const [entry] = await context.db.select().from(audit).where(and(eq(audit.jobId, runId), eq(audit.action, "job.reopened")));
  expect(entry!.actor).toEqual({ type: "user", userId: context.ownerId });
});

test("a reopened chat survives restart and waits for a live old process before resuming once", async () => {
  const { context, adapter, engine, emit, trigger, runnerId } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start;
  await emit(old.sessionId, { type: "cli-session", cliSessionId: "cli_history" });
  await emit(old.sessionId, { type: "outputs-accepted", values: {} });
  await Promise.all([engine.sendChat(runId, "Continue."), engine.sendChat(runId, "And this.")]);
  await engine.stop();
  const after = new FakeAdapter();
  const recovered = new Engine(context.db, after);
  onTestFinished(() => recovered.stop());
  await recovered.recover();
  await recovered.reconcile(runnerId, [old.sessionId]);
  expect(after.starts).toEqual([]);
  await recovered.onHarnessEvent(old.sessionId, { type: "session-ended" }, { runnerId: "other-runner", seq: 9 });
  expect(after.starts).toEqual([]);
  await recovered.reconcile(runnerId, []);
  await vi.waitFor(() => expect(after.starts).toHaveLength(1));
  expect(after.starts[0]!.start).toMatchObject({ resumeCliSessionId: "cli_history" });
  expect(after.starts[0]!.start.prompt).toContain("Continue.");
  expect(after.starts[0]!.start.prompt).toContain("And this.");
  expect(after.sent).toEqual([]);
});

test.each(["failed", "stopped", "no-history", "button"])("a %s Job cannot reopen a chat", async (kind) => {
  const { context, adapter, engine, emit, trigger } = await jobSetup(kind === "button" ? "button" : "chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const id = adapter.starts[0]!.start.sessionId;
  if (kind !== "no-history") await emit(id, { type: "cli-session", cliSessionId: "cli_history" });
  if (kind === "stopped") await engine.stopRun(runId);
  else await emit(id, kind === "failed" ? { type: "error", message: "Failed" } : { type: "result", text: "Done" });
  await expect(engine.sendChat(runId, "Continue?")).rejects.toMatchObject({ code: "CLOSED" });
  expect(adapter.starts).toHaveLength(1);
});

test("a reopened CLI Job carries a fresh endpoint token and only its remaining tools", async () => {
  const { context, engine, agent, runnerId, starts, withTooling } = await toolingSetup();
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "", config: { kind: "manual", placement: "chat" } }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  const old = starts()[0]!;
  expect(old.jobToken).toBeTruthy();
  expect(old.mcpServers).not.toEqual([]);
  await engine.onHarnessEvent(old.sessionId, { type: "cli-session", cliSessionId: "cli_history" }, { runnerId, seq: 1 });
  await engine.onHarnessEvent(old.sessionId, { type: "outputs-accepted", values: {} }, { runnerId, seq: 2 });
  await call(router.agents.update, { ...withTooling, skillPackageIds: [], toolIds: [] }, { context });
  await engine.sendChat(runId, "Continue.");
  expect(starts()).toHaveLength(1);
  await engine.onHarnessEvent(old.sessionId, { type: "session-ended" }, { runnerId, seq: 3 });
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  const resumed = starts()[1]!;
  expect(resumed).toMatchObject({ resumeCliSessionId: "cli_history", skills: [], mcpServers: [] });
  expect(resumed.jobToken).toBeTruthy();
  expect(resumed.jobToken).not.toBe(old.jobToken);
  expect(await jobOfToken(context.db, old.jobToken!)).toBeNull();
  expect(await jobOfToken(context.db, resumed.jobToken!)).toMatchObject({ runId, agentId: agent.id });
});

test("an offline reopened chat retries its new turn without replaying the old conversation", async () => {
  const { context, adapter, engine, emit, trigger, runnerId } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start;
  await engine.sendChat(runId, "Old turn.");
  await vi.waitFor(async () => expect((await context.db.select().from(messages).where(eq(messages.runId, runId)))[0]!.deliveredAt).toBeInstanceOf(Date));
  await emit(old.sessionId, { type: "cli-session", cliSessionId: "cli_history" });
  await emit(old.sessionId, { type: "outputs-accepted", values: {} });
  adapter.online = false;
  await engine.sendChat(runId, "New turn.");
  const reopened = Object.values((await runOf(engine, runId)).steps)[0]!;
  // A permission update sent before this new process starts can report it absent.
  await emit(reopened.sessionId!, SESSION_NOT_RUNNING);
  await emit(old.sessionId, { type: "session-ended" });
  await engine.stop();
  const after = new FakeAdapter();
  const recovered = new Engine(context.db, after);
  onTestFinished(() => recovered.stop());
  await recovered.recover();
  await recovered.reconcile(runnerId, []);
  await vi.waitFor(() => expect(after.starts).toHaveLength(1));
  expect(after.starts[0]!.start.prompt).toContain("New turn.");
  expect(after.starts[0]!.start.prompt).not.toContain("Old turn.");
  expect(after.sent).toEqual([]);
});

test("stopping a reopened chat while it waits prevents a later exit acknowledgement from resuming it", async () => {
  const { context, adapter, engine, emit, trigger } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start.sessionId;
  await emit(old, { type: "cli-session", cliSessionId: "cli_history" });
  await emit(old, { type: "outputs-accepted", values: {} });
  await engine.sendChat(runId, "Continue.");
  await engine.stopRun(runId);
  await emit(old, { type: "session-ended" });
  expect(adapter.starts).toHaveLength(1);
  expect((await runOf(engine, runId)).run.status).toBe("failed");
});

test("a reopened chat sends prompt overflow only after its resumed start is written", async () => {
  const { context, adapter, engine, emit, trigger } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start.sessionId;
  await emit(old, { type: "cli-session", cliSessionId: "cli_history" });
  await emit(old, { type: "outputs-accepted", values: {} });
  await engine.sendChat(runId, "a".repeat(100_000));
  await engine.sendChat(runId, "b".repeat(100_000));
  let write!: () => void;
  adapter.hold = new Promise<void>((resolve) => (write = resolve));
  try {
    await emit(old, { type: "session-ended" });
    expect(adapter.starts).toHaveLength(2);
    expect(adapter.starts[1]!.start.prompt).toContain("a".repeat(100_000));
    expect(adapter.sent).toEqual([]);
    write();
    await engine.stop();
    expect(adapter.sent).toEqual([[adapter.starts[1]!.start.sessionId, "b".repeat(100_000)]]);
  } finally {
    write();
  }
});

test("a successful chat cannot reopen on its revoked historical runner", async () => {
  const { context, adapter, engine, emit, trigger, runnerId } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const old = adapter.starts[0]!.start.sessionId;
  await emit(old, { type: "cli-session", cliSessionId: "cli_history" });
  await emit(old, { type: "outputs-accepted", values: {} });
  await context.db.update(runners).set({ revokedAt: new Date() }).where(eq(runners.id, runnerId));
  await expect(engine.sendChat(runId, "Continue?")).rejects.toMatchObject({ code: "CLOSED" });
  expect((await runOf(engine, runId)).run.status).toBe("succeeded");
});
