import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { chatQueue, stepRuns, organizationMembers, organizations, runs, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { queuedView } from "../engine/views.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, ownerContext } from "../runners/test-support.ts";
import type { WorkflowDef } from "../workflows/model.ts";

test("a signed-in person's job reads follow current workspace access, including an open stream", async () => {
  const context = await ownerContext();
  const { db, ownerId: reader } = context;
  const [engineering] = await db.select().from(workspaces);
  const { id: engineeringId, organizationId } = engineering!;
  await db.insert(user).values({ id: "author", name: "Author", email: "author@example.com" });
  await db.insert(organizationMembers).values({ organizationId, userId: "author", role: "member" });
  await db.insert(organizations).values({ id: "other-org" });
  await db.insert(organizationMembers).values({ organizationId: "other-org", userId: "author", role: "owner" });
  await db.insert(workspaces).values([
    { id: "finance", organizationId },
    { id: "foreign", organizationId: "other-org" },
  ]);
  const def: WorkflowDef = { trigger: { type: "manual", field: { type: "button", id: "start", key: "start", label: "Start" } }, steps: [], edges: [] };
  const runId = "job-engineering";
  const financeJob = "job-finance";
  const foreignJob = "job-foreign";
  for (const [id, workspaceId] of [[runId, engineeringId], [financeJob, "finance"], [foreignJob, "foreign"]] as const) {
    await db.insert(runs).values({ id, workspaceId, ownerId: "author", source: "agent", version: 0, status: "running", def });
  }

  await db.insert(runs).values({ id: "workflow-run", workspaceId: engineeringId, ownerId: "author", source: "workflow", version: 1, status: "running" });
  await db.insert(stepRuns).values({ id: "step", runId, nodeId: "node", status: "running" });
  const [draft] = await db.insert(chatQueue).values({ id: "draft", ownerId: "author", runId, stepRunId: "step", text: "unsent" }).returning();
  const get = (runId: string) => call(router.runs.get, { runId }, { context });
  const missing = { code: "NOT_FOUND" };
  const jobContext = { ...context, job: { runId, ownerId: "author", workspaceId: context.workspaceId, agentId: "worker" } };
  await expect(call(router.jobs.get, { id: runId }, { context: jobContext })).resolves.toMatchObject({ id: runId });
  await expect(call(router.jobs.get, { id: financeJob }, { context: jobContext })).rejects.toMatchObject(missing);
  // No workspace assignment: the organization's owner inherits only that organization's workspaces.
  await expect(get(financeJob)).resolves.toMatchObject({ run: { id: financeJob } });
  // With several workspaces and none named, a session finds no workspace to list plugins of.
  await expect(call(router.plugins.list, undefined, { context })).rejects.toMatchObject(missing);
  // A Job is placed by its run: it lists the plugins of its own workspace.
  await expect(call(router.plugins.list, undefined, { context: jobContext })).resolves.toEqual([]);
  await expect(get(foreignJob)).rejects.toMatchObject(missing);

  await db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, reader));
  await db.insert(workspaceMembers).values({ workspaceId: engineeringId, userId: reader, role: "member" });
  const snapshot = await get(runId);
  expect(snapshot.run.id).toBe(runId);
  expect(snapshot.queue).toEqual([]);
  await expect(get("workflow-run")).rejects.toMatchObject(missing);
  await expect(call(router.runs.access, { runId }, { context })).resolves.toEqual({ canManage: false });
  await expect(call(router.jobs.def, { runId }, { context })).resolves.toEqual(def);
  await expect(call(router.jobs.get, { id: runId }, { context })).resolves.toMatchObject({ id: runId });
  // The original job owner still needs current access to the workspace.
  await db.update(runs).set({ ownerId: reader }).where(eq(runs.id, financeJob));
  await expect(call(router.runs.stop, { runId: financeJob }, { context })).rejects.toMatchObject(missing);
  await expect(get(financeJob)).rejects.toMatchObject(missing);
  await expect(call(router.jobs.def, { runId: financeJob }, { context })).rejects.toMatchObject(missing);
  await expect(call(router.jobs.get, { id: financeJob }, { context })).rejects.toMatchObject(missing);
  await expect(call(router.runs.stop, { runId }, { context })).rejects.toMatchObject(missing);

  const abort = new AbortController();
  const stream = await call(router.runs.stream, { runId }, { context, signal: abort.signal });
  try {
    expect((await stream.next()).value).toMatchObject({ type: "snapshot", run: { id: runId } });
    context.engine.events.publish(runId, { type: "queued", queued: queuedView(draft!) });
    context.engine.events.publish(runId, { type: "run", run: snapshot.run });
    expect((await stream.next()).value).toMatchObject({ type: "run" });
    context.engine.events.publish(runId, { type: "run", run: snapshot.run });
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, reader));
    await expect(get(runId)).rejects.toMatchObject(missing);
    await expect(stream.next()).rejects.toMatchObject(missing);
    await db.insert(workspaceMembers).values({ workspaceId: engineeringId, userId: reader, role: "member" });
    await db.delete(organizationMembers).where(eq(organizationMembers.userId, reader));
    await expect(get(runId)).rejects.toMatchObject(missing);
  } finally {
    abort.abort();
    await stream.return?.(undefined);
  }
});

test("losing workspace access revokes manual starts on the author's existing sources", async () => {
  const context = await ownerContext();
  const { db, ownerId } = context;
  const workflow = await call(router.workflows.create, { name: "Build" }, { context });
  const { runnerId } = await runnerWithClis(context, "Machine");
  const harness = await call(router.harnesses.create, { name: "CLI", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Builder", harnessId: harness.id, systemPrompt: "Build." }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Start", instructions: "Build.", config: { kind: "manual", placement: "button" } }, { context });
  await db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, ownerId));
  await expect(call(router.auth.me, undefined, { context })).resolves.toEqual({ ownerId });
  // Behind the workspace gates, a person with no role there finds no workspace at all.
  const gone = { code: "NOT_FOUND" };
  await expect(call(router.jobs.start, { triggerId: trigger.id }, { context })).rejects.toMatchObject(gone);
  await expect(call(router.runs.start, { workflowId: workflow.id }, { context })).rejects.toMatchObject(gone);
  await expect(call(router.triggers.create, { agentId: agent.id, name: "Timer", instructions: "Start.", config: { kind: "schedule", cron: "* * * * *", timezone: "UTC" } }, { context })).rejects.toMatchObject(gone);
  await expect(call(router.triggers.update, { id: trigger.id, enabled: false }, { context })).rejects.toMatchObject(gone);
  await expect(call(router.triggers.delete, { id: trigger.id }, { context })).rejects.toMatchObject(gone);
  await expect(call(router.agents.update, { id: agent.id, name: "Changed", harnessId: harness.id, systemPrompt: "" }, { context })).rejects.toMatchObject(gone);
  await expect(call(router.agents.delete, { id: agent.id }, { context })).rejects.toMatchObject(gone);
  await expect(call(router.plugins.uninstall, { id: "plugin", reviewed: "a".repeat(64), choices: {} }, { context })).rejects.toMatchObject(gone);
  expect(await db.select({ id: runs.id }).from(runs)).toEqual([]);
});
