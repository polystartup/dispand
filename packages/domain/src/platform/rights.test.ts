import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { runs } from "../db/schema.ts";
import type { MemoryTarget } from "../memory/model.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { rightsOf, type JobIdentity } from "./rights.ts";

/** An agent learning into `selfLearning`, a Job of it still going, and how to change the agent's targets. */
async function setup(selfLearning: MemoryTarget[]) {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const base = { name: "Clerk", harnessId: harness.id, systemPrompt: "" };
  const agent = await call(router.agents.create, { ...base, bundles: ["data"], selfLearning }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const job: JobIdentity = { runId, ownerId: context.ownerId, agentId: agent.id };
  const setTargets = (targets: MemoryTarget[]) => call(router.agents.update, { ...base, id: agent.id, selfLearning: targets }, { context });
  return { context, agent, job, base, setTargets };
}

test("the Job's snapshot keeps the self-learning targets the agent had when it was created", async () => {
  const s = await setup(["agent", "data"]);
  expect(s.agent.selfLearning).toEqual(["agent", "data"]);
  await s.setTargets(["workspace"]);
  const [run] = await s.context.db.select({ snapshot: runs.snapshot }).from(runs).where(eq(runs.id, s.job.runId));
  expect(run!.snapshot!.selfLearning).toEqual(["agent", "data"]);
});

test("a target taken from the agent leaves its running Job at once, and one added later never reaches it", async () => {
  const s = await setup(["agent", "data"]);
  expect((await rightsOf(s.context.db, s.job))!.selfLearning).toEqual(["agent", "data"]);
  await s.setTargets(["agent", "workspace"]);
  expect((await rightsOf(s.context.db, s.job))!.selfLearning).toEqual(["agent"]);
  // Given back, a target the snapshot had applies again; one it never had doesn't.
  await s.setTargets(["agent", "data", "workspace"]);
  expect((await rightsOf(s.context.db, s.job))!.selfLearning).toEqual(["agent", "data"]);
  await s.setTargets([]);
  expect((await rightsOf(s.context.db, s.job))!.selfLearning).toEqual([]);
});

test("an agent learns nothing by default, and an update that leaves the targets out keeps them", async () => {
  const s = await setup([]);
  expect(s.agent.selfLearning).toEqual([]);
  expect((await rightsOf(s.context.db, s.job))!.selfLearning).toEqual([]);
  await s.setTargets(["workspace", "workspace"]);
  const kept = await call(router.agents.update, { ...s.base, id: s.agent.id, systemPrompt: "Changed." }, { context: s.context });
  expect(kept.selfLearning).toEqual(["workspace"]);
  await expect(call(router.agents.update, { ...s.base, id: s.agent.id, selfLearning: ["tables"] as never }, { context: s.context })).rejects.toThrow();
});

test("a Job of an agent made before self-learning existed writes nowhere", async () => {
  const s = await setup(["agent"]);
  const [run] = await s.context.db.select({ snapshot: runs.snapshot }).from(runs).where(eq(runs.id, s.job.runId));
  const old = { ...run!.snapshot! };
  delete old.selfLearning;
  await s.context.db.update(runs).set({ snapshot: old }).where(eq(runs.id, s.job.runId));
  expect((await rightsOf(s.context.db, s.job))!.selfLearning).toEqual([]);
});

test("a Job of a deleted agent has no rights, so no target, though its snapshot keeps what it had", async () => {
  const s = await setup(["agent", "workspace"]);
  await call(router.agents.delete, { id: s.agent.id }, { context: s.context });
  expect(await rightsOf(s.context.db, s.job)).toBeNull();
  const [run] = await s.context.db.select({ agentId: runs.agentId, snapshot: runs.snapshot }).from(runs).where(eq(runs.id, s.job.runId));
  expect(run).toMatchObject({ agentId: null, snapshot: { selfLearning: ["agent", "workspace"] } });
});
