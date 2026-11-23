import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { harnesses, organizationMembers, runners, runs, stepRuns, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { jobIdentity, ownerContext } from "../runners/test-support.ts";
import { runnerForRun, sessionHarness } from "./session-harness.ts";
import type { WorkflowNode } from "../workflows/model.ts";

/** A Job of the owner's agent, as a second member of the workspace would have started it. */
async function setup() {
  const context = await ownerContext();
  const { db, organizationId, workspaceId } = context;
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Help." }, { context });
  const { runId } = await jobIdentity(context, agent.id);
  await db.insert(user).values({ id: "user_bo", name: "Bo", email: "bo@example.com" });
  await db.insert(organizationMembers).values({ organizationId, userId: "user_bo", role: "member" });
  await db.insert(workspaceMembers).values({ workspaceId, userId: "user_bo", role: "member" });
  await db.update(runs).set({ ownerId: "user_bo" }).where(eq(runs.id, runId));
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const [step] = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  return { context, runnerId, harnessId: harness.id, run: run!, step: step!, node: { id: step!.nodeId, agentId: agent.id } as WorkflowNode };
}

test("a member's Job runs on the workspace's harness and runner, whoever made them", async () => {
  const { context, runnerId, harnessId, run, step, node } = await setup();
  const resolved = await sessionHarness(context.db, run, node, step);
  expect("problem" in resolved ? resolved.problem : resolved.h.id).toBe(harnessId);
  expect("problem" in resolved ? undefined : resolved.runnerRow?.id).toBe(runnerId);
  const [placed] = await context.db.select({ placed: runnerForRun(context.db, runnerId) }).from(runs).where(eq(runs.id, run.id));
  expect(placed?.placed).toBe(true);
});

test("a harness or runner of another workspace never runs a Job, even its starter's own", async () => {
  const { context, runnerId, harnessId, run, step, node } = await setup();
  const { db, organizationId } = context;
  const own = { ...run, ownerId: context.ownerId };
  await db.insert(workspaces).values({ id: "ws-b", organizationId });
  await db.update(harnesses).set({ workspaceId: "ws-b" }).where(eq(harnesses.id, harnessId));
  expect(await sessionHarness(db, own, node, step)).toEqual({ problem: expect.anything() });
  await db.update(harnesses).set({ workspaceId: run.workspaceId }).where(eq(harnesses.id, harnessId));
  await db.update(runners).set({ workspaceId: "ws-b" }).where(eq(runners.id, runnerId));
  expect(await sessionHarness(db, own, node, step)).toEqual({ problem: expect.anything() });
  const [placed] = await db.select({ placed: runnerForRun(db, runnerId) }).from(runs).where(eq(runs.id, run.id));
  expect(placed?.placed).toBe(false);
});
