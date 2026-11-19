import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { organizationMembers, organizations, runs, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import type { WorkflowDef } from "../workflows/model.ts";

test("a signed-in person's job reads follow current workspace access, including an open stream", async () => {
  const context = await ownerContext();
  const { db, ownerId: reader } = context;
  const [engineering] = await db.select().from(workspaces);
  const { id: engineeringId, organizationId } = engineering!;
  await db.insert(user).values({ id: "author", name: "Author", email: "author@example.com" });
  await db.insert(organizationMembers).values({ organizationId, userId: "author", role: "owner" });
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

  const get = (runId: string) => call(router.runs.get, { runId }, { context });
  const missing = { code: "NOT_FOUND" };
  const jobContext = { ...context, job: { runId, ownerId: "author", agentId: "worker" } };
  await expect(call(router.jobs.get, { id: runId }, { context: jobContext })).resolves.toMatchObject({ id: runId });
  await expect(call(router.jobs.get, { id: financeJob }, { context: jobContext })).rejects.toMatchObject(missing);
  // No workspace assignment: the organization's owner inherits only that organization's workspaces.
  await expect(get(financeJob)).resolves.toMatchObject({ run: { id: financeJob } });
  await expect(get(foreignJob)).rejects.toMatchObject(missing);

  await db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, reader));
  await db.insert(workspaceMembers).values({ workspaceId: engineeringId, userId: reader, role: "member" });
  const snapshot = await get(runId);
  expect(snapshot).toMatchObject({ canManage: false, run: { id: runId } });
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
  const { runnerId } = await call(router.runners.create, { name: "Machine" }, { context });
  const harness = await call(router.harnesses.create, { name: "CLI", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Builder", harnessId: harness.id, systemPrompt: "Build." }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Start", instructions: "Build.", config: { kind: "manual", placement: "button" } }, { context });
  await db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, ownerId));
  await expect(call(router.jobs.start, { triggerId: trigger.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.runs.start, { workflowId: workflow.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await db.select({ id: runs.id }).from(runs)).toEqual([]);
});
