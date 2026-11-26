import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { agentConsults, agents, harnesses, questions, rows, runs, stepRuns, tools } from "../db/schema.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext, refusing, runnerWithClis } from "../runners/test-support.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { ORGANIZATION_HEADER, WORKSPACE_HEADER } from "../workspace/authorize.ts";
import { bootstrapOrganization } from "../workspace/lifecycle.ts";
import type { ToolExecutor } from "../tools/executor.ts";
import type { ToolStep, WorkflowDef } from "../workflows/model.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { JOB_STEP } from "./job-def.ts";
import { Scheduler } from "./scheduler.ts";

// The organization gate in the engine: a refused organization's work gets no slot, starts and
// resumes nothing, and fails nothing; the scheduler's tick hands it on once the install allows it.

class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  /** The runner question ids answered, as each write begins. */
  answers: string[] = [];
  /** While set, an answer's write waits for it: a slow runner. */
  slow?: Promise<void>;
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    return true;
  }
  async send() {
    return true;
  }
  async answer(_sessionId: string, questionId: string) {
    this.answers.push(questionId);
    await this.slow;
    return true;
  }
  async stop() {
    return true;
  }
}

/** Answers every Tool step call at once, recording which. */
class FakeTools implements ToolExecutor {
  calls: string[] = [];
  async run(_workspaceId: string, step: ToolStep) {
    this.calls.push(step.id);
    return { ok: true as const, outputs: { result: "done" } };
  }
}

/** An agent on a harness of its own (limit `limit`) and a manual trigger, in the workspace `context` names. */
async function agentIn(context: Awaited<ReturnType<typeof ownerContext>>, limit: number) {
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "acceptEdits" }, { context }));
  await context.db.update(harnesses).set({ maxWorking: limit }).where(eq(harnesses.id, harness.id));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Sort the mail.", config: { kind: "manual", placement: "button" } }, { context });
  return { runnerId, harness, agent, trigger };
}

/** Organization A (the owner's, harness limit 1) and organization B (another of the owner's, its own harness), an engine on a fake runner and a scheduler. */
async function setup() {
  const owner = await ownerContext();
  const at = (organizationId: string, workspaceId: string) => ({ ...owner, organizationId, workspaceId, headers: new Headers({ cookie: owner.headers.get("cookie")!, [ORGANIZATION_HEADER]: organizationId, [WORKSPACE_HEADER]: workspaceId }) });
  const a = { context: owner, ...(await agentIn(owner, 1)) };
  await owner.db.transaction((tx) => bootstrapOrganization(tx, { userId: owner.ownerId, organizationId: "org_b", workspaceId: "ws_b" }));
  // With two workspaces, a request names its own.
  const contextA = at(owner.organizationId, owner.workspaceId);
  const contextB = at("org_b", "ws_b");
  const b = { context: contextB, ...(await agentIn(contextB, 1)) };
  // The install refuses organization A from `refuse()` until `allow()`, on the database's own
  // tenancy. Allowed again, it keeps its hook (refusing another organization only): with none, nothing is re-drained.
  const refusal = { key: "organization.refused", link: "https://example.com/organization" };
  let lift: (() => void) | undefined;
  const refuse = () => void (lift = refusing(owner.db, owner.organizationId, refusal));
  const allow = () => {
    lift?.();
    lift = refusing(owner.db, "org_elsewhere", refusal);
  };
  const adapter = new FakeAdapter();
  const toolSteps = new FakeTools();
  const engine = new Engine(owner.db, adapter, undefined, undefined, toolSteps);
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(owner.db, engine);
  let seq = 0;
  const emit = (runnerId: string, sessionId: string, event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });

  /** A Job of the organization's trigger, started as far as it goes. */
  const job = async (of: typeof a) => {
    const runId = await owner.db.transaction((tx) => engine.createJob(tx, { ownerId: owner.ownerId, agentId: of.agent.id, triggerId: of.trigger.id, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } }));
    await engine.continueRun(runId);
    return runId;
  };
  const step = async (runId: string, nodeId = JOB_STEP) => (await owner.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, nodeId))))[0]!;
  const started = (runId: string) => adapter.starts.filter((s) => s.start.runKey.startsWith(`${runId}-`)).length;
  const working = async (harnessId: string) => (await owner.db.select().from(stepRuns).where(and(eq(stepRuns.harnessId, harnessId), eq(stepRuns.working, true)))).length;
  /** One scheduler tick, as the scheduler runs it, and what it handed on settled. */
  const tick = async () => {
    await inScope(SYSTEM, () => scheduler.tick());
    await engine.idle();
  };
  /** No step of these runs failed: the gate only holds work. */
  const noneFailed = async (...runIds: string[]) => {
    for (const runId of runIds) {
      expect((await owner.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)))[0]?.status).not.toBe("failed");
      expect((await owner.db.select({ status: stepRuns.status }).from(stepRuns).where(eq(stepRuns.runId, runId))).map((s) => s.status)).not.toContain("failed");
    }
  };
  return { owner, contextA, a, b, refuse, allow, adapter, toolSteps, engine, emit, job, step, started, working, tick, noneFailed };
}

test("a refused organization's queued Job holds no slot while another organization's starts, and starts on the next tick once allowed", async () => {
  const t = await captureTelemetry();
  onTestFinished(() => t.stop());
  const { a, b, refuse, allow, emit, job, step, started, working, tick, noneFailed } = await setup();
  const first = await job(a);
  const queued = await job(a);
  expect([started(first), started(queued)]).toEqual([1, 0]);
  expect((await step(queued)).queuedAt).toBeInstanceOf(Date);

  refuse();
  // The first Job ends: its slot stays free, and the queued one stays queued, in its place.
  await emit(a.runnerId, (await step(first)).sessionId!, { type: "result", text: "Done." });
  expect(await step(queued)).toMatchObject({ status: "pending", working: false, queueClass: "person" });
  expect((await step(queued)).queuedAt).toBeInstanceOf(Date);
  expect(await working(a.harness.id)).toBe(0);
  // Another organization's Job starts on its own harness meanwhile.
  const other = await job(b);
  expect(started(other)).toBe(1);
  expect(await working(b.harness.id)).toBe(1);
  // A tick while refused hands it nothing.
  await tick();
  expect(started(queued)).toBe(0);
  expect(await working(a.harness.id)).toBe(0);
  await noneFailed(first, queued);

  allow();
  await tick();
  await vi.waitFor(() => expect(started(queued)).toBe(1));
  expect(await step(queued)).toMatchObject({ status: "running", working: true, queuedAt: null, pendingAction: null });
  expect(await working(a.harness.id)).toBe(1);
  expect(await t.metrics()).toContainEqual({ name: "dispand.organization.refusals", attributes: { "dispand.refusal.path": "work" } });
});

test("a step handed its slot before a restart and a lost session's resume are held while refused, never failed, and go on once allowed", async () => {
  const { owner, a, refuse, allow, adapter, engine, job, step, started, working, tick, noneFailed } = await setup();
  const running = await job(a);
  const handed = await job(a);
  await owner.db.update(harnesses).set({ maxWorking: 2 }).where(eq(harnesses.id, a.harness.id));
  // The process stopped right after handing the second Job a slot, before its session started.
  await owner.db.update(stepRuns).set({ working: true, queuedAt: null, queueClass: null, pendingAction: { kind: "start" } }).where(eq(stepRuns.id, (await step(handed)).id));
  refuse();

  await engine.recover();
  // The runner is back without the first Job's session: lost, it would resume.
  await engine.reconcile(a.runnerId, []);
  await engine.idle();
  expect(await step(handed)).toMatchObject({ status: "pending", working: false, queuedAt: null, pendingAction: { kind: "start" } });
  expect(await step(running)).toMatchObject({ status: "running", working: false, pendingAction: { kind: "resume" } });
  expect(await working(a.harness.id)).toBe(0);
  expect(adapter.starts).toHaveLength(1);
  await tick();
  expect(adapter.starts).toHaveLength(1);
  await noneFailed(running, handed);

  allow();
  await tick();
  await vi.waitFor(() => expect([started(running), started(handed)]).toEqual([2, 1]));
  expect(await step(handed)).toMatchObject({ status: "running", working: true, pendingAction: null });
  expect(await step(running)).toMatchObject({ status: "running", working: true });
  expect(await working(a.harness.id)).toBe(2);
});

test("answers given while refused wait, never delivered, and reach their sessions once allowed, a step that kept its slot too", async () => {
  const { owner, a, refuse, allow, adapter, engine, emit, job, step, working, tick, noneFailed } = await setup();
  await owner.db.update(harnesses).set({ maxWorking: 2 }).where(eq(harnesses.id, a.harness.id));
  const held = await job(a);
  const kept = await job(a);
  const choice = { kind: "choice" as const, questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }] }] };
  for (const [runId, questionId] of [[held, "rq_held"], [kept, "rq_kept"]] as const) await emit(a.runnerId, (await step(runId)).sessionId!, { type: "question", questionId, payload: choice });
  refuse();

  for (const runId of [held, kept]) {
    const [q] = await owner.db.select().from(questions).where(eq(questions.runId, runId));
    await engine.answer(q!.id, { kind: "choice", answers: { "Which?": "A" } }, { type: "user", userId: owner.ownerId });
    expect(await step(runId)).toMatchObject({ status: "running", working: false, queuedAt: null, pendingAction: { kind: "deliver" } });
  }
  // One kept its slot to deliver (a hold during a turn, `hold`).
  await owner.db.update(stepRuns).set({ working: true }).where(eq(stepRuns.id, (await step(kept)).id));
  await tick();
  expect(adapter.answers).toEqual([]);
  await noneFailed(held, kept);

  allow();
  await tick();
  await vi.waitFor(() => expect([...adapter.answers].sort()).toEqual(["rq_held", "rq_kept"]));
  expect(await working(a.harness.id)).toBe(2);
});

test("an answer waiting its turn in the session's lane when the refusal comes is held, not sent, and goes once allowed", async () => {
  const { owner, a, refuse, allow, adapter, engine, emit, job, step, tick, noneFailed } = await setup();
  const running = await job(a);
  const choice = (question: string) => ({ kind: "choice" as const, questions: [{ question, header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }] }] });
  for (const questionId of ["rq_1", "rq_2"]) await emit(a.runnerId, (await step(running)).sessionId!, { type: "question", questionId, payload: choice(questionId) });
  let written!: () => void;
  adapter.slow = new Promise((resolve) => (written = resolve));
  // Both answered while allowed: their deliveries go one after the other, the first one's write still under way.
  for (const q of await owner.db.select().from(questions).where(eq(questions.runId, running)).orderBy(questions.createdAt)) {
    await engine.answer(q.id, { kind: "choice", answers: { [q.runnerQuestionId!]: "A" } }, { type: "user", userId: owner.ownerId });
  }
  await vi.waitFor(() => expect(adapter.answers).toHaveLength(1));
  const first = [...adapter.answers];

  refuse();
  adapter.slow = undefined;
  written();
  await engine.idle();
  expect(adapter.answers).toEqual(first);
  expect((await step(running)).pendingAction).toEqual({ kind: "deliver" });
  await tick();
  expect(adapter.answers).toEqual(first);
  await noneFailed(running);

  allow();
  await tick();
  await vi.waitFor(() => expect([...adapter.answers].sort()).toEqual(["rq_1", "rq_2"]));
});

test("a live turn keeps its slot across reconnects while refused, and its held deliveries go once allowed", async () => {
  const { a, refuse, allow, engine, job, step, working, tick, noneFailed } = await setup();
  const running = await job(a);
  const live = [(await step(running)).sessionId!];
  refuse();

  await engine.reconcile(a.runnerId, live);
  await engine.reconcile(a.runnerId, live);
  expect(await step(running)).toMatchObject({ status: "running", working: true, pendingAction: { kind: "deliver" } });
  expect(await working(a.harness.id)).toBe(1);
  await noneFailed(running);

  allow();
  await tick();
  await vi.waitFor(async () => expect(await step(running)).toMatchObject({ working: true, pendingAction: null }));
  expect(await working(a.harness.id)).toBe(1);
});

test("a workflow run of a refused organization (no root) starts nothing, and starts on the next tick once allowed", async () => {
  const { owner, contextA: context, a, refuse, allow, engine, step, started, working, tick, noneFailed } = await setup();
  const def: WorkflowDef = {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId: a.agent.id, prompt: "Write a note." }],
    edges: [{ from: "n_go", to: "n_note" }],
  };
  const workflow = await call(router.workflows.create, { name: "Note" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Note", def }, { context });
  refuse();

  const run = await engine.startRun(workflow.id);
  expect((await owner.db.select({ rootId: runs.rootId }).from(runs).where(eq(runs.id, run)))[0]?.rootId).toBeNull();
  expect(started(run)).toBe(0);
  expect(await step(run, "n_note")).toMatchObject({ status: "pending", working: false, queuedAt: null, pendingAction: { kind: "start" } });
  await tick();
  expect(started(run)).toBe(0);
  await noneFailed(run);

  allow();
  await tick();
  await vi.waitFor(() => expect(started(run)).toBe(1));
  expect(await working(a.harness.id)).toBe(1);
});

test("a refused organization's Tool and Data steps run nothing, and run on the next tick once allowed", async () => {
  const { owner, contextA: context, refuse, allow, toolSteps, engine, tick, noneFailed } = await setup();
  await owner.db.insert(tools).values({
    id: "tool_gh", ownerId: owner.ownerId, workspaceId: owner.workspaceId, name: "GitHub", kind: "http", url: "https://mcp.example.com/", transport: "streamable-http",
    actions: [{ name: "create_repository", description: "", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
  });
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const def: WorkflowDef = {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [
      { id: "n_repo", key: "create_repo", type: "tool", name: "Create repo", toolId: "tool_gh", action: "create_repository", inputs: [{ param: "name", source: { type: "value", value: "acme" } }] },
      { id: "n_data", key: "create_project", type: "data", name: "Create project", action: "create-row", tableId: table.id, inputs: [{ fieldId: table.fields[0]!.id, source: { type: "value", value: "acme" } }] },
    ],
    edges: [{ from: "n_go", to: "n_repo" }, { from: "n_go", to: "n_data" }],
  };
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def }, { context });
  const steps = async (runId: string) => Object.fromEntries((await owner.db.select().from(stepRuns).where(eq(stepRuns.runId, runId))).map((s) => [s.nodeId, s]));
  const written = async () => (await owner.db.select().from(rows).where(eq(rows.tableId, table.id))).length;
  refuse();

  const run = await engine.startRun(workflow.id);
  for (const node of ["n_repo", "n_data"]) expect((await steps(run))[node]).toMatchObject({ status: "pending", pendingAction: { kind: "start" } });
  await tick();
  expect([toolSteps.calls, await written()]).toEqual([[], 0]);
  await noneFailed(run);

  allow();
  await tick();
  await vi.waitFor(async () => expect((await owner.db.select({ status: runs.status }).from(runs).where(eq(runs.id, run)))[0]?.status).toBe("succeeded"));
  expect([toolSteps.calls, await written()]).toEqual([["n_repo"], 1]);
  for (const node of ["n_repo", "n_data"]) expect((await steps(run))[node]).toMatchObject({ status: "succeeded", pendingAction: null });
});

test("a consult a refused organization's Job asks stays pending, never failed, and its Job starts once allowed", async () => {
  const { owner, contextA: context, a, refuse, allow, emit, job, step, started, tick, noneFailed } = await setup();
  await owner.db.update(harnesses).set({ maxWorking: 2 }).where(eq(harnesses.id, a.harness.id));
  const expert = await call(router.agents.create, { name: "Expert", harnessId: a.harness.id, systemPrompt: "" }, { context });
  await owner.db.update(agents).set({ consultMode: "whitelist" }).where(eq(agents.id, a.agent.id));
  await owner.db.insert(agentConsults).values({ agentId: a.agent.id, consultedId: expert.id });
  const asker = await job(a);
  refuse();

  await emit(a.runnerId, (await step(asker)).sessionId!, { type: "question", questionId: "rq1", payload: { kind: "consult", agentId: expert.id, question: "What is the answer?" } });
  const consult = async () => (await owner.db.select().from(questions).where(eq(questions.runnerQuestionId, "rq1")))[0]!;
  expect(await consult()).toMatchObject({ status: "pending", consultRunId: null });
  await tick();
  expect(await consult()).toMatchObject({ status: "pending", consultRunId: null });
  await noneFailed(asker);

  allow();
  await tick();
  const consulted = await vi.waitFor(async () => {
    const { consultRunId } = await consult();
    if (!consultRunId) throw new Error("no consulted Job yet");
    return consultRunId;
  });
  await vi.waitFor(() => expect(started(consulted)).toBe(1));
  await noneFailed(asker, consulted);
});

test("with no organization gate, the re-drain sends no query and changes nothing", async () => {
  const owner = await ownerContext();
  const { harness, agent, trigger } = await agentIn(owner, 1);
  const engine = new Engine(owner.db, new FakeAdapter());
  onTestFinished(() => engine.stop());
  const queued: string[] = [];
  for (let i = 0; i < 2; i++) {
    const runId = await owner.db.transaction((tx) => engine.createJob(tx, { ownerId: owner.ownerId, agentId: agent.id, triggerId: trigger.id, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } }));
    await engine.continueRun(runId);
    queued.push(runId);
  }
  // A place freed without a hand-over: only the gate's re-drain would hand it on.
  await owner.db.update(harnesses).set({ maxWorking: 2 }).where(eq(harnesses.id, harness.id));
  const sent = ["select", "selectDistinct", "transaction", "execute", "update", "insert"].map((method) => vi.spyOn(owner.db, method as "select"));
  onTestFinished(() => sent.forEach((spy) => spy.mockRestore()));
  await engine.redrain();
  for (const spy of sent) expect(spy).not.toHaveBeenCalled();
  const second = (await owner.db.select().from(stepRuns).where(and(eq(stepRuns.runId, queued[1]!), eq(stepRuns.nodeId, JOB_STEP))))[0]!;
  expect(second.queuedAt).toBeInstanceOf(Date);
  expect(await owner.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(stepRuns).where(eq(stepRuns.working, true))).toEqual([{ n: 1 }]);
});
