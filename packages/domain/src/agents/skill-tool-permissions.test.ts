import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { agentSkillToolPermissions, plugins, questions, runs, stepRuns, tools } from "../db/schema.ts";
import { runnerServerName, sessionTooling, toolingOf } from "../engine/tooling.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, ownerContext } from "../runners/test-support.ts";
import { startFakeMcp, type FakeMcp } from "../tools/test-server.ts";
import { offerForQuestion, remember, type Subject } from "./remember.ts";
import { rememberAllowedAction, toolPermissionTarget } from "./tool-ask.ts";

const ACTION = "draft";

/** An agent that gets two same-named runner tools, a local one and a plugin's, only with its skill package. */
async function setup() {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = await call(router.harnesses.create, { name: "CLI", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  await context.db.insert(plugins).values({ id: "plugin_1", ownerId: context.ownerId, workspaceId: context.workspaceId, name: "Forge", description: "Mail", components: { skills: [], mcpServers: [], agents: [] } });
  const actions = [{ name: ACTION, description: "", inputSchema: {} }];
  await context.db.insert(tools).values([
    { id: "tool_mail", ownerId: context.ownerId, workspaceId: context.workspaceId, name: "Mail", kind: "runner", runnerId, runnerTool: "mail", actions },
    { id: "tool_mail_plugin", ownerId: context.ownerId, workspaceId: context.workspaceId, name: "Mail", kind: "runner", runnerId, runnerTool: "mail", actions, pluginId: "plugin_1" },
  ]);
  const { packageId } = await call(router.skills.create, { name: "triage", description: "Triages mail.", instructions: "x", requiredToolIds: ["tool_mail", "tool_mail_plugin"] }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", skillPackageIds: [packageId] }, { context });
  const other = await call(router.agents.create, { name: "Other", harnessId: harness.id, systemPrompt: "", skillPackageIds: [packageId] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work", config: { kind: "manual", placement: "button" } }, { context });
  const otherTrigger = await call(router.triggers.create, { agentId: other.id, name: "Go", instructions: "Work", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  const [tool] = await context.db.select().from(tools).where(eq(tools.id, "tool_mail"));
  const subject: Subject = { kind: "tool", agentId: agent.id, toolId: "tool_mail", action: ACTION, target: toolPermissionTarget(tool!) };
  await context.db.insert(questions).values({ id: "q_tool", ownerId: context.ownerId, addresseeId: context.ownerId, runId, stepRunId: step!.id, sessionId: step!.sessionId, placement: "notifications", kind: "approval", payload: { kind: "permission", toolName: "mcp__mail__draft", input: {}, canAlwaysAllow: true }, status: "pending", remember: { scopes: ["run", "always"], subject } });
  /** What the next Job of `triggerId` gets for the tool: whether the action runs unasked, asks, or is refused. */
  const nextJob = async (toolId = "tool_mail", triggerId = trigger.id) => {
    const { runId: next } = await call(router.jobs.start, { triggerId }, { context });
    // What its session gets (`sessionTooling`), read from the Job itself: a session may still wait for a runner slot.
    const [run] = await context.db.select().from(runs).where(eq(runs.id, next));
    // A tool whose every action is Off is left out of the Job altogether.
    const t = (await toolingOf(context.db, run!, run!.agentId!)).runnerTools.find((r) => r.id === toolId);
    return !t?.actions.some((a) => a.name === ACTION) ? "refused" : t.unasked.includes(ACTION) ? "unasked" : "asks";
  };
  const always = (decision: "allow" | "deny") => remember(context.db, { questionId: "q_tool", decision, scope: "always", by: { type: "user", userId: context.ownerId } });
  return { context, runnerId, harness, packageId, agent, other, otherTrigger, step: step!, subject, nextJob, always };
}

test("a skill's tool is offered Always, and an Allow or a Deny remembered for always holds in the next Job", async () => {
  const s = await setup();
  const name = `mcp__${runnerServerName({ id: "tool_mail", runnerId: s.runnerId, tool: "mail" })}__${ACTION}`;
  const offer = await offerForQuestion(s.context.db, { sessionId: s.step.sessionId!, questionId: "q_x", payload: { kind: "permission", toolName: name, input: {}, canAlwaysAllow: false }, harness: "codex" });
  expect(offer).toMatchObject({ remember: { scopes: ["run", "always"], subject: s.subject } });
  expect(await s.nextJob()).toBe("asks");
  expect(await s.always("allow")).toBe(true);
  expect(await s.nextJob()).toBe("unasked");
  expect(await s.always("deny")).toBe(true);
  expect(await s.nextJob()).toBe("refused");
  // A later Allow doesn't take back the Deny: only a person's change on the agent does.
  expect(await s.always("allow")).toBe(false);
  expect(await s.nextJob()).toBe("refused");
});

test("a remembered choice holds only for its agent and its tool, never a same-named tool from a plugin", async () => {
  const s = await setup();
  expect(await s.always("allow")).toBe(true);
  expect(await s.nextJob("tool_mail")).toBe("unasked");
  expect(await s.nextJob("tool_mail_plugin")).toBe("asks");
  expect(await s.nextJob("tool_mail", s.otherTrigger.id)).toBe("asks");
});

test("a save that keeps the package keeps the choice; dropping the package, or the tool from the package, drops it", async () => {
  const s = await setup();
  const rows = async () => (await s.context.db.select().from(agentSkillToolPermissions).where(eq(agentSkillToolPermissions.agentId, s.agent.id))).length;
  const base = { id: s.agent.id, name: "Clerk", harnessId: s.harness.id, systemPrompt: "Edited" };
  expect(await s.always("allow")).toBe(true);
  await call(router.agents.update, { ...base, skillPackageIds: [s.packageId] }, { context: s.context });
  expect(await s.nextJob()).toBe("unasked");
  await call(router.agents.update, { ...base, skillPackageIds: [] }, { context: s.context });
  expect(await rows()).toBe(0);
  await call(router.agents.update, { ...base, skillPackageIds: [s.packageId] }, { context: s.context });
  expect(await s.nextJob()).toBe("asks");

  expect(await rememberAllowedAction(s.context.db, s.context.workspaceId, { agentId: s.agent.id, toolId: "tool_mail", action: ACTION })).toBe(true);
  expect(await rememberAllowedAction(s.context.db, s.context.workspaceId, { agentId: s.agent.id, toolId: "tool_mail_plugin", action: ACTION })).toBe(true);
  await call(router.skills.update, { packageId: s.packageId, name: "triage", description: "Triages mail.", instructions: "x", requiredToolIds: ["tool_mail_plugin"] }, { context: s.context });
  expect((await s.context.db.select().from(agentSkillToolPermissions).where(eq(agentSkillToolPermissions.agentId, s.agent.id))).map((r) => r.toolId)).toEqual(["tool_mail_plugin"]);
  await call(router.skills.update, { packageId: s.packageId, name: "triage", description: "Triages mail.", instructions: "x", requiredToolIds: ["tool_mail", "tool_mail_plugin"] }, { context: s.context });
  expect(await s.nextJob()).toBe("asks");
  expect(await s.nextJob("tool_mail_plugin")).toBe("unasked");

  // Chosen for the agent too, its own permissions take over; dropped again, nothing earlier comes back.
  expect(await rememberAllowedAction(s.context.db, s.context.workspaceId, { agentId: s.agent.id, toolId: "tool_mail", action: ACTION })).toBe(true);
  await call(router.agents.update, { ...base, skillPackageIds: [s.packageId], toolIds: ["tool_mail"] }, { context: s.context });
  await call(router.agents.setToolPermission, { agentId: s.agent.id, toolId: "tool_mail", action: ACTION, permission: "off" }, { context: s.context });
  expect(await s.nextJob()).toBe("refused");
  await call(router.agents.update, { ...base, skillPackageIds: [s.packageId], toolIds: [] }, { context: s.context });
  expect(await s.nextJob()).toBe("asks");

  // A remembered Off survives choosing the tool, even for an action its server calls read-only.
  await s.context.db.update(tools).set({ actions: [{ name: ACTION, description: "", inputSchema: {}, readOnly: true }] }).where(eq(tools.id, "tool_mail"));
  await call(router.agents.setToolPermission, { agentId: s.agent.id, toolId: "tool_mail", action: ACTION, permission: "off" }, { context: s.context });
  expect(await s.nextJob()).toBe("refused");
  // A proposal's frozen defaults name the action as Run: the carried-over Off still wins.
  await call(router.agents.update, { ...base, skillPackageIds: [s.packageId], toolIds: ["tool_mail"], toolPermissions: [{ toolId: "tool_mail", unasked: [ACTION] }] }, { context: s.context });
  expect(await s.nextJob()).toBe("refused");
});

const servers: FakeMcp[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((m) => m.close()));
});

test("a skill's tool pointed at another server by an edit asks again", async () => {
  const context = await ownerContext();
  const first = await startFakeMcp([{ name: "echo", description: "", inputSchema: { type: "object" }, call: () => ({ content: [] }) }]);
  const second = await startFakeMcp([{ name: "echo", description: "", inputSchema: { type: "object" }, call: () => ({ content: [] }) }]);
  servers.push(first, second);
  const tool = await call(router.tools.create, { name: "Echo", url: first.url, transport: "streamable-http", headers: {} }, { context });
  const { packageId } = await call(router.skills.create, { name: "echo", description: "Echoes.", instructions: "x", requiredToolIds: [tool.id] }, { context });
  const harness = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", skillPackageIds: [packageId] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work", config: { kind: "manual", placement: "button" } }, { context });
  const nextJob = async () => {
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    const [s] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    return (await sessionTooling(context.db, s!.sessionId!)).httpTools[0]!.unasked;
  };
  expect(await rememberAllowedAction(context.db, context.workspaceId, { agentId: agent.id, toolId: tool.id, action: "echo" })).toBe(true);
  expect(await nextJob()).toEqual(["echo"]);
  await call(router.tools.update, { id: tool.id, url: second.url }, { context });
  expect(await nextJob()).toEqual([]);
});

test("the agent page shows a skill's tool as remembered, and a remembered Deny is undone there", async () => {
  const s = await setup();
  const shown = async () => (await call(router.agents.toolAsk, { id: s.agent.id }, { context: s.context })).find((t) => t.toolId === "tool_mail")!.actions.find((a) => a.name === ACTION)!.permission;
  expect(await shown()).toBe("ask");
  expect(await s.always("deny")).toBe(true);
  expect(await shown()).toBe("off");
  await call(router.agents.setToolPermission, { agentId: s.agent.id, toolId: "tool_mail", action: ACTION, permission: "ask" }, { context: s.context });
  expect(await shown()).toBe("ask");
  expect(await s.nextJob()).toBe("asks");
});
