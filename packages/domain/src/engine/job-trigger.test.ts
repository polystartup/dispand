import { call } from "@orpc/server";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { eventFires, events, questions, roots, runs, stepRuns, workspaceSettings } from "../db/schema.ts";
import { callPlatformTool } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, approveAs, asCli, ownerContext } from "../runners/test-support.ts";
import { JOB } from "../triggers/model.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { Scheduler } from "./scheduler.ts";

class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    return true;
  }
  async send() {
    return true;
  }
  async answer() {
    return true;
  }
  async stop() {
    return true;
  }
}

/** Content a Job's end carries: none of it may reach an event or another agent's prompt. */
const RESULT = "The merger is signed at 4.2 million";
const ERROR = "The merger file is unreadable: key sk-sentinel-1";

/** A Worker with a button trigger, and agents with no bundle that watch Jobs. */
async function setup(opts: { checkpoint?: number } = {}) {
  const context = await ownerContext();
  if (opts.checkpoint) await context.db.insert(workspaceSettings).values({ workspaceId: context.workspaceId, checkpoint: opts.checkpoint });
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = (name: string, bundles: ("data" | "configure")[] = []) => call(router.agents.create, { name, harnessId: harness.id, systemPrompt: "", bundles }, { context });
  const onJobs = (agentId: string, operations: ("created" | "finished" | "failed")[]) =>
    call(router.triggers.create, { agentId, name: "On Jobs", instructions: "Look into it.", config: { kind: "primitive", tableId: JOB, operations } }, { context });
  const worker = await agent("Worker");
  const go = await call(router.triggers.create, { agentId: worker.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(context.db, engine);
  let seq = 0;
  const start = async (triggerId = go.id) => (await call(router.jobs.start, { triggerId }, { context })).runId;
  const sessionOf = async (runId: string) => {
    await vi.waitFor(async () => expect((await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)))[0]?.sessionId).toBeTruthy());
    return (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)))[0]!.sessionId!;
  };
  const emit = async (runId: string, event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(await sessionOf(runId), event, { runnerId, seq: ++seq });
  const jobEvents = (runId: string) => context.db.select().from(events).where(and(eq(events.tableId, JOB), eq(events.rowId, runId))).orderBy(asc(events.createdAt));
  const firesOf = (triggerId: string) => context.db.select().from(eventFires).where(eq(eventFires.triggerId, triggerId)).orderBy(asc(eventFires.createdAt));
  const jobsOf = (triggerId: string) => context.db.select().from(runs).where(eq(runs.triggerId, triggerId)).orderBy(asc(runs.createdAt));
  const runOf = async (runId: string) => (await context.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
  return { context, harness, adapter, engine, scheduler, agent, onJobs, worker, go, start, emit, jobEvents, firesOf, jobsOf, runOf };
}

test("a Job's creation and end each record one event of ids and its status, never its result or error", async () => {
  const s = await setup();
  const done = await s.start();
  const failed = await s.start();
  await s.emit(done, { type: "result", text: RESULT });
  await s.emit(failed, { type: "error", message: ERROR });
  await vi.waitFor(async () => expect((await s.runOf(failed)).status).toBe("failed"));
  const after = (status: string) => ({ agentId: s.worker.id, triggerId: s.go.id, causeKind: "user", status });
  expect((await s.jobEvents(done)).map((e) => [e.operation, e.after, e.actor])).toEqual([
    ["created", after("running"), { type: "job", runId: done }],
    ["finished", after("succeeded"), { type: "job", runId: done }],
  ]);
  expect((await s.jobEvents(failed)).map((e) => [e.operation, e.after])).toEqual([
    ["created", after("running")],
    ["failed", after("failed")],
  ]);
  for (const e of [...(await s.jobEvents(done)), ...(await s.jobEvents(failed))]) {
    expect(JSON.stringify(e)).not.toContain("merger");
    expect(e.rootId).toBe((await s.runOf(e.rowId)).rootId);
  }
});

test("a trigger on Jobs failed, for an agent with no bundle, starts its Job when another agent's Job fails, told its id and agent, never its error", async () => {
  const s = await setup();
  const watcher = await s.agent("Watcher");
  const trigger = await s.onJobs(watcher.id, ["failed"]);
  const job = await s.start();
  // Its creation matches nothing.
  expect(await s.scheduler.tick()).toEqual([]);
  await s.emit(job, { type: "error", message: ERROR });
  await vi.waitFor(async () => expect((await s.runOf(job)).status).toBe("failed"));
  const [started] = await s.scheduler.tick();
  expect(started).toBeDefined();
  await vi.waitFor(() => expect(s.adapter.starts.some((st) => st.start.prompt?.includes("Look into it."))).toBe(true));
  const prompt = s.adapter.starts.find((st) => st.start.prompt?.includes("Look into it."))!.start.prompt!;
  expect(prompt).toContain(`A Job of the agent Worker (${s.worker.id}) was failed: ${job}, status failed.`);
  expect(prompt).not.toContain("merger");
  expect(prompt).not.toContain("sk-sentinel");
  const [watching] = await s.jobsOf(trigger.id);
  expect(watching).toMatchObject({ id: started, status: "running", cause: { kind: "event", jobId: job, depth: 1 }, rootId: (await s.runOf(job)).rootId });
});

test("a trigger on Jobs made through an approved proposal starts its Job when another agent's Job finishes", async () => {
  const s = await setup();
  const builder = await s.agent("Builder", ["configure"]);
  const watcher = await s.agent("Watcher");
  const build = await call(router.triggers.create, { agentId: builder.id, name: "Build", instructions: "Build.", config: { kind: "manual", placement: "button" } }, { context: s.context });
  const builderJob = { runId: await s.start(build.id), ownerId: s.context.ownerId, workspaceId: s.context.workspaceId, agentId: builder.id };
  const tool = (name: string, input: unknown) => callPlatformTool(s.context, builderJob, name, input);
  const proposed = await tool("propose", {
    items: [{ tool: "triggers_create", input: { agentId: watcher.id, name: "On Jobs", instructions: "Look into it.", config: { kind: "primitive", tableId: JOB, operations: ["finished"] } } }],
  });
  expect(proposed).toMatchObject({ ok: true });
  const proposalId = (proposed as { output: { proposalId: string } }).output.proposalId;
  await approveAs(s.context.db, proposalId, s.context.ownerId);
  const applied = await tool("proposal_apply", { proposalId });
  expect(applied).toMatchObject({ ok: true, output: { items: [{ outcome: "made" }] } });
  const triggerId = (applied as { output: { items: { id: string }[] } }).output.items[0]!.id;
  await s.scheduler.tick();
  const job = await s.start();
  await s.emit(job, { type: "result", text: RESULT });
  const started = await s.scheduler.tick();
  expect(started).toHaveLength(1);
  expect((await s.jobsOf(triggerId)).map((r) => r.id)).toEqual(started);
});

test("a Job's own creation and end never fire its own agent's trigger on Jobs", async () => {
  const s = await setup();
  const own = await s.onJobs(s.worker.id, ["created", "finished"]);
  const job = await s.start();
  await s.emit(job, { type: "result", text: RESULT });
  expect(await s.scheduler.tick()).toEqual([]);
  expect((await s.firesOf(own.id)).map((f) => f.status)).toEqual(["skipped-same-agent", "skipped-same-agent"]);
});

test("a trigger on Jobs takes their operations only and no fields", async () => {
  const s = await setup();
  const make = (config: unknown) => call(router.triggers.create, { agentId: s.worker.id, name: "x", instructions: "x", config } as never, { context: s.context });
  await expect(make({ kind: "primitive", tableId: JOB, operations: ["updated"] })).rejects.toMatchObject({ data: { key: "triggers.invalid.operations" } });
  await expect(make({ kind: "primitive", tableId: JOB, operations: ["created"], fields: ["f"] })).rejects.toMatchObject({ data: { key: "triggers.invalid.noFields" } });
  expect((await make({ kind: "primitive", tableId: JOB, operations: ["finished", "failed"] })).config).toEqual({ kind: "primitive", tableId: JOB, operations: ["finished", "failed"] });
});

test("two agents firing on each other's Jobs stay in one root and pause at its checkpoint with one Approval", async () => {
  const s = await setup({ checkpoint: 4 });
  const ping = await s.agent("Ping");
  const pong = await s.agent("Pong");
  await s.onJobs(ping.id, ["created"]);
  await s.onJobs(pong.id, ["created"]);
  const first = await s.start();
  const rootId = (await s.runOf(first)).rootId!;
  for (let i = 0; i < 10; i++) if ((await s.scheduler.tick()).length === 0) break;
  const [root] = await s.context.db.select().from(roots).where(eq(roots.id, rootId));
  expect(root).toMatchObject({ state: "paused", jobs: 4 });
  expect(await s.context.db.select().from(questions).where(isNotNull(questions.rootId))).toHaveLength(1);
  // Every Job of the chain is the root's; none past the checkpoint.
  const chain = await s.context.db.select().from(runs).where(eq(runs.rootId, rootId));
  expect(chain).toHaveLength(4);
  expect(await s.scheduler.tick()).toEqual([]);
});
