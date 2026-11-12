import { call } from "@orpc/server";
import type { HarnessEvent } from "@dispand/runner-protocol";
import { and, asc, eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { audit, harnesses, questions, roots, runs, stepRuns } from "../db/schema.ts";
import { Engine, EngineError } from "../engine/engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "../engine/harness.ts";
import { JOB_STEP } from "../engine/job-def.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";

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

/** A Writer agent on a runner harness with one slot, and its manual trigger. */
async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  await context.db.update(harnesses).set({ maxWorking: 1 }).where(eq(harnesses.id, harness.id));
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Write.", config: { kind: "manual", placement: "button" } }, { context });
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  let seq = 0;
  const stepOf = async (runId: string) => (await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, JOB_STEP))))[0]!;
  const sessionOf = (runId: string) =>
    vi.waitFor(async () => {
      const step = await stepOf(runId);
      if (!step.sessionId || !adapter.starts.some((s) => s.start.sessionId === step.sessionId)) throw new Error("not started");
      return step.sessionId;
    });
  const emit = (sessionId: string, event: HarnessEvent) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  /** The rows of one Job, oldest first. */
  const rowsOf = (jobId: string) => context.db.select().from(audit).where(eq(audit.jobId, jobId)).orderBy(asc(audit.at), asc(audit.id));
  return { context, runnerId, harness, agent, trigger, adapter, engine, emit, sessionOf, stepOf, rowsOf };
}

test("a Job's life from a manual start to its end writes created, queued, started, waiting and finished, in order", async () => {
  const s = await setup();
  // The harness's one slot is taken: the second Job queues behind the first.
  const first = await s.engine.startJob(s.trigger.id, s.context.ownerId);
  const firstSession = await s.sessionOf(first);
  const runId = await s.engine.startJob(s.trigger.id, s.context.ownerId);
  expect((await s.stepOf(runId)).queuedAt).toBeInstanceOf(Date);
  await s.emit(firstSession, { type: "result", text: "Done." });
  const sessionId = await s.sessionOf(runId);
  await s.emit(sessionId, { type: "question", questionId: "rq_1", payload: { kind: "permission", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: false } });
  const [asked] = await s.context.db.select().from(questions).where(eq(questions.runId, runId));
  await s.engine.answer(asked!.id, { kind: "permission", decision: "allow" });
  await s.emit(sessionId, { type: "result", text: "Done." });
  await vi.waitFor(async () => expect((await s.context.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)))[0]!.status).toBe("succeeded"));

  const rows = await s.rowsOf(runId);
  expect(rows.map((r) => r.action)).toEqual(["job.created", "job.queued", "job.started", "job.waiting", "job.finished"]);
  for (const r of rows) expect(r).toMatchObject({ ownerId: s.context.ownerId, jobId: runId, actorAgentId: s.agent.id, resourceType: "job", resourceId: runId });
  const [created, queued, started, waiting, finished] = rows;
  expect(created).toMatchObject({
    actor: { type: "user", userId: s.context.ownerId },
    result: "ok",
    details: { agentId: s.agent.id, agentName: "Writer", triggerId: s.trigger.id, triggerName: "Go", causeKind: "user", firing: "manual" },
  });
  expect(created!.details.rootId).toBeTruthy();
  expect(queued).toMatchObject({ actor: { type: "job", runId }, details: { harnessId: s.harness.id, harnessName: "Claude" } });
  expect(started).toMatchObject({ details: { harnessId: s.harness.id, harnessName: "Claude", runnerId: s.runnerId, runnerName: "Workstation" } });
  expect(waiting).toMatchObject({ details: { questionId: asked!.id } });
  expect(finished).toMatchObject({ result: "ok", details: {} });
  // Nothing of what the Job was told or said.
  expect(JSON.stringify(rows)).not.toMatch(/Write\.|Done\.|"ls"/);
});

test("a stopped Job writes job.failed with the reason stopped, never the error's words", async () => {
  const s = await setup();
  const runId = await s.engine.startJob(s.trigger.id, s.context.ownerId);
  await s.sessionOf(runId);
  await s.engine.stopRun(runId);
  const rows = await s.rowsOf(runId);
  expect(rows.map((r) => r.action)).toEqual(["job.created", "job.started", "job.failed"]);
  expect(rows.at(-1)).toMatchObject({ result: "failed", details: { reason: "stopped" } });
});

test("a failed Job's row says failed, and a resumed session writes job.started with status resumed", async () => {
  const s = await setup();
  const runId = await s.engine.startJob(s.trigger.id, s.context.ownerId);
  const sessionId = await s.sessionOf(runId);
  await s.emit(sessionId, { type: "cli-session", cliSessionId: "cli_1" });
  await s.engine.reconcile(s.runnerId, []);
  await vi.waitFor(() => expect(s.adapter.starts).toHaveLength(2));
  const resumed = (await s.rowsOf(runId)).filter((r) => r.action === "job.started");
  expect(resumed.map((r) => r.details)).toEqual([
    { harnessId: s.harness.id, harnessName: "Claude", runnerId: s.runnerId, runnerName: "Workstation" },
    { status: "resumed", harnessId: s.harness.id, harnessName: "Claude", runnerId: s.runnerId, runnerName: "Workstation" },
  ]);
  await s.emit(s.adapter.starts[1]!.start.sessionId, { type: "error", message: "secret words of the failure" });
  await vi.waitFor(async () => expect((await s.rowsOf(runId)).at(-1)!.action).toBe("job.failed"));
  const failed = (await s.rowsOf(runId)).at(-1)!;
  expect(failed).toMatchObject({ result: "failed", details: { reason: "failed" } });
  expect(JSON.stringify(failed)).not.toContain("secret words");
});

test("a Job refused at a stopped root leaves no row", async () => {
  const s = await setup();
  const runId = await s.engine.startJob(s.trigger.id, s.context.ownerId);
  const [run] = await s.context.db.select({ rootId: runs.rootId }).from(runs).where(eq(runs.id, runId));
  await s.context.db.update(roots).set({ state: "stopped" }).where(eq(roots.id, run!.rootId!));
  const before = await s.context.db.select().from(audit);
  await expect(
    s.context.db.transaction((tx) =>
      s.engine.createJob(tx, { ownerId: s.context.ownerId, agentId: s.agent.id, triggerId: s.trigger.id, cause: { kind: "user", depth: 1 }, firing: { type: "manual" }, rootId: run!.rootId! }),
    ),
  ).rejects.toThrow(EngineError);
  expect(await s.context.db.select().from(audit)).toEqual(before);
});

test("a row whose transaction rolls back is gone with it", async () => {
  const s = await setup();
  await expect(
    s.context.db.transaction(async (tx) => {
      await s.engine.createJob(tx, { ownerId: s.context.ownerId, agentId: s.agent.id, triggerId: s.trigger.id, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } });
      throw new Error("rolled back");
    }),
  ).rejects.toThrow("rolled back");
  expect(await s.context.db.select().from(audit)).toEqual([]);
});

test("a Job whose agent is deleted is stopped and audited, and its rows name the agent as the Job kept it", async () => {
  const s = await setup();
  const runId = await s.engine.startJob(s.trigger.id, s.context.ownerId);
  await s.sessionOf(runId);
  await call(router.agents.delete, { id: s.agent.id }, { context: { ...s.context, engine: s.engine } });
  const rows = await s.rowsOf(runId);
  expect(rows.map((r) => r.action)).toEqual(["job.created", "job.started", "job.failed"]);
  expect(rows.at(-1)).toMatchObject({ actorAgentId: s.agent.id, details: { reason: "stopped" } });
  const listed = await call(router.audit.list, { jobId: runId }, { context: s.context });
  expect(listed.rows.map((r) => [r.action, r.agentName])).toEqual([
    ["job.failed", "Writer (Deleted)"],
    ["job.started", "Writer (Deleted)"],
    // A person's start: no agent acted.
    ["job.created", null],
  ]);
});
