import { call } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { audit, runs, scheduleFires, schedules, stepRuns, triggerFires } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import { Engine, EngineError } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { Scheduler } from "./scheduler.ts";
import { stopTelemetry } from "../telemetry/index.ts";
import { captureTelemetry } from "../telemetry/testing.ts";

/** Records the starts the engine hands over; offline, none reaches the runner. */
class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  online = true;
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    return this.online;
  }
  async send() {
    return this.online;
  }
  async answer() {
    return this.online;
  }
  async stop() {
    return true;
  }
}

/** A clock the test moves. */
function clock(iso: string) {
  let now = new Date(iso);
  return { now: () => now, set: (to: string) => (now = new Date(to)) };
}

const scheduled = (agentId: string, cron = "0 * * * *"): WorkflowDef => ({
  trigger: { type: "schedule", field: { id: "n_s", key: "hourly", type: "schedule", label: "Hourly", cron, timezone: "Europe/Paris" } },
  steps: [{ id: "n_r", key: "report", type: "agent", name: "Report", agentId, prompt: "Report for {{hourly.scheduled_for}}." }],
  edges: [{ from: "n_s", to: "n_r" }],
});

/** A workflow on `def`, saved at 10:05 Paris on 5 Nov 2026 (so its first fire is 11:00). */
async function setup(def: (agentId: string) => WorkflowDef = scheduled) {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(
    await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "acceptEdits" }, { context }),
  );
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const workflow = await call(router.workflows.create, { name: "Report" }, { context });
  const time = clock("2026-11-05T10:05:00+01:00");
  const ctx = { ...context, now: time.now };
  await call(router.workflows.update, { id: workflow.id, name: "Report", def: def(agent.id) }, { context: ctx });
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(context.db, engine, { now: time.now });
  const runsOf = () => context.db.select().from(runs).where(eq(runs.workflowId, workflow.id)).orderBy(asc(runs.createdAt));
  const firesOf = () => context.db.select().from(scheduleFires).where(eq(scheduleFires.workflowId, workflow.id)).orderBy(asc(scheduleFires.scheduledFor));
  const scheduleOf = async () => (await context.db.select().from(schedules).where(eq(schedules.workflowId, workflow.id)))[0];
  return { context, ctx, runnerId, agent, workflow, time, adapter, engine, scheduler, runsOf, firesOf, scheduleOf };
}

test("a due schedule starts one run with scheduled_for", async () => {
  const { time, scheduler, adapter, runsOf, firesOf } = await setup();
  expect(await scheduler.tick()).toEqual([]);
  time.set("2026-11-05T11:00:10+01:00");
  const started = await scheduler.tick();
  expect(started).toHaveLength(1);
  const [run] = await runsOf();
  expect(run).toMatchObject({ id: started[0], trigger: { type: "schedule", scheduledFor: "2026-11-05T10:00:00.000Z" } });
  expect(adapter.starts).toHaveLength(1);
  expect(adapter.starts[0]!.start.prompt).toBe("Report for 2026-11-05T11:00:00+01:00.");
  expect(await firesOf()).toMatchObject([{ status: "started", runId: run!.id, scheduledFor: new Date("2026-11-05T10:00:00Z") }]);
  // The same time never fires again.
  expect(await scheduler.tick()).toEqual([]);
});

test("missed fires coalesce into one run", async () => {
  const { time, scheduler, runsOf, scheduleOf } = await setup();
  // Down from 10:05 to 15:20: 11:00 to 15:00 were missed.
  time.set("2026-11-05T15:20:00+01:00");
  expect(await scheduler.tick()).toHaveLength(1);
  const all = await runsOf();
  expect(all.map((r) => r.trigger)).toEqual([{ type: "schedule", scheduledFor: "2026-11-05T14:00:00.000Z" }]);
  expect((await scheduleOf())!.nextFireAt).toEqual(new Date("2026-11-05T16:00:00+01:00"));
});

test("two schedulers never fire twice", async () => {
  const { context, time, scheduler, engine, runsOf } = await setup();
  const other = new Scheduler(context.db, engine, { now: time.now });
  time.set("2026-11-05T11:00:10+01:00");
  const [a, b] = await Promise.all([scheduler.tick(), other.tick()]);
  expect([...a, ...b]).toHaveLength(1);
  expect(await runsOf()).toHaveLength(1);
});

test("a restart after the claim starts the run once", async () => {
  const { context, time, scheduler, adapter, runsOf } = await setup();
  time.set("2026-11-05T11:00:10+01:00");
  // The claim commits, then the process stops before the run goes on.
  const claimed = await scheduler.claim();
  expect(claimed).toHaveLength(1);
  expect(adapter.starts).toHaveLength(0);
  const restarted = new FakeAdapter();
  const engine = new Engine(context.db, restarted);
  onTestFinished(() => engine.stop());
  await engine.recover();
  expect(restarted.starts).toHaveLength(1);
  expect(restarted.starts[0]!.start.prompt).toBe("Report for 2026-11-05T11:00:00+01:00.");
  expect(await new Scheduler(context.db, engine, { now: time.now }).tick()).toEqual([]);
  expect(await runsOf()).toHaveLength(1);
  expect(restarted.starts).toHaveLength(1);
});

test("a fire while a run is active is skipped and recorded", async () => {
  const { time, scheduler, runsOf, firesOf } = await setup();
  time.set("2026-11-05T11:00:10+01:00");
  await scheduler.tick();
  // The 11:00 run's step is still running at noon.
  time.set("2026-11-05T12:00:10+01:00");
  expect(await scheduler.tick()).toEqual([]);
  expect(await runsOf()).toHaveLength(1);
  expect((await firesOf()).map((f) => [f.status, f.runId === null])).toEqual([
    ["started", false],
    ["skipped-overlap", true],
  ]);
});

test("a disabled schedule doesn't fire", async () => {
  const { ctx, workflow, time, scheduler, runsOf, scheduleOf } = await setup();
  await call(router.workflows.setScheduleEnabled, { id: workflow.id, enabled: false }, { context: ctx });
  time.set("2026-11-05T13:00:10+01:00");
  expect(await scheduler.tick()).toEqual([]);
  // Back on, it doesn't catch up on what fell while it was paused.
  await call(router.workflows.setScheduleEnabled, { id: workflow.id, enabled: true }, { context: ctx });
  expect((await scheduleOf())!.nextFireAt).toEqual(new Date("2026-11-05T14:00:00+01:00"));
  expect(await scheduler.tick()).toEqual([]);
  expect(await runsOf()).toEqual([]);
});

test("an invalid workflow's fire is refused with its issue", async () => {
  const { time, scheduler, runsOf, firesOf } = await setup((agentId) => {
    const def = scheduled(agentId);
    def.steps[0] = { ...def.steps[0]!, prompt: "Report {{nobody.x}}." } as WorkflowDef["steps"][number];
    return def;
  });
  time.set("2026-11-05T11:00:10+01:00");
  expect(await scheduler.tick()).toEqual([]);
  expect(await runsOf()).toEqual([]);
  expect(await firesOf()).toMatchObject([{ status: "refused", runId: null, message: "{{nobody.x}}: no step is called “nobody”" }]);
});

test("a scheduled run's first session starts once the runner says hello", async () => {
  const { context, runnerId, time, scheduler, adapter, engine } = await setup();
  adapter.online = false;
  time.set("2026-11-05T11:00:10+01:00");
  const [runId] = await scheduler.tick();
  expect(adapter.starts).toHaveLength(1);
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.nodeId, "n_r"));
  expect(step).toMatchObject({ runId, status: "running", startDeliveredAt: null });
  adapter.online = true;
  await engine.reconcile(runnerId, []);
  expect(adapter.starts).toHaveLength(2);
  expect(adapter.starts[1]!.start.sessionId).toBe(adapter.starts[0]!.start.sessionId);
});

test("a run whose continuation failed is retried on the next tick", async () => {
  const { time, scheduler, engine, adapter, firesOf } = await setup();
  const continueRun = engine.continueRun.bind(engine);
  let failures = 1;
  engine.continueRun = async (runId) => {
    if (failures-- > 0) throw new Error("connection reset");
    return continueRun(runId);
  };
  time.set("2026-11-05T11:00:10+01:00");
  expect(await scheduler.tick()).toHaveLength(1);
  expect(adapter.starts).toHaveLength(0);
  expect(await scheduler.tick()).toEqual([]);
  expect(adapter.starts).toHaveLength(1);
  expect((await firesOf()).map((f) => f.status)).toEqual(["started"]);
});

test("a fire that failed is tried again on the next tick, for the same time", async () => {
  const { time, scheduler, engine, runsOf, firesOf } = await setup();
  const createRun = engine.createRun.bind(engine);
  let failures = 1;
  engine.createRun = async (...args) => {
    if (failures-- > 0) throw new Error("deadlock detected");
    return createRun(...args);
  };
  time.set("2026-11-05T11:00:10+01:00");
  expect(await scheduler.tick()).toEqual([]);
  expect(await firesOf()).toEqual([]);
  time.set("2026-11-05T11:00:25+01:00");
  expect(await scheduler.tick()).toHaveLength(1);
  expect((await runsOf()).map((r) => r.trigger)).toEqual([{ type: "schedule", scheduledFor: "2026-11-05T10:00:00.000Z" }]);
  expect((await firesOf()).map((f) => f.status)).toEqual(["started"]);
});

// Schedule triggers: the same rules, on an agent's trigger, each fire a Job.

/** An agent's schedule trigger (hourly by default), saved at 10:05 Paris on 5 Nov 2026. */
async function triggerSetup(cron = "0 * * * *", at = "2026-11-05T10:05:00+01:00", concurrency: "parallel" | "one-at-a-time" = "one-at-a-time") {
  const s = await setup();
  await call(router.workflows.delete, { id: s.workflow.id }, { context: s.context });
  s.time.set(at);
  const trigger = await call(
    router.triggers.create,
    { agentId: s.agent.id, name: "Hourly", instructions: "Report for {{trigger.scheduled_for}}.", concurrency, config: { kind: "schedule", cron, timezone: "Europe/Paris" } },
    { context: s.ctx },
  );
  const jobsOf = () => s.context.db.select().from(runs).where(eq(runs.triggerId, trigger.id)).orderBy(asc(runs.createdAt));
  const firesOf = () => s.context.db.select().from(triggerFires).where(eq(triggerFires.triggerId, trigger.id)).orderBy(asc(triggerFires.scheduledFor));
  return { ...s, trigger, jobsOf, firesOf };
}

test("fires a due schedule trigger once and records the fire", async () => {
  const { ctx, time, scheduler, adapter, agent, trigger, jobsOf, firesOf } = await triggerSetup();
  expect(await scheduler.tick()).toEqual([]);
  time.set("2026-11-05T11:00:10+01:00");
  const started = await scheduler.tick();
  expect(started).toHaveLength(1);
  const [job] = await jobsOf();
  expect(job).toMatchObject({
    id: started[0],
    source: "agent",
    agentId: agent.id,
    trigger: { type: "schedule", scheduledFor: "2026-11-05T10:00:00.000Z" },
    cause: { kind: "schedule", scheduledFor: "2026-11-05T10:00:00.000Z", depth: 0 },
  });
  expect(adapter.starts).toHaveLength(1);
  expect(adapter.starts[0]!.start.prompt).toBe("Report for 2026-11-05T11:00:00+01:00.");
  expect(await firesOf()).toMatchObject([{ status: "started", runId: job!.id, scheduledFor: new Date("2026-11-05T10:00:00Z") }]);
  expect((await call(router.triggers.get, { id: trigger.id }, { context: ctx })).lastFires).toMatchObject([
    { status: "started", runId: job!.id },
  ]);
  // The same time never fires again.
  expect(await scheduler.tick()).toEqual([]);
  expect(await jobsOf()).toHaveLength(1);
});

test("coalesces missed times into one fire for the latest", async () => {
  const { time, scheduler, jobsOf, firesOf } = await triggerSetup();
  time.set("2026-11-05T14:20:00+01:00");
  expect(await scheduler.tick()).toHaveLength(1);
  expect(await jobsOf()).toMatchObject([{ trigger: { type: "schedule", scheduledFor: "2026-11-05T13:00:00.000Z" } }]);
  expect(await firesOf()).toHaveLength(1);
});

test("one-at-a-time skips while the trigger's Job is running; parallel doesn't", async () => {
  const one = await triggerSetup();
  one.time.set("2026-11-05T11:00:10+01:00");
  expect(await one.scheduler.tick()).toHaveLength(1);
  one.time.set("2026-11-05T12:00:10+01:00");
  expect(await one.scheduler.tick()).toEqual([]);
  expect(await one.firesOf()).toMatchObject([{ status: "started" }, { status: "skipped-overlap", runId: null }]);
  expect(await one.jobsOf()).toHaveLength(1);
  // The skipped firing is in Audit: the scheduler's, on the trigger, with the fire status.
  expect(await one.context.db.select().from(audit).where(eq(audit.action, "job.skipped"))).toMatchObject([
    {
      actor: { type: "scheduler" },
      actorAgentId: one.agent.id,
      jobId: null,
      resourceType: "trigger",
      resourceId: one.trigger.id,
      details: { triggerId: one.trigger.id, agentId: one.agent.id, firing: "schedule", reason: "skipped-overlap" },
    },
  ]);

  const many = await triggerSetup("0 * * * *", "2026-11-05T10:05:00+01:00", "parallel");
  many.time.set("2026-11-05T11:00:10+01:00");
  expect(await many.scheduler.tick()).toHaveLength(1);
  many.time.set("2026-11-05T12:00:10+01:00");
  expect(await many.scheduler.tick()).toHaveLength(1);
  expect(await many.firesOf()).toMatchObject([{ status: "started" }, { status: "started" }]);
});

test("a fire the engine refuses is recorded with its message, and the next time fires", async () => {
  const { time, scheduler, engine, jobsOf, firesOf } = await triggerSetup();
  time.set("2026-11-05T11:00:10+01:00");
  const create = vi.spyOn(engine, "createJob").mockRejectedValueOnce(new EngineError("NOT_FOUND", "Agent not found"));
  expect(await scheduler.tick()).toEqual([]);
  expect(await firesOf()).toMatchObject([{ status: "refused", message: "Agent not found", runId: null }]);
  create.mockRestore();
  // Not left due forever: the refused time is done, the next one fires.
  expect(await scheduler.tick()).toEqual([]);
  time.set("2026-11-05T12:00:10+01:00");
  expect(await scheduler.tick()).toHaveLength(1);
  expect(await jobsOf()).toHaveLength(1);
});

test("a trigger whose agent is gone is gone with it: nothing fires, nothing throws", async () => {
  const { context, time, scheduler, agent } = await triggerSetup();
  await call(router.agents.delete, { id: agent.id }, { context });
  time.set("2026-11-05T11:00:10+01:00");
  expect(await scheduler.tick()).toEqual([]);
  expect(await context.db.select().from(triggerFires)).toEqual([]);
});

test("a disabled trigger is not claimed", async () => {
  const { ctx, time, scheduler, trigger, firesOf } = await triggerSetup();
  await call(router.triggers.update, { id: trigger.id, enabled: false }, { context: ctx });
  time.set("2026-11-05T11:00:10+01:00");
  expect(await scheduler.tick()).toEqual([]);
  expect(await firesOf()).toEqual([]);
});

test("a manual trigger is never claimed", async () => {
  const { ctx, time, scheduler, agent, context } = await triggerSetup();
  await call(router.triggers.create, { agentId: agent.id, name: "Ask", instructions: "Do it.", config: { kind: "manual", placement: "button" } }, { context: ctx });
  time.set("2026-11-05T11:00:10+01:00");
  expect(await scheduler.tick()).toHaveLength(1);
  expect(await context.db.select().from(runs)).toHaveLength(1);
});

test("a daily 02:30 trigger fires once on the day 02:30 comes twice, and at most once on the day it never comes", async () => {
  // 25 Oct 2026: clocks go back at 03:00, so 02:30 comes twice in Paris.
  const back = await triggerSetup("30 2 * * *", "2026-10-24T12:00:00+02:00", "parallel");
  back.time.set("2026-10-25T02:31:00+02:00");
  expect(await back.scheduler.tick()).toHaveLength(1);
  back.time.set("2026-10-25T02:31:00+01:00");
  expect(await back.scheduler.tick()).toEqual([]);
  back.time.set("2026-10-25T23:00:00+01:00");
  expect(await back.scheduler.tick()).toEqual([]);
  expect(await back.jobsOf()).toHaveLength(1);

  // 28 Mar 2027: clocks go forward at 02:00, so 02:30 never comes.
  const forward = await triggerSetup("30 2 * * *", "2027-03-27T12:00:00+01:00", "parallel");
  for (const at of ["2027-03-28T01:59:00+01:00", "2027-03-28T03:01:00+02:00", "2027-03-28T03:31:00+02:00", "2027-03-28T23:00:00+02:00"]) {
    forward.time.set(at);
    await forward.scheduler.tick();
  }
  expect((await forward.jobsOf()).length).toBeLessThanOrEqual(1);
});

test("a fire that failed is tried again on the next tick, for the same time, on a trigger", async () => {
  const { time, scheduler, engine, jobsOf, firesOf } = await triggerSetup();
  time.set("2026-11-05T11:00:10+01:00");
  const create = vi.spyOn(engine, "createJob").mockRejectedValueOnce(new Error("database hiccup"));
  expect(await scheduler.tick()).toEqual([]);
  expect(await firesOf()).toEqual([]);
  create.mockRestore();
  expect(await scheduler.tick()).toHaveLength(1);
  expect(await jobsOf()).toMatchObject([{ trigger: { type: "schedule", scheduledFor: "2026-11-05T10:00:00.000Z" } }]);
});

test("one tick that fires a schedule trigger is one trace: the tick, the fire, the Job created in it, which keeps its trace id", async () => {
  const { time, scheduler, jobsOf } = await triggerSetup();
  const t = await captureTelemetry();
  onTestFinished(() => stopTelemetry());
  time.set("2026-11-05T11:00:10+01:00");
  const [runId] = await scheduler.tick();
  const tick = t.spans().find((s) => s.name === "scheduler.tick")!;
  const fire = t.spans().find((s) => s.name === "scheduler.fire")!;
  expect(tick.attributes).toMatchObject({ "dispand.scheduler.started": 1 });
  expect(fire.parentSpanContext?.spanId).toBe(tick.spanContext().spanId);
  expect(fire.attributes).toMatchObject({ "dispand.fire.kind": "trigger", "dispand.fire.result": "started", "dispand.job.id": runId });
  const [job] = await jobsOf();
  expect(job!.traceId).toBe(tick.spanContext().traceId);
  const points = await t.metrics();
  expect(points).toContainEqual({ name: "dispand.scheduler.fires", attributes: { "dispand.fire.kind": "trigger", "dispand.fire.result": "started" } });
  expect(points).toContainEqual({ name: "dispand.scheduler.lag", attributes: { "dispand.fire.kind": "trigger" } });
  expect(points).toContainEqual({ name: "dispand.runs.created", attributes: { "dispand.run.source": "agent", "dispand.run.trigger": "schedule" } });
});
