import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { stepRuns } from "../db/schema.ts";
import { Engine } from "../engine/engine.ts";
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

/** A harness at `limit`, an agent on it with a button trigger, and an engine the procedures use. */
async function setup(limit: number) {
  const base = await ownerContext();
  const adapter = new FakeAdapter();
  const engine = new Engine(base.db, adapter);
  onTestFinished(() => engine.stop());
  const context = { ...base, engine };
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "acceptEdits" }, { context }));
  await call(router.harnesses.setLimit, { id: harness.id, maxWorking: limit }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Sort the mail.", config: { kind: "manual", placement: "button" } }, { context });
  const job = async () => (await call(router.jobs.start, { triggerId: trigger.id }, { context })).runId;
  const working = async () => (await context.db.select().from(stepRuns).where(and(eq(stepRuns.harnessId, harness.id), eq(stepRuns.working, true)))).length;
  const stepOf = async (runId: string) => (await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, JOB_STEP))))[0]!;
  return { context, harness, adapter, job, working, stepOf };
}

test("the limits list gives every harness its limit, and its sessions working and steps queued now", async () => {
  const { context, harness, job } = await setup(1);
  await job();
  await job();
  expect(await call(router.harnesses.limits, undefined, { context })).toEqual([{ id: harness.id, name: "Claude", kind: "claude-code", maxWorking: 1, working: 1, queued: 1 }]);
});

test("a limit is a whole number from 1 to 100, of one of the owner's harnesses", async () => {
  const { context, harness } = await setup(5);
  for (const maxWorking of [0, 101, 2.5]) {
    await expect(call(router.harnesses.setLimit, { id: harness.id, maxWorking }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  await expect(call(router.harnesses.setLimit, { id: "harness_other", maxWorking: 3 }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("raising a limit starts queued steps at once; lowering it stops nothing, and new work waits until fewer work", async () => {
  const { context, harness, adapter, job, working, stepOf } = await setup(1);
  const a = await job();
  const b = await job();
  const c = await job();
  expect(adapter.starts).toHaveLength(1);
  await call(router.harnesses.setLimit, { id: harness.id, maxWorking: 3 }, { context });
  await expect.poll(() => adapter.starts.length).toBe(3);
  expect((await stepOf(c)).working).toBe(true);
  // Lowered under what works: the three go on, a new one waits.
  await call(router.harnesses.setLimit, { id: harness.id, maxWorking: 1 }, { context });
  expect(await working()).toBe(3);
  const d = await job();
  expect((await stepOf(d)).queuedAt).toBeInstanceOf(Date);
  expect(adapter.starts).toHaveLength(3);
  expect([(await stepOf(a)).working, (await stepOf(b)).working]).toEqual([true, true]);
});
