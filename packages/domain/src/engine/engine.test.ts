import { call } from "@orpc/server";
import { type Answer, parseServerMessage, type ServerToRunner, SESSION_ALREADY_RUNNING, SESSION_NOT_RUNNING, TEXT } from "@dispand/runner-protocol";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { harnesses as harnessesTable, messages, questions, runners, runs, stepRuns, tools } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { ArgValue } from "../tools/arguments.ts";
import type { ToolExecutor } from "../tools/executor.ts";
import type { AgentStep, ToolStep, WorkflowDef } from "../workflows/model.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { CloudRunner, noTools } from "../cloud/runner.ts";
import { CliHarnessAdapter } from "./cli-harness.ts";
import { RoutingAdapter } from "./routing-adapter.ts";
import { jobTokenOf } from "../platform/token.ts";
import { packageForRunner } from "../skills/runner-access.ts";
import { Engine, RESUME_PROMPT, TOOL_RESTARTED } from "./engine.ts";
import { CLOUD_SOURCE, type CliHarness, type Harness, type HarnessAdapter, type StartParams } from "./harness.ts";

/** Records what the engine asks of the harness. Online, every message reaches it at once; offline, none does. */
class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  sent: [string, string][] = [];
  answers: [string, string, Answer][] = [];
  online = true;
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
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
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
    ownerId: context.ownerId,
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
  await emit(sessionId, { type: "error", message: SESSION_NOT_RUNNING });
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
  await emit(sessionId, { type: "error", message: SESSION_ALREADY_RUNNING });
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
  expect(steps.n_plan).toMatchObject({ status: "failed", error: expect.stringContaining("too long once its values are filled in (300024 characters, at most 200000)") });
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
  await emit(chatSession, { type: "error", message: SESSION_NOT_RUNNING });
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
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: "The agent's runner was revoked" });
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
  expect((await runOf(engine, missing)).run).toMatchObject({ status: "failed", error: "Codex isn't installed on Workstation" });

  await reported({ codex: { version: "0.166.0", signedIn: false } });
  const signedOut = await engine.startRun(workflow.id);
  expect((await runOf(engine, signedOut)).run).toMatchObject({
    status: "failed",
    error: "Sign in to Codex on Workstation: run `codex login` there, then restart its runner",
  });
  expect(adapter.starts).toHaveLength(0);

  await reported({ codex: { version: "0.166.0", signedIn: true } });
  await engine.startRun(workflow.id);
  expect(adapter.starts[0]!.harness).toEqual({ id: harness.id, runnerId, kind: "codex", permissionMode: "default", model: "opus" });
});

test("a Codex step on a runner that never reported starts: the runner decides", async () => {
  const { context, adapter, engine, workflow, harness } = await setup(buttonThenStep);
  await call(router.harnesses.update, { ...harness, kind: "codex", permissionMode: "bypassPermissions" }, { context });
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
  const resumed = emit(chatSession, { type: "error", message: SESSION_NOT_RUNNING });
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
  const cloud = new CloudRunner(context.db, context.secrets, {
    tools: noTools,
    client: () => ({ turn: async ({ onText }) => {
      const text = texts.shift() ?? "";
      onText(text);
      return { text, toolCalls: [], raw: null, stop: "end" };
    } }),
  });
  const engine = new Engine(context.db, new RoutingAdapter(context.db, adapter, cloud), cloud);
  onTestFinished(() => engine.stop());
  cloud.onEvent((sessionId, event, seq) => engine.onHarnessEvent(sessionId, event, { runnerId: CLOUD_SOURCE, seq }));
  const harness = await call(
    router.harnesses.create,
    { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", model: "m", systemPrompt: "" },
    { context },
  );
  const agent = await call(router.agents.create, { name: "Cloud writer", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  return { engine, cloudAgent: agent };
}

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
  expect(state.steps.n_if).toMatchObject({ status: "failed", error: "“abc” is not a number" });
  expect(state.run).toMatchObject({ status: "failed", error: "“abc” is not a number" });
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
  expect(state.steps.n_each).toMatchObject({ status: "failed", error: "The list has 3 items; this loop runs at most 2" });
  expect(state.run).toMatchObject({ status: "failed", error: "The list has 3 items; this loop runs at most 2" });
  expect(adapter.starts).toHaveLength(1);
});

test("a list that isn't a JSON array fails the loop", async () => {
  const { adapter, engine, emit, workflow } = await setup(forEach());
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { items: "a, b" } });
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: "“items” is not a list (a JSON array)" });
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
  const { adapter, engine, emit, workflow } = await setup(chatToolAgent, new FakeTools(() => ({ ok: false, error: "The tool answered with an error: nope" })));
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "acme" } });
  await vi.waitFor(async () => expect((await runOf(engine, runId)).run.status).toBe("failed"));
  const state = await runOf(engine, runId);
  expect(state.steps.n_repo).toMatchObject({ status: "failed", error: "The tool answered with an error: nope" });
  expect(state.run.error).toBe("The tool answered with an error: nope");
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
  expect(run.snapshot).toEqual({ id: agent.id, name: "Writer", harnessId: agent.harnessId, systemPrompt: "Be brief.", skills: [], tools: [], bundles: [], tables: "all" });
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

test("a Job over the chain limit is refused", async () => {
  const { context, engine, agent, trigger } = await jobSetup();
  const job = (depth: number) =>
    engine.db.transaction((tx) =>
      engine.createJob(tx, { ownerId: context.ownerId, agentId: agent.id, triggerId: trigger.id, cause: { kind: "event", eventId: "evt_1", depth }, firing: { type: "manual" } }),
    );
  await expect(job(11)).rejects.toMatchObject({ code: "INVALID", message: "Chain limit reached" });
  expect(await job(10)).toMatch(/^run_/);
});

test("a Job is refused for a disabled trigger, another agent's trigger or another owner", async () => {
  const { context, engine, agent, harness, trigger } = await jobSetup();
  const other = await call(router.agents.create, { name: "Other", harnessId: harness.id, systemPrompt: "" }, { context });
  const job = (ownerId: string, agentId: string) =>
    engine.db.transaction((tx) =>
      engine.createJob(tx, { ownerId, agentId, triggerId: trigger.id, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } }),
    );
  await expect(job(context.ownerId, other.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(job("user_nobody", agent.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(engine.startJob(trigger.id, "user_nobody")).rejects.toMatchObject({ code: "NOT_FOUND" });
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

test("deleting an agent deletes its finished Jobs", async () => {
  const { context, adapter, engine, emit, agent, workflow, trigger } = await jobSetup();
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await emit(adapter.starts[0]!.start.sessionId, { type: "result", text: "Sorted." });
  expect((await runOf(engine, runId)).run.status).toBe("succeeded");
  await call(router.workflows.delete, { id: workflow.id }, { context });
  await call(router.agents.delete, { id: agent.id }, { context });
  expect(await engine.db.select().from(runs)).toEqual([]);
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
  expect(run).toMatchObject({ status: "failed", error: "Stopped" });
  expect(run.finishedAt).toBeInstanceOf(Date);
  expect(steps.n_chat).toMatchObject({ status: "failed", error: "Stopped" });
  // A step that never started is closed too: nothing of the run is left open.
  expect(steps.n_plan).toMatchObject({ status: "failed", error: "Stopped" });
  expect(await context.db.select({ status: questions.status }).from(questions).where(eq(questions.runId, runId))).toEqual([{ status: "expired" }]);
  await vi.waitFor(() => expect(adapter.stops).toEqual([session]));

  // What the session still says changes nothing, and the chat is over.
  await emit(session, { type: "outputs-accepted", values: { idea: "notes", audience: "me" } });
  await emit(session, { type: "error", message: "Stopped" });
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: "Stopped" });
  expect(adapter.starts).toHaveLength(1);
  await expect(engine.sendChat(runId, "hello?")).rejects.toMatchObject({ code: "CLOSED" });
  await expect(engine.stopRun(runId)).rejects.toMatchObject({ code: "CLOSED" });
  await expect(engine.stopRun("run_nobody")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("stopping a chat Job ends it", async () => {
  const { context, adapter, engine, trigger } = await jobSetup("chat");
  const runId = await engine.startJob(trigger.id, context.ownerId);
  await engine.stopRun(runId);
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: "Stopped" });
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
  expect(state.steps.n_repo).toMatchObject({ status: "failed", error: "Stopped" });
  expect(state.run).toMatchObject({ status: "failed", error: "Stopped" });
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
  expect((await runOf(engine, runId)).run).toMatchObject({ status: "failed", error: "Stopped" });
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
  await context.db.insert(tools).values({ id: "tool_fetch", ownerId: context.ownerId, name: "Fetch", kind: "runner", runnerId, runnerTool: "fetch" });
  const { packageId } = await call(router.skills.create, { name: "review", description: "Reviews.", instructions: "x", requiredToolIds: [] }, { context });
  const withTooling = { ...agent, skillPackageIds: [packageId], toolIds: ["tool_fetch", "tool_gh"] };
  await call(router.agents.update, withTooling, { context });
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_id: string, msg: ServerToRunner) => (sent.push(msg), true) };
  const adapter = new CliHarnessAdapter(context.db, hub as unknown as RunnerHub, context.secrets);
  const engine = new Engine(context.db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const starts = () => sent.flatMap((m) => (m.type === "session.start" ? [m.start] : []));
  return { ...s, engine, packageId, withTooling, starts };
}

test("a Job's CLI start carries its agent's skill packages and runner tools, and never an HTTP tool", async () => {
  const { context, engine, agent, packageId, starts } = await toolingSetup();
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  expect(starts()[0]).toMatchObject({
    skills: [{ packageId, name: "review" }],
    // The HTTP tool (GitHub) stays on the server: its address and headers never travel.
    mcpServers: [{ name: "fetch", type: "runner", tool: "fetch" }],
  });
  expect(JSON.stringify(starts()[0])).not.toContain("mcp.example.com");
});

test("a workflow step's CLI start carries its agent's skills and runner tools too", async () => {
  const { engine, workflow, packageId, starts } = await toolingSetup();
  await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  expect(starts()[0]).toMatchObject({ skills: [{ packageId, name: "review" }], mcpServers: [{ name: "fetch", type: "runner", tool: "fetch" }] });
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
  const other = await call(router.runners.create, { name: "Laptop" }, { context });
  const elsewhere = await call(router.harnesses.create, { name: "Elsewhere", runnerId: other.runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  await call(router.agents.update, { ...withTooling, harnessId: elsewhere.id, toolIds: ["tool_gh"] }, { context });
  expect(await packageForRunner(context.db, runnerId, packageId)).toBeNull();
  await engine.continueRun(runId);
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  expect(starts()[0]).toMatchObject({ skills: [], mcpServers: [] });
});
