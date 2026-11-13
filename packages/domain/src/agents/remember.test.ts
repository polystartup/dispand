import { runnerServerName } from "../engine/tooling.ts";
import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { agentTools, questions, runs, stepRuns, tools } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { toolPermissionTarget } from "./tool-ask.ts";
import { offerForQuestion, remember, toolAnswerPermission, rememberedDecision, type Subject } from "./remember.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(router.harnesses.create, { name: "CLI", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const action = "sentinel_private_action";
  await context.db.insert(tools).values({ id: "tool_mail", ownerId: context.ownerId, name: "Mail", kind: "runner", runnerId, runnerTool: "mail", actions: [{ name: action, description: "", inputSchema: {} }] });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", toolIds: ["tool_mail"] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  const [tool] = await context.db.select().from(tools).where(eq(tools.id, "tool_mail"));
  const subject: Subject = { kind: "tool", agentId: agent.id, toolId: tool!.id, action, target: toolPermissionTarget(tool!) };
  const by = { type: "user" as const, userId: context.ownerId };
  await context.db.insert(questions).values({ id: "q_tool", ownerId: context.ownerId, runId, stepRunId: step!.id, sessionId: step!.sessionId, placement: "notifications", kind: "approval", payload: { kind: "permission", toolName: "mcp__mail__draft", input: {}, canAlwaysAllow: true }, status: "pending", remember: { scopes: ["run", "always"], subject } });
  const state = async () => (await context.db.select().from(runs).where(eq(runs.id, runId)))[0]!.remembered;
  const saved = async () => (await context.db.select().from(agentTools).where(and(eq(agentTools.agentId, agent.id), eq(agentTools.toolId, tool!.id))))[0]!;
  return { context, agent, trigger, runId, subject, by, state, saved, step: step! };
}

test("run memory is isolated, survives a reload, and keeps allow and deny disjoint", async () => {
  const s = await setup();
  const input = { questionId: "q_tool", decision: "allow" as const, scope: "run" as const, by: s.by };
  expect(await remember(s.context.db, input)).toBe(true);
  expect(await remember(s.context.db, input)).toBe(true);
  expect(await s.state()).toEqual({ allow: [s.subject], deny: [] });
  expect(rememberedDecision(await s.state(), s.subject)).toBe("allow");
  expect(await s.saved()).toMatchObject({ unasked: [], denied: [] });
  const another = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  expect((await s.context.db.select().from(runs).where(eq(runs.id, another.runId)))[0]!.remembered).toEqual({ allow: [], deny: [] });
  expect(await remember(s.context.db, { ...input, decision: "deny" })).toBe(true);
  expect(await s.state()).toEqual({ allow: [], deny: [s.subject] });
  expect(rememberedDecision(await s.state(), s.subject)).toBe("deny");
  expect(rememberedDecision(await s.state(), { ...s.subject, target: "another-target" })).toBeNull();
  expect(rememberedDecision(await s.state(), { ...s.subject, agentId: "another-agent" })).toBeNull();
});

test.each(["allow", "deny"] as const)("future-run %s changes the agent's action permission only", async (decision) => {
  const s = await setup();
  expect(await remember(s.context.db, { questionId: "q_tool", decision, scope: "always", by: s.by })).toBe(true);
  expect(await s.saved()).toMatchObject({ unasked: decision === "allow" ? [s.subject.action] : [], denied: decision === "deny" ? [s.subject.action] : [] });
  expect(await s.state()).toEqual({ allow: [], deny: [] });
});

test("only the owner may remember a scope explicitly offered by the server", async () => {
  const s = await setup();
  const input = { questionId: "q_tool", decision: "allow" as const, scope: "run" as const, by: s.by };
  expect(await remember(s.context.db, { ...input, by: { type: "agent", agentId: s.agent.id, runId: s.runId, name: "Clerk" } })).toBe(false);
  expect(await remember(s.context.db, { ...input, by: { type: "user", userId: "another-owner" } })).toBe(false);
  await s.context.db.update(questions).set({ remember: { scopes: ["run"], subject: s.subject } }).where(eq(questions.id, "q_tool"));
  expect(await remember(s.context.db, { ...input, scope: "always" })).toBe(false);
  await s.context.db.update(questions).set({ remember: null }).where(eq(questions.id, "q_tool"));
  expect(await remember(s.context.db, input)).toBe(false);
  expect(await s.state()).toEqual({ allow: [], deny: [] });
  expect(await s.saved()).toMatchObject({ unasked: [], denied: [] });
});

test.each(["request_approval", "checkpoint", "consult"])("%s cannot carry a remembered tool permission", async (toolName) => {
  const s = await setup();
  await s.context.db.update(questions).set({ payload: { kind: "permission", toolName, input: {}, canAlwaysAllow: true } }).where(eq(questions.id, "q_tool"));
  expect(await remember(s.context.db, { questionId: "q_tool", decision: "allow", scope: "run", by: s.by })).toBe(false);
  expect(await s.state()).toEqual({ allow: [], deny: [] });
});

test("a changed target or revoked action cannot be revived by a pending remembered allow", async () => {
  const s = await setup();
  const input = { questionId: "q_tool", decision: "allow" as const, scope: "run" as const, by: s.by };
  await s.context.db.update(tools).set({ permissionRevision: 1 }).where(eq(tools.id, s.subject.toolId));
  expect(await remember(s.context.db, input)).toBe(false);
  await s.context.db.update(tools).set({ permissionRevision: 0 }).where(eq(tools.id, s.subject.toolId));
  await call(router.agents.setToolPermission, { agentId: s.agent.id, toolId: s.subject.toolId, action: s.subject.action, permission: "off" }, { context: s.context });
  expect(await remember(s.context.db, input)).toBe(false);
  expect(await remember(s.context.db, { ...input, scope: "always" })).toBe(false);
  expect(await s.saved()).toMatchObject({ unasked: [], denied: [s.subject.action] });
});

test("finished runs and answered questions cannot acquire remembered permissions", async () => {
  const s = await setup();
  const input = { questionId: "q_tool", decision: "allow" as const, scope: "run" as const, by: s.by };
  await s.context.db.update(questions).set({ status: "answered" }).where(eq(questions.id, "q_tool"));
  expect(await remember(s.context.db, input)).toBe(false);
  await s.context.db.update(questions).set({ status: "pending" }).where(eq(questions.id, "q_tool"));
  await s.context.db.update(runs).set({ status: "succeeded" }).where(eq(runs.id, s.runId));
  expect(await remember(s.context.db, input)).toBe(false);
});

test("memory telemetry records only bounded decisions and outcomes", async () => {
  const s = await setup();
  const telemetry = await captureTelemetry();
  onTestFinished(() => telemetry.stop());
  await remember(s.context.db, { questionId: "q_tool", decision: "allow", scope: "run", by: s.by });
  expect(telemetry.spans().some((span) => span.name === "permission.remember")).toBe(true);
  expect(await telemetry.metrics()).toContainEqual({ name: "dispand.permissions.remembered", attributes: { "dispand.permission.scope": "run", "dispand.answer.decision": "allow", "dispand.result": "ok" } });
  expect(await telemetry.all()).not.toContain(s.subject.action);
});


test("workflow sessions may remember for their run but cannot change an agent's future permission", async () => {
  const s = await setup();
  await s.context.db.update(runs).set({ source: "workflow", agentId: null, snapshot: null, def: { trigger: { type: "manual", field: { id: "go", key: "go", type: "button", label: "Go" } }, steps: [{ id: s.step.nodeId, key: "work", type: "agent", name: "Work", agentId: s.agent.id, prompt: "Work" }], edges: [] } }).where(eq(runs.id, s.runId));
  const input = { questionId: "q_tool", decision: "allow" as const, by: s.by };
  expect(await remember(s.context.db, { ...input, scope: "always" })).toBe(false);
  expect(await remember(s.context.db, { ...input, scope: "run" })).toBe(true);
  expect(await s.saved()).toMatchObject({ unasked: [], denied: [] });
});

test.each(["run", "always"] as const)("%s memory rolls back with the enclosing answer transaction", async (scope) => {
  const s = await setup();
  await expect(s.context.db.transaction(async (tx) => {
    expect(await remember(tx, { questionId: "q_tool", decision: "allow", scope, by: s.by })).toBe(true);
    await tx.update(questions).set({ status: "answered" }).where(eq(questions.id, "q_tool"));
    throw new Error("answer rollback");
  })).rejects.toThrow("answer rollback");
  expect(await s.state()).toEqual({ allow: [], deny: [] });
  expect(await s.saved()).toMatchObject({ unasked: [], denied: [] });
  expect((await s.context.db.select().from(questions).where(eq(questions.id, "q_tool")))[0]!.status).toBe("pending");
});


test("an offer for another agent cannot write run memory", async () => {
  const s = await setup();
  await s.context.db.update(questions).set({ remember: { scopes: ["run"], subject: { ...s.subject, agentId: "another-agent" } } }).where(eq(questions.id, "q_tool"));
  expect(await remember(s.context.db, { questionId: "q_tool", decision: "allow", scope: "run", by: s.by })).toBe(false);
  expect(await s.state()).toEqual({ allow: [], deny: [] });
});


test("offers resolve runner identity and workflow sessions never offer future-run permission", async () => {
  const s = await setup();
  const [tool] = await s.context.db.select().from(tools).where(eq(tools.id, s.subject.toolId));
  const name = `mcp__${runnerServerName({ id: tool!.id, runnerId: tool!.runnerId!, tool: tool!.runnerTool! })}__${s.subject.action}`;
  const input = { ownerId: s.context.ownerId, sessionId: s.step.sessionId!, questionId: "rq_native", payload: { kind: "permission" as const, toolName: name, input: {}, canAlwaysAllow: false }, harness: "codex" };
  expect(await offerForQuestion(s.context.db, input)).toMatchObject({ remember: { scopes: ["run", "always"], subject: s.subject } });
  await s.context.db.update(runs).set({ source: "workflow", agentId: null, snapshot: null, def: { trigger: { type: "manual", field: { id: "go", key: "go", type: "button", label: "Go" } }, steps: [{ id: s.step.nodeId, key: "work", type: "agent", name: "Work", agentId: s.agent.id, prompt: "Work" }], edges: [] } }).where(eq(runs.id, s.runId));
  expect(await offerForQuestion(s.context.db, input)).toMatchObject({ remember: { scopes: ["run"], subject: s.subject } });
  expect(await offerForQuestion(s.context.db, { ...input, payload: { ...input.payload, toolName: "mcp__other__draft", input: { remember: "always" } } })).toBeNull();
});

test("an ambiguous Claude action alias cannot offer permission for the wrong action", async () => {
  const s = await setup();
  const [tool] = await s.context.db.select().from(tools).where(eq(tools.id, s.subject.toolId));
  await s.context.db.update(tools).set({ actions: ["send.email", "send_email"].map((name) => ({ name, description: "", inputSchema: {} })) }).where(eq(tools.id, tool!.id));
  const name = `mcp__${runnerServerName({ id: tool!.id, runnerId: tool!.runnerId!, tool: tool!.runnerTool! })}__send_email`;
  const input = { ownerId: s.context.ownerId, sessionId: s.step.sessionId!, questionId: "rq_native", payload: { kind: "permission" as const, toolName: name, input: {}, canAlwaysAllow: true }, harness: "claude-code" };
  expect(await offerForQuestion(s.context.db, input)).toBeNull();
  expect(await offerForQuestion(s.context.db, { ...input, harness: "codex" })).toMatchObject({ remember: { subject: { action: "send_email" } } });
});


test("an undelivered remembered allow is checked again before native caching", async () => {
  const s = await setup();
  await remember(s.context.db, { questionId: "q_tool", decision: "allow", scope: "run", by: s.by });
  await s.context.db.update(questions).set({ status: "answered", answer: { kind: "permission", decision: "allow", remember: "run" } }).where(eq(questions.id, "q_tool"));
  const [q] = await s.context.db.select().from(questions).where(eq(questions.id, "q_tool"));
  expect(await toolAnswerPermission(s.context.db, q!)).toBe("remember");
  await call(router.agents.setToolPermission, { agentId: s.agent.id, toolId: s.subject.toolId, action: s.subject.action, permission: "off" }, { context: s.context });
  expect(await toolAnswerPermission(s.context.db, q!)).toBe("deny");
  await call(router.agents.setToolPermission, { agentId: s.agent.id, toolId: s.subject.toolId, action: s.subject.action, permission: "ask" }, { context: s.context });
  await s.context.db.update(runs).set({ remembered: { allow: [], deny: [] } }).where(eq(runs.id, s.runId));
  expect(await toolAnswerPermission(s.context.db, q!)).toBe("once");
  await s.context.db.update(tools).set({ permissionRevision: 1 }).where(eq(tools.id, s.subject.toolId));
  expect(await toolAnswerPermission(s.context.db, q!)).toBe("deny");
});
