import { call } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { runs, scheduleFires, schedules, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { Scheduler } from "./scheduler.ts";

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
