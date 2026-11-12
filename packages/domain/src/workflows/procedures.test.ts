import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { account, agents, harnesses, schedules, tools, user, workflowVersions } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { addStep, type AgentStep, type WorkflowDef } from "./model.ts";
import { STREAM_BUFFER } from "./procedures.ts";
import type { RunEvent } from "../engine/engine.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(
    await call(
      router.harnesses.create,
      { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" },
      { context },
    ),
  );
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context });
  return { context, harness, agent };
}

function withStep(def: WorkflowDef, agentId: string): WorkflowDef {
  const next = addStep(def, { after: def.trigger.field.id }, "n_step", "agent");
  (next.steps[0] as AgentStep).agentId = agentId;
  (next.steps[0] as AgentStep).prompt = "Write.";
  return next;
}

test("workflow create, get, list, update (new version only on change), delete", async () => {
  const { context, agent } = await setup();
  const created = await call(router.workflows.create, { name: "Ship" }, { context });
  expect(created).toMatchObject({ id: expect.stringMatching(/^wf_/), name: "Ship", version: 1 });
  expect(created.def.trigger.field).toMatchObject({ type: "button", key: "start", label: "Start" });
  expect(await call(router.workflows.list, undefined, { context })).toEqual([
    { id: created.id, name: "Ship", version: 1, updatedAt: expect.any(Date) },
  ]);

  const def = withStep(created.def, agent.id);
  const saved = await call(router.workflows.update, { id: created.id, name: "Ship it", def }, { context });
  expect(saved).toMatchObject({ name: "Ship it", version: 2, def });
  const renamed = await call(router.workflows.update, { id: created.id, name: "Ship now", def }, { context });
  expect(renamed.version).toBe(2);
  expect(await call(router.workflows.get, { id: created.id }, { context })).toMatchObject({ name: "Ship now", version: 2, def });
  expect(await context.db.select().from(workflowVersions)).toHaveLength(2);

  // The agent is in use now.
  await expect(call(router.agents.delete, { id: agent.id }, { context })).rejects.toMatchObject({ code: "CONFLICT" });

  await call(router.workflows.delete, { id: created.id }, { context });
  expect(await call(router.workflows.list, undefined, { context })).toEqual([]);
  await call(router.agents.delete, { id: agent.id }, { context });
});

test("an agent used by a run still going cannot be deleted, even once the workflow dropped it", async () => {
  const { context, agent } = await setup();
  const wf = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: withStep(wf.def, agent.id) }, { context });
  const { runId } = await call(router.runs.start, { workflowId: wf.id }, { context });
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: wf.def }, { context });
  await expect(call(router.agents.delete, { id: agent.id }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(call(router.workflows.delete, { id: wf.id }, { context })).rejects.toMatchObject({ code: "CONFLICT" });

  const got = await call(router.runs.get, { runId }, { context });
  expect(got.run).toMatchObject({ id: runId, status: "running", version: 2 });
  expect(got.steps.map((s) => [s.nodeId, s.status]).sort()).toEqual([
    ["n_step", "running"],
    [wf.def.trigger.field.id, "succeeded"],
  ]);
  expect(await call(router.runs.list, { workflowId: wf.id }, { context })).toEqual([{ ...got.run, queued: false, title: null, waitingOn: null, consultedBy: null }]);
  await expect(call(router.runs.sendChat, { runId, text: "hi" }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
});

test("cannot reference another owner's agent, workflow or run", async () => {
  const { context, harness } = await setup();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(harnesses).values({ ...harness, id: "harness_other", ownerId: "user_other", model: null });
  await context.db.insert(agents).values({ id: "agent_other", ownerId: "user_other", name: "Eve's", harnessId: "harness_other", systemPrompt: "" });
  const wf = await call(router.workflows.create, { name: "Ship" }, { context });
  await expect(
    call(router.workflows.update, { id: wf.id, name: "Ship", def: withStep(wf.def, "agent_other") }, { context }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  // Eve signs in on the same app.
  const ctx = await context.auth.$context;
  await context.db.insert(account).values({
    id: "acct_other",
    accountId: "user_other",
    providerId: "credential",
    userId: "user_other",
    password: await ctx.password.hash("eve's password"),
  });
  const res = await context.auth.api.signInEmail({ body: { email: "eve@example.com", password: "eve's password" }, returnHeaders: true });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const other = { ...context, headers: new Headers({ cookie }) };
  await expect(call(router.workflows.get, { id: wf.id }, { context: other })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.runs.start, { workflowId: wf.id }, { context: other })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const { runId } = await call(router.runs.start, { workflowId: wf.id }, { context });
  for (const procedure of [
    () => call(router.runs.get, { runId }, { context: other }),
    () => call(router.runs.sendChat, { runId, text: "x" }, { context: other }),
    () => call(router.runs.list, { workflowId: wf.id }, { context: other }),
    () => call(router.workflows.delete, { id: wf.id }, { context: other }),
  ]) {
    await expect(procedure()).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  // Every run of the owner's workflows, and none of them for Eve.
  expect((await call(router.runs.list, {}, { context })).map((r) => r.id)).toEqual([runId]);
  expect(await call(router.runs.list, {}, { context: other })).toEqual([]);
});

test("an invalid definition is refused", async () => {
  const { context } = await setup();
  const wf = await call(router.workflows.create, { name: "Ship" }, { context });
  const bad = { ...wf.def, trigger: { type: "manual" as const, field: { id: wf.def.trigger.field.id, key: "Not A Key", type: "button" as const, label: "Start" } } };
  await expect(call(router.workflows.update, { id: wf.id, name: "Ship", def: bad }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  const dangling = { ...wf.def, edges: [{ from: wf.def.trigger.field.id, to: "node_missing" }] };
  await expect(call(router.workflows.update, { id: wf.id, name: "Ship", def: dangling }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("workflow and run procedures require the owner's session", async () => {
  const context = { ...(await ownerContext()), headers: new Headers() };
  for (const procedure of [
    () => call(router.workflows.list, undefined, { context }),
    () => call(router.workflows.get, { id: "x" }, { context }),
    () => call(router.workflows.create, { name: "A" }, { context }),
    () => call(router.workflows.delete, { id: "x" }, { context }),
    () => call(router.runs.start, { workflowId: "x" }, { context }),
    () => call(router.runs.get, { runId: "x" }, { context }),
    () => call(router.runs.list, { workflowId: "x" }, { context }),
    () => call(router.runs.list, {}, { context }),
    () => call(router.runs.sendChat, { runId: "x", text: "a" }, { context }),
  ]) {
    await expect(procedure()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
});

test("get with a version returns what a run started on, after the workflow changed", async () => {
  const { context, agent } = await setup();
  const wf = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: withStep(wf.def, agent.id) }, { context });
  const { runId } = await call(router.runs.start, { workflowId: wf.id }, { context });
  const { run } = await call(router.runs.get, { runId }, { context });
  const renamed = withStep(wf.def, agent.id);
  renamed.steps[0]!.name = "Publish";
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: renamed }, { context });

  const then = await call(router.workflows.get, { id: wf.id, version: run.version }, { context });
  expect(then.version).toBe(2);
  expect(then.def.steps[0]!.name).toBe("Step 1");
  expect((await call(router.workflows.get, { id: wf.id }, { context })).def.steps[0]!.name).toBe("Publish");
  await expect(call(router.workflows.get, { id: wf.id, version: 9 }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("text a runner couldn't take is refused when saved", async () => {
  const { context, agent, harness } = await setup();
  const wf = await call(router.workflows.create, { name: "Ship" }, { context });
  const long = withStep(wf.def, agent.id);
  (long.steps[0] as AgentStep).prompt = "x".repeat(100_001);
  await expect(call(router.workflows.update, { id: wf.id, name: "Ship", def: long }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const nul = withStep(wf.def, agent.id);
  (nul.steps[0] as AgentStep).prompt = "a\u0000b";
  await expect(call(router.workflows.update, { id: wf.id, name: "Ship", def: nul }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    call(router.agents.create, { name: "A", harnessId: harness.id, systemPrompt: "\uD800" }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    call(router.agents.create, { name: "A", harnessId: harness.id, systemPrompt: "x".repeat(100_001) }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("revoking a runner fails the runs waiting on it", async () => {
  const { context, agent, harness } = await setup();
  const wf = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: withStep(wf.def, agent.id) }, { context });
  const { runId } = await call(router.runs.start, { workflowId: wf.id }, { context });
  // A runner a harness uses can't be revoked: move the harness off it first. The open step stays on it.
  const other = await call(router.runners.create, { name: "Other" }, { context });
  await call(
    router.harnesses.update,
    { ...harness, runnerId: other.runnerId },
    { context },
  );
  await call(router.runners.revoke, { runnerId: harness.runnerId }, { context });
  expect((await call(router.runs.get, { runId }, { context })).run).toMatchObject({ status: "failed", error: "The agent's runner was revoked" });
  // Nothing holds the workflow any more.
  await call(router.workflows.delete, { id: wf.id }, { context });
});

test("a run stream that falls too far behind gets a fresh snapshot, not a stream with holes", async () => {
  const { context, agent } = await setup();
  const wf = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: withStep(wf.def, agent.id) }, { context });
  const { runId } = await call(router.runs.start, { workflowId: wf.id }, { context });
  const abort = new AbortController();
  const stream = await call(router.runs.stream, { runId }, { context, signal: abort.signal });
  const first = await stream.next();
  expect(first.value).toMatchObject({ type: "snapshot" });
  const { run } = first.value as Extract<RunEvent, { type: "run" }>;
  // The client doesn't read while more changes than the buffer come.
  for (let i = 0; i <= STREAM_BUFFER; i++) context.engine.events.publish(runId, { type: "run", run });
  const next = await stream.next();
  expect(next.value).toMatchObject({ type: "snapshot", run: { id: runId } });
  // Afterwards, changes flow one by one again.
  context.engine.events.publish(runId, { type: "run", run });
  expect((await stream.next()).value).toMatchObject({ type: "run" });
  abort.abort();
  await stream.return?.(undefined);
});

test("a run started while its workflow is deleted either blocks the delete or fails: never a run without its workflow", async () => {
  const { context, agent } = await setup();
  const wf = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: withStep(wf.def, agent.id) }, { context });
  const [started, deleted] = await Promise.allSettled([
    call(router.runs.start, { workflowId: wf.id }, { context }),
    call(router.workflows.delete, { id: wf.id }, { context }),
  ]);
  expect(started.status === "fulfilled" && deleted.status === "fulfilled").toBe(false);
  if (started.status === "fulfilled") {
    const got = await call(router.runs.get, { runId: started.value.runId }, { context });
    expect(got.run.workflowId).toBe(wf.id);
  }
});

/** The trigger of `def` as a schedule on `cron`, Paris time. */
function onSchedule(def: WorkflowDef, cron: string): WorkflowDef {
  const { id } = def.trigger.field;
  return { ...def, trigger: { type: "schedule", field: { id, key: "start", type: "schedule", label: "Start", cron, timezone: "Europe/Paris" } } };
}

test("update with a schedule trigger creates the schedule, back to manual deletes it", async () => {
  const { context, agent } = await setup();
  let now = new Date("2026-11-05T10:05:00+01:00");
  const ctx = { ...context, now: () => now };
  const wf = await call(router.workflows.create, { name: "Ship" }, { context: ctx });
  const manual = withStep(wf.def, agent.id);
  const daily = onSchedule(manual, "0 9 * * *");
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: daily }, { context: ctx });
  const scheduleOf = async () => (await context.db.select().from(schedules).where(eq(schedules.workflowId, wf.id)))[0];
  expect(await scheduleOf()).toMatchObject({ cron: "0 9 * * *", enabled: true, nextFireAt: new Date("2026-11-06T09:00:00+01:00"), lastCheckedAt: now });
  expect(await call(router.workflows.get, { id: wf.id }, { context: ctx })).toMatchObject({
    schedule: { enabled: true, nextFireAt: new Date("2026-11-06T09:00:00+01:00") },
    fires: [],
  });

  // A save that keeps the cron and timezone leaves the schedule as it was.
  now = new Date("2026-11-05T12:00:00+01:00");
  await call(router.workflows.update, { id: wf.id, name: "Shipped", def: daily }, { context: ctx });
  expect((await scheduleOf())!.lastCheckedAt).toEqual(new Date("2026-11-05T10:05:00+01:00"));
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: onSchedule(manual, "30 9 * * *") }, { context: ctx });
  expect(await scheduleOf()).toMatchObject({ cron: "30 9 * * *", nextFireAt: new Date("2026-11-06T09:30:00+01:00"), lastCheckedAt: now });

  // A cron that can't fire is refused, the schedule untouched.
  await expect(call(router.workflows.update, { id: wf.id, name: "Ship", def: onSchedule(manual, "0 0 9 * * *") }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Use 5 fields: minute hour day month weekday",
  });
  expect((await scheduleOf())!.cron).toBe("30 9 * * *");

  await call(router.workflows.update, { id: wf.id, name: "Ship", def: manual }, { context: ctx });
  expect(await scheduleOf()).toBeUndefined();
  expect(await call(router.workflows.get, { id: wf.id }, { context: ctx })).toMatchObject({ schedule: null });
  await expect(call(router.workflows.setScheduleEnabled, { id: wf.id, enabled: false }, { context: ctx })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("another owner's workflow can't be paused", async () => {
  const { context, agent } = await setup();
  const wf = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: wf.id, name: "Ship", def: onSchedule(withStep(wf.def, agent.id), "0 9 * * *") }, { context });
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  const auth = await context.auth.$context;
  await context.db.insert(account).values({
    id: "acct_other",
    accountId: "user_other",
    providerId: "credential",
    userId: "user_other",
    password: await auth.password.hash("eve's password"),
  });
  const res = await context.auth.api.signInEmail({ body: { email: "eve@example.com", password: "eve's password" }, returnHeaders: true });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const other = { ...context, headers: new Headers({ cookie }) };
  await expect(call(router.workflows.setScheduleEnabled, { id: wf.id, enabled: false }, { context: other })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await context.db.select().from(schedules).where(eq(schedules.workflowId, wf.id)))[0]!.enabled).toBe(true);
});

test("a Tool step's tool must be the owner's, a tool in use can't go, and start reports its issues", async () => {
  const { context } = await setup();
  const [tool] = await context.db
    .insert(tools)
    .values({
      id: "tool_gh",
      ownerId: context.ownerId,
      name: "GitHub",
      kind: "http",
      url: "https://mcp.example.com/",
      transport: "streamable-http",
      actions: [{ name: "create_repository", description: "", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
    })
    .returning();
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
  const base = addStep(workflow.def, { after: workflow.def.trigger.field.id }, "n_tool", "tool");
  const def = (toolId: string): WorkflowDef => ({ ...base, steps: base.steps.map((s) => (s.type === "tool" ? { ...s, toolId, action: "create_repository" } : s)) });
  await expect(call(router.workflows.update, { id: workflow.id, name: "Ship", def: def("tool_other") }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: def(tool!.id) }, { context });
  await expect(call(router.runs.start, { workflowId: workflow.id }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Fix the workflow first: “name” needs a value",
  });
  await expect(call(router.tools.delete, { id: tool!.id }, { context })).rejects.toMatchObject({ code: "CONFLICT", message: "The workflow “Ship” uses this tool" });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: workflow.def }, { context });
  await call(router.tools.delete, { id: tool!.id }, { context });
});

test("a tool a run still going uses can't go, even once the workflow dropped it", async () => {
  const { context, agent } = await setup();
  await context.db.insert(tools).values({
    id: "tool_gh",
    ownerId: context.ownerId,
    name: "GitHub",
    kind: "http",
    url: "https://mcp.example.com/",
    transport: "streamable-http",
    actions: [{ name: "create_repository", description: "", inputSchema: { type: "object" } }],
  });
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
  // An agent step first, so the run is still going when the tool step's version is replaced.
  const withAgent = withStep(workflow.def, agent.id);
  const def = addStep(withAgent, { after: "n_step" }, "n_tool", "tool");
  const tool = def.steps.find((s) => s.type === "tool")!;
  Object.assign(tool, { toolId: "tool_gh", action: "create_repository" });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def }, { context });
  await call(router.runs.start, { workflowId: workflow.id }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: withAgent }, { context });
  await expect(call(router.tools.delete, { id: "tool_gh" }, { context })).rejects.toMatchObject({
    code: "CONFLICT",
    message: "A run of the workflow “Ship” still uses this tool",
  });
});
