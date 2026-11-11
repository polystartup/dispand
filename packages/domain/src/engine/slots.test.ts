import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { closeDb, createDb, type Db } from "../db/client.ts";
import { harnesses, messages, questions, runs, stepRuns, type RunTrigger } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import { Engine } from "./engine.ts";
import { take } from "./slots.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { JOB_STEP } from "./job-def.ts";

/** Records the starts the engine sends; every one reaches its runner. */
class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  sent: [string, string][] = [];
  /** The runner question ids answered, in order. */
  answers: string[] = [];
  /** What reached the runner, in order. */
  log: string[] = [];
  /** How long a start takes to be written, in ms. */
  delay = 0;
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    this.log.push(`start:${start.sessionId}`);
    return true;
  }
  async send(sessionId: string, text: string) {
    this.sent.push([sessionId, text]);
    this.log.push(`send:${sessionId}`);
    return true;
  }
  async answer(_sessionId: string, questionId: string) {
    this.answers.push(questionId);
    return true;
  }
  async stop() {
    return true;
  }
}

async function setup(limit: number) {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "acceptEdits" }, { context }));
  await context.db.update(harnesses).set({ maxWorking: limit }).where(eq(harnesses.id, harness.id));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Sort the mail.", config: { kind: "manual", placement: "button" } }, { context });
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  let seq = 0;
  const emit = (sessionId: string, event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });

  /** A Job of the trigger, fired by hand or by its schedule; returns its run id once it went as far as it could. */
  const job = async (firing: RunTrigger = { type: "manual" }) => {
    const cause = firing.type === "schedule" ? { kind: "schedule" as const, scheduledFor: firing.scheduledFor, depth: 0 } : { kind: "user" as const, depth: 0 };
    const runId = await context.db.transaction((tx) => engine.createJob(tx, { ownerId: context.ownerId, agentId: agent.id, triggerId: trigger.id, cause, firing }));
    await engine.continueRun(runId);
    return runId;
  };
  /** The Job's step row. */
  const step = async (runId: string, nodeId?: string) =>
    (await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), nodeId ? eq(stepRuns.nodeId, nodeId) : sql`${stepRuns.nodeId} in (${JOB_STEP}, ${chatNode})`)))[0]!;
  /** A chat Job's step is its trigger's node. */
  let chatNode = "";
  /** The session the engine started for the run's step (its run key starts with the run id). */
  const sessionOf = (runId: string) => adapter.starts.find((s) => s.start.runKey.startsWith(`${runId}-`))?.start.sessionId;
  /** The runs whose sessions started, in order. */
  const started = (runIds: string[]) => adapter.starts.map((s) => runIds.find((id) => s.start.runKey.startsWith(`${id}-`)));
  /** How many steps of the harness hold a slot. */
  const working = async (harnessId = harness.id) =>
    (await context.db.select().from(stepRuns).where(and(eq(stepRuns.harnessId, harnessId), eq(stepRuns.working, true)))).length;
  /** Ends the run's session with a result. */
  const finish = (runId: string) => emit(sessionOf(runId)!, { type: "result", text: "Done." });
  const chat = (node: string) => void (chatNode = node);
  return { context, runnerId, harness, agent, trigger, adapter, engine, emit, job, step, sessionOf, started, working, finish, chat };
}

test("with a limit of 1, three Jobs of one harness start one after the other as each finishes", async () => {
  const t = await captureTelemetry();
  onTestFinished(() => t.stop());
  const { context, job, step, adapter, finish, started, working, harness } = await setup(1);
  const a = await job({ type: "schedule", scheduledFor: "2026-11-11T09:00:00.000Z" });
  const b = await job({ type: "schedule", scheduledFor: "2026-11-11T09:00:00.000Z" });
  const c = await job({ type: "schedule", scheduledFor: "2026-11-11T09:00:00.000Z" });
  expect(started([a, b, c])).toEqual([a]);
  expect(await step(b)).toMatchObject({ status: "pending", harnessId: harness.id, queueClass: "new", working: false });
  expect((await step(b)).queuedAt).toBeInstanceOf(Date);
  // The Jobs list says which wait for a slot.
  const listed = await call(router.runs.list, {}, { context });
  expect(Object.fromEntries(listed.map((r) => [r.id, r.queued]))).toEqual({ [a]: false, [b]: true, [c]: true });

  await finish(a);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  expect(started([a, b, c])).toEqual([a, b]);
  expect(await working()).toBe(1);
  expect(await step(a)).toMatchObject({ status: "succeeded", working: false });

  await finish(b);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(3));
  expect(started([a, b, c])).toEqual([a, b, c]);
  expect(await step(c)).toMatchObject({ status: "running", working: true, queuedAt: null, pendingAction: null });

  // Working and queued by harness, time queued by class; nothing of a prompt.
  const metrics = await t.metrics();
  expect(metrics).toContainEqual({ name: "dispand.harness.working", attributes: { "dispand.harness.id": harness.id, "dispand.harness.kind": "claude-code" } });
  expect(metrics).toContainEqual({ name: "dispand.harness.queued", attributes: { "dispand.harness.id": harness.id, "dispand.harness.kind": "claude-code" } });
  expect(metrics).toContainEqual({ name: "dispand.harness.queue_wait", attributes: { "dispand.queue.class": "new" } });
  expect(await t.all()).not.toContain("Sort the mail");
});

test("a manual run's start goes ahead of a scheduled one queued before it", async () => {
  const { job, adapter, finish, started } = await setup(1);
  const a = await job();
  const scheduled = await job({ type: "schedule", scheduledFor: "2026-11-11T09:00:00.000Z" });
  const manual = await job();
  await finish(a);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  expect(started([a, scheduled, manual])).toEqual([a, manual]);
  await finish(manual);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(3));
  expect(started([a, scheduled, manual])).toEqual([a, manual, scheduled]);
});

test("two Jobs finishing at once on a full harness: each queued step starts once, never past the limit", async () => {
  const { job, step, adapter, engine, finish, started, working } = await setup(2);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(await job());
  const [a, b, c, d, e] = ids as [string, string, string, string, string];
  expect(started(ids)).toEqual([a, b]);
  await Promise.all([finish(a), finish(b)]);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(4));
  // Whatever else runs meanwhile (a replayed event, another advance) starts nothing more.
  await Promise.all(ids.map((id) => engine.continueRun(id)));
  expect(new Set(started(ids))).toEqual(new Set([a, b, c, d]));
  expect(adapter.starts).toHaveLength(4);
  expect(await working()).toBe(2);
  expect((await step(e)).queuedAt).toBeInstanceOf(Date);
});

test("a queued Job that is stopped leaves the queue and never starts", async () => {
  const { job, step, adapter, engine, finish, started, working } = await setup(1);
  const a = await job();
  const b = await job();
  const c = await job();
  await engine.stopRun(b);
  expect(await step(b)).toMatchObject({ status: "failed", queuedAt: null, queueClass: null, working: false });
  await finish(a);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  expect(started([a, b, c])).toEqual([a, c]);
  expect(await working()).toBe(1);
});

test("a queued step whose run fails leaves the queue; its slot goes to the next one", async () => {
  const both = (agentId: string): WorkflowDef => ({
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [
      { id: "n_one", key: "one", type: "agent", name: "One", agentId, prompt: "One." },
      { id: "n_two", key: "two", type: "agent", name: "Two", agentId, prompt: "Two." },
    ],
    edges: [
      { from: "n_go", to: "n_one" },
      { from: "n_go", to: "n_two" },
    ],
  });
  const { context, agent, job, step, adapter, engine, emit, started, working } = await setup(1);
  const workflow = await call(router.workflows.create, { name: "Both" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Both", def: both(agent.id) }, { context });
  const run = await engine.startRun(workflow.id);
  const other = await job();
  expect(adapter.starts).toHaveLength(1);
  const [first, second] = [await step(run, "n_one"), await step(run, "n_two")];
  const [runningStep, queuedStep] = first.status === "running" ? [first, second] : [second, first];
  expect(queuedStep.queuedAt).toBeInstanceOf(Date);

  await emit(runningStep.sessionId!, { type: "error", message: "The CLI crashed" });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  expect(started([run, other])).toEqual([run, other]);
  expect(await step(run, queuedStep.nodeId)).toMatchObject({ status: "pending", queuedAt: null, working: false });
  expect(await working()).toBe(1);
});

test("a workflow agent step and a Job on one harness with a limit of 1 take turns", async () => {
  const note = (agentId: string): WorkflowDef => ({
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId, prompt: "Write a note." }],
    edges: [{ from: "n_go", to: "n_note" }],
  });
  const { context, agent, harness, job, step, adapter, engine, emit, finish, started } = await setup(1);
  const workflow = await call(router.workflows.create, { name: "Note" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Note", def: note(agent.id) }, { context });
  const a = await job();
  const run = await engine.startRun(workflow.id);
  expect(started([a, run])).toEqual([a]);
  expect(await step(run, "n_note")).toMatchObject({ status: "pending", harnessId: harness.id, queueClass: "person" });
  await finish(a);
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  const b = await job();
  expect(started([a, run, b])).toEqual([a, run]);
  await emit((await step(run, "n_note")).sessionId!, { type: "result", text: "Noted." });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(3));
  expect(started([a, run, b])).toEqual([a, run, b]);
});

test("an agent moved to another harness before its workflow step is ready is charged to the new one", async () => {
  const chatThenStep = (agentId: string): WorkflowDef => ({
    trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId, prompt: "Ask what to build." } },
    steps: [{ id: "n_plan", key: "plan", type: "agent", name: "Plan", agentId, prompt: "Plan {{brief.idea}}." }],
    edges: [{ from: "n_chat", to: "n_plan" }],
  });
  const { context, runnerId, agent, harness, step, adapter, engine, emit, working } = await setup(1);
  const workflow = await call(router.workflows.create, { name: "Plan" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Plan", def: chatThenStep(agent.id) }, { context });
  const run = await engine.startRun(workflow.id);
  expect(await step(run, "n_plan")).toMatchObject({ status: "pending", harnessId: harness.id });
  const other = asCli(await call(router.harnesses.create, { name: "Codex", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  await call(router.agents.update, { ...agent, harnessId: other.id }, { context });

  await emit((await step(run, "n_chat")).sessionId!, { type: "outputs-accepted", values: { idea: "a chat app" } });
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  expect(adapter.starts[1]!.harness.id).toBe(other.id);
  expect(await step(run, "n_plan")).toMatchObject({ status: "running", harnessId: other.id, working: true });
  expect(await working(harness.id)).toBe(0);
  expect(await working(other.id)).toBe(1);
});

test("a restart keeps the queue, starts a step handed a slot whose session never started, and nothing past the limit", async () => {
  const { context, harness, job, step, working } = await setup(2);
  const a = await job();
  const b = await job();
  const c = await job();
  const d = await job();
  const e = await job();
  // The process stopped right after handing b's slot over (a closed step), before b's session started.
  await context.db.update(stepRuns).set({ working: false }).where(eq(stepRuns.id, (await step(b)).id));
  await context.db
    .update(stepRuns)
    .set({ status: "pending", sessionId: null, start: null, harness: null, runnerId: null, startedAt: null, working: true, pendingAction: { kind: "start" } })
    .where(eq(stepRuns.id, (await step(b)).id));
  // One more slot while it was down.
  await context.db.update(harnesses).set({ maxWorking: 3 }).where(eq(harnesses.id, harness.id));

  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  await engine.recover();
  await vi.waitFor(() => expect(adapter.starts).toHaveLength(2));
  // a's session is the runner's to report (its reconcile), not restarted here; b starts, c gets the free slot.
  const ran = adapter.starts.map((s) => [a, b, c, d, e].find((id) => s.start.runKey.startsWith(`${id}-`)));
  expect(new Set(ran)).toEqual(new Set([b, c]));
  expect(await working()).toBe(3);
  expect(await step(b)).toMatchObject({ status: "running", pendingAction: null });
  expect((await step(d)).queuedAt).toBeInstanceOf(Date);
  expect((await step(e)).queuedAt).toBeInstanceOf(Date);
  // A second restart changes nothing.
  const again = new FakeAdapter();
  const restarted = new Engine(context.db, again);
  onTestFinished(() => restarted.stop());
  await restarted.recover();
  await restarted.stop();
  expect(again.starts).toHaveLength(0);
});

test("0041 charges open agent steps to their harness and counts the sessions mid-turn", async () => {
  // A database as it was before 0041, with steps mid-turn, then migrated.
  const all = fileURLToPath(new URL("../../drizzle", import.meta.url));
  const before = await mkdtemp(join(tmpdir(), "dispand-0040-"));
  onTestFinished(() => rm(before, { recursive: true, force: true }));
  await cp(all, before, { recursive: true });
  const journal = JSON.parse(await readFile(join(all, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag < "0041");
  await writeFile(join(before, "meta/_journal.json"), JSON.stringify(journal));
  const folder = await mkdtemp(join(tmpdir(), "dispand-db-"));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const url = `pglite://${folder}`;
  let db: Db = await createDb(url, before);
  const job = (agentId: string) => ({
    trigger: { type: "manual", field: { id: "t_go", key: "trigger", type: "button", label: "Go" } },
    steps: [{ id: "job", key: "job", type: "agent", name: "Clerk", agentId, prompt: "Work." }],
    edges: [{ from: "t_go", to: "job" }],
  });
  const snapshot = { id: "agent_1", name: "Clerk", harnessId: "h_1", systemPrompt: "Be brief.", skills: [], tools: [], bundles: [], tables: "all" };
  const flow = {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId: "agent_1", prompt: "Write a note." }],
    edges: [{ from: "n_go", to: "n_note" }],
  };
  await db.execute(sql`insert into "user" (id, name, email) values ('user_1', 'Ada', 'ada@example.com')`);
  await db.execute(sql`insert into runners (id, owner_id, name) values ('runner_1', 'user_1', 'Workstation')`);
  await db.execute(sql`insert into harnesses (id, owner_id, name, type, runner_id, kind, permission_mode) values ('h_1', 'user_1', 'Claude', 'cli', 'runner_1', 'claude-code', 'default')`);
  await db.execute(sql`insert into agents (id, owner_id, name, harness_id, system_prompt) values ('agent_1', 'user_1', 'Clerk', 'h_1', 'Be brief.')`);
  await db.execute(sql`insert into workflows (id, owner_id, name, current_version) values ('wf_1', 'user_1', 'Note', 1)`);
  await db.execute(sql`insert into workflow_versions (workflow_id, version, owner_id, def) values ('wf_1', 1, 'user_1', ${JSON.stringify(flow)}::jsonb)`);
  for (const id of ["run_busy", "run_next"]) {
    await db.execute(sql`insert into runs (id, owner_id, source, version, agent_id, def, snapshot, cause, status) values (${id}, 'user_1', 'agent', 0, 'agent_1', ${JSON.stringify(job("agent_1"))}::jsonb, ${JSON.stringify(snapshot)}::jsonb, '{"kind":"user","depth":0}'::jsonb, 'running')`);
    await db.execute(sql`insert into step_runs (id, owner_id, run_id, node_id, status) values (${`${id}_go`}, 'user_1', ${id}, 't_go', 'succeeded')`);
  }
  await db.execute(sql`insert into runs (id, owner_id, workflow_id, version, status) values ('run_flow', 'user_1', 'wf_1', 1, 'running')`);
  await db.execute(sql`insert into step_runs (id, owner_id, run_id, node_id, status) values ('run_flow_go', 'user_1', 'run_flow', 'n_go', 'succeeded')`);
  // Mid-turn: a session working; then a Job and a workflow step not started yet.
  const harness = { id: "h_1", runnerId: "runner_1", kind: "claude-code", permissionMode: "default" };
  const start = { sessionId: "ses_busy", runKey: "run_busy-step", systemPrompt: "Be brief.", prompt: "Work.", expectedOutputs: [], interactive: false };
  await db.execute(
    sql`insert into step_runs (id, owner_id, run_id, node_id, status, session_id, harness, runner_id, start, start_delivered_at) values ('run_busy_job', 'user_1', 'run_busy', 'job', 'running', 'ses_busy', ${JSON.stringify(harness)}::jsonb, 'runner_1', ${JSON.stringify(start)}::jsonb, now())`,
  );
  await db.execute(sql`insert into step_runs (id, owner_id, run_id, node_id, status) values ('run_next_job', 'user_1', 'run_next', 'job', 'pending')`);
  await db.execute(sql`insert into step_runs (id, owner_id, run_id, node_id, status) values ('run_flow_note', 'user_1', 'run_flow', 'n_note', 'pending')`);
  await closeDb(db);

  db = await createDb(url);
  onTestFinished(() => closeDb(db));
  const rows = await db.select({ id: stepRuns.id, harnessId: stepRuns.harnessId, working: stepRuns.working }).from(stepRuns).orderBy(stepRuns.id);
  expect(rows).toEqual([
    { id: "run_busy_go", harnessId: null, working: false },
    { id: "run_busy_job", harnessId: "h_1", working: true },
    { id: "run_flow_go", harnessId: null, working: false },
    { id: "run_flow_note", harnessId: "h_1", working: false },
    { id: "run_next_go", harnessId: null, working: false },
    { id: "run_next_job", harnessId: "h_1", working: false },
  ]);
  expect((await db.select({ maxWorking: harnesses.maxWorking }).from(harnesses))[0]).toEqual({ maxWorking: 5 });

  // With a limit of 1, the session going holds it: the steps not started yet queue.
  await db.update(harnesses).set({ maxWorking: 1 });
  const adapter = new FakeAdapter();
  const engine = new Engine(db, adapter);
  await engine.recover();
  await engine.stop();
  expect(adapter.starts).toHaveLength(0);
  const queued = await db.select({ id: stepRuns.id }).from(stepRuns).where(sql`${stepRuns.queuedAt} is not null`).orderBy(stepRuns.id);
  expect(queued).toEqual([{ id: "run_flow_note" }, { id: "run_next_job" }]);
  expect((await db.select().from(runs).where(eq(runs.id, "run_next")))[0]!.status).toBe("running");
});

test("a step queued for its answer whose run fails leaves the queue; its answer is never sent", async () => {
  const both = (agentId: string): WorkflowDef => ({
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [
      { id: "n_one", key: "one", type: "agent", name: "One", agentId, prompt: "One." },
      { id: "n_two", key: "two", type: "agent", name: "Two", agentId, prompt: "Two." },
    ],
    edges: [
      { from: "n_go", to: "n_one" },
      { from: "n_go", to: "n_two" },
    ],
  });
  const { context, agent, job, step, adapter, engine, emit, started, working } = await setup(2);
  const workflow = await call(router.workflows.create, { name: "Both" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Both", def: both(agent.id) }, { context });
  const run = await engine.startRun(workflow.id);
  const [one, two] = [await step(run, "n_one"), await step(run, "n_two")];
  await emit(one.sessionId!, { type: "question", questionId: "rq_1", payload: choice("Which?") });
  // Waiting on its question, it holds no slot: the next Job takes it.
  expect(await step(run, "n_one")).toMatchObject({ status: "waiting", working: false });
  const other = await job();
  expect(started([run, other])).toEqual([run, run, other]);
  await engine.answer((await questionsOf(context.db, run))[0]!.id, { kind: "choice", answers: { "Which?": "A" } });
  expect(await step(run, "n_one")).toMatchObject({ status: "running", working: false, queueClass: "resume" });

  // The other branch fails: the step queued for its answer leaves the queue.
  await emit(two.sessionId!, { type: "error", message: "The CLI crashed" });
  expect(await step(run, "n_one")).toMatchObject({ queuedAt: null, working: false, pendingAction: null });
  expect(adapter.answers).toEqual([]);
  expect(await working()).toBe(1);
});

test("a chat Job queued on a full harness keeps its first message and sends it after its start", async () => {
  const { context, agent, job, adapter, engine, finish, started, harness } = await setup(1);
  const a = await job();
  const chat = await call(router.triggers.create, { agentId: agent.id, name: "Talk", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: chat.id }, { context: { ...context, engine } });
  const [chatStep] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  expect(chatStep).toMatchObject({ status: "pending", harnessId: harness.id, queueClass: "person" });
  expect(adapter.sent).toEqual([]);
  await call(router.runs.sendChat, { runId, text: "Hello" }, { context: { ...context, engine } });

  adapter.delay = 50;
  await finish(a);
  await vi.waitFor(() => expect(adapter.sent).toHaveLength(1));
  expect(started([a, runId])).toEqual([a, runId]);
  const session = adapter.starts[1]!.start.sessionId;
  expect(adapter.sent).toEqual([[session, "Hello"]]);
  // The message follows its session's start, never ahead of it.
  expect(adapter.log.slice(-2)).toEqual([`start:${session}`, `send:${session}`]);
});

const choice = (question: string) => ({ kind: "choice" as const, questions: [{ question, header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }] }] });
const questionsOf = (db: Db, runId: string) => db.select().from(questions).where(eq(questions.runId, runId)).orderBy(questions.createdAt);

test("with a limit of 1, a Job waiting on a Question lets the next Job run, and its answers queue once until a slot frees", async () => {
  const t = await captureTelemetry();
  onTestFinished(() => t.stop());
  const { context, harness, job, step, adapter, engine, emit, finish, sessionOf, started, working } = await setup(1);
  const a = await job();
  const b = await job({ type: "schedule", scheduledFor: "2026-11-11T09:00:00.000Z" });
  const c = await job({ type: "schedule", scheduledFor: "2026-11-11T09:00:00.000Z" });
  expect(started([a, b, c])).toEqual([a]);
  await emit(sessionOf(a)!, { type: "question", questionId: "rq_1", payload: choice("Which repo?") });
  await emit(sessionOf(a)!, { type: "question", questionId: "rq_2", payload: choice("Which branch?") });
  // a waits on its questions: its slot went to b.
  await vi.waitFor(() => expect(started([a, b, c])).toEqual([a, b]));
  expect(await step(a)).toMatchObject({ status: "waiting", working: false, queuedAt: null });
  expect(await working()).toBe(1);

  const [q1, q2] = await questionsOf(context.db, a);
  await engine.answer(q1!.id, { kind: "choice", answers: { "Which repo?": "A" } });
  // Still waiting on the other: nothing queues, nothing is sent.
  expect(await step(a)).toMatchObject({ status: "waiting", queuedAt: null });
  await engine.answer(q2!.id, { kind: "choice", answers: { "Which branch?": "A" } });
  const queued = await step(a);
  expect(queued).toMatchObject({ status: "running", working: false, queueClass: "resume", pendingAction: { kind: "deliver" } });
  expect(queued.queuedAt).toBeInstanceOf(Date);
  expect(adapter.answers).toEqual([]);
  expect((await questionsOf(context.db, a)).map((q) => q.deliveredAt)).toEqual([null, null]);
  // Queued once: one entry for the step, its place unchanged.
  expect((await context.db.select().from(stepRuns).where(and(eq(stepRuns.harnessId, harness.id), sql`${stepRuns.queuedAt} is not null`))).map((s) => s.runId).sort()).toEqual([a, c].sort());

  // b finishes: a's answers go ahead of c's start (a resume before a new start), each once.
  await finish(b);
  await vi.waitFor(() => expect(adapter.answers).toEqual(["rq_1", "rq_2"]));
  await vi.waitFor(async () => expect((await questionsOf(context.db, a)).every((q) => q.deliveredAt)).toBe(true));
  expect(await step(a)).toMatchObject({ status: "running", working: true, queuedAt: null, pendingAction: null });
  expect(started([a, b, c])).toEqual([a, b]);
  expect(await working()).toBe(1);
  await engine.stop();
  expect(adapter.answers).toEqual(["rq_1", "rq_2"]);
  expect((await t.metrics())).toContainEqual({ name: "dispand.harness.queue_wait", attributes: { "dispand.queue.class": "resume" } });
  const all = await t.all();
  expect(all).not.toContain("Which repo");
  expect(all).not.toContain("Sort the mail");
});

/** A chat Job of the setup's agent, started on a free slot; its first turn has ended. */
async function openChat(s: Awaited<ReturnType<typeof setup>>) {
  const { context, agent, engine, emit, sessionOf } = s;
  const talk = await call(router.triggers.create, { agentId: agent.id, name: "Talk", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: talk.id }, { context: { ...context, engine } });
  s.chat(talk.id);
  await emit(sessionOf(runId)!, { type: "text", delta: "How can I help?" });
  await emit(sessionOf(runId)!, { type: "turn-end" });
  return runId;
}

test("an open chat waiting for its next message holds no slot; its message goes ahead of queued starts", async () => {
  const s = await setup(1);
  const { context, job, step, adapter, engine, emit, finish, sessionOf, started, working } = s;
  const chat = await openChat(s);
  expect(await step(chat)).toMatchObject({ status: "running", working: false });
  expect(await working()).toBe(0);
  const x = await job();
  const y = await job({ type: "schedule", scheduledFor: "2026-11-11T09:00:00.000Z" });
  expect(started([chat, x, y])).toEqual([chat, x]);

  await call(router.runs.sendChat, { runId: chat, text: "Sort my inbox" }, { context: { ...context, engine } });
  expect(await step(chat)).toMatchObject({ working: false, queueClass: "person" });
  expect(adapter.sent).toEqual([]);
  await finish(x);
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionOf(chat), "Sort my inbox"]]));
  expect(await step(chat)).toMatchObject({ working: true, queuedAt: null, pendingAction: null });
  expect(started([chat, x, y])).toEqual([chat, x]);

  // Its turn ends: the slot goes to y.
  await emit(sessionOf(chat)!, { type: "text", delta: "Sorted." });
  await emit(sessionOf(chat)!, { type: "turn-end" });
  await vi.waitFor(() => expect(started([chat, x, y])).toEqual([chat, x, y]));
  expect(await working()).toBe(1);
});

test("a restart between handing an answer or a message a slot and sending it delivers it once", async () => {
  const s = await setup(1);
  const { context, harness, job, step, engine, emit, sessionOf } = s;
  const chat = await openChat(s);
  const a = await job();
  await emit(sessionOf(a)!, { type: "question", questionId: "rq_1", payload: choice("Which?") });
  const b = await job();
  const [q] = await questionsOf(context.db, a);
  await engine.answer(q!.id, { kind: "choice", answers: { "Which?": "A" } });
  await call(router.runs.sendChat, { runId: chat, text: "Hello again" }, { context: { ...context, engine } });
  expect((await step(a)).queueClass).toBe("resume");
  expect((await step(chat)).queueClass).toBe("person");
  await engine.stop();

  // The process stopped right after handing both their slots (b closed, one more slot meanwhile), before sending.
  await context.db.update(stepRuns).set({ status: "succeeded", working: false }).where(eq(stepRuns.id, (await step(b)).id));
  await context.db.update(harnesses).set({ maxWorking: 2 }).where(eq(harnesses.id, harness.id));
  for (const id of [(await step(a)).id, (await step(chat)).id]) {
    await context.db.update(stepRuns).set({ working: true, queuedAt: null, queueClass: null }).where(eq(stepRuns.id, id));
  }
  expect((await step(a)).pendingAction).toEqual({ kind: "deliver" });

  const adapter = new FakeAdapter();
  const restarted = new Engine(context.db, adapter);
  onTestFinished(() => restarted.stop());
  await restarted.recover();
  await vi.waitFor(() => expect(adapter.answers).toEqual(["rq_1"]));
  await vi.waitFor(() => expect(adapter.sent).toEqual([[sessionOf(chat), "Hello again"]]));
  await restarted.stop();
  expect((await questionsOf(context.db, a))[0]!.deliveredAt).toBeInstanceOf(Date);
  expect((await context.db.select().from(messages).where(and(eq(messages.runId, chat), eq(messages.role, "user"))))[0]!.deliveredAt).toBeInstanceOf(Date);
  expect(await step(a)).toMatchObject({ working: true, pendingAction: null });

  // A second restart sends nothing again.
  const again = new FakeAdapter();
  const second = new Engine(context.db, again);
  onTestFinished(() => second.stop());
  await second.recover();
  await second.stop();
  expect(again.answers).toEqual([]);
  expect(again.sent).toEqual([]);
  expect(again.starts).toEqual([]);
});

test("a turn-end applied after the next message was sent keeps the slot for that message's turn", async () => {
  const s = await setup(1);
  const { context, job, step, adapter, engine, emit, sessionOf, started, working } = s;
  const talk = await call(router.triggers.create, { agentId: s.agent.id, name: "Talk", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const { runId: chat } = await call(router.jobs.start, { triggerId: talk.id }, { context: { ...context, engine } });
  s.chat(talk.id);
  await emit(sessionOf(chat)!, { type: "text", delta: "How can I help?" });
  // The runner ended the turn, but the next message went out before its turn-end was applied.
  await call(router.runs.sendChat, { runId: chat, text: "Sort my inbox" }, { context: { ...context, engine } });
  await vi.waitFor(() => expect(adapter.sent).toHaveLength(1));
  await emit(sessionOf(chat)!, { type: "turn-end" });
  expect(await step(chat)).toMatchObject({ working: true });
  const x = await job();
  expect(started([chat, x])).toEqual([chat]);
  // That message's turn ends: the slot goes on.
  await emit(sessionOf(chat)!, { type: "text", delta: "Done." });
  await emit(sessionOf(chat)!, { type: "turn-end" });
  await vi.waitFor(() => expect(started([chat, x])).toEqual([chat, x]));
  expect(await working()).toBe(1);
});

test("a step closed meanwhile takes no slot", async () => {
  const { context, harness, job, step, engine, working } = await setup(2);
  const a = await job();
  await engine.stopRun(a);
  const stopped = await step(a);
  expect(await context.db.transaction((tx) => take(tx, { id: stopped.id, harnessId: harness.id }, "person", { kind: "deliver" }))).toBe("queued");
  expect(await step(a)).toMatchObject({ status: "failed", working: false, queuedAt: null });
  expect(await working()).toBe(0);
});
