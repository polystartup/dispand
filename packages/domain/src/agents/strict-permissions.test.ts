import { createServer, type Server } from "node:http";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { plugins, questions, runs, stepRuns, tools } from "../db/schema.ts";
import { sessionTooling, toolingOf } from "../engine/tooling.ts";
import { snapshotToolPermissions } from "../platform/proposals.ts";
import { pollableActions } from "../tools/pollable.ts";
import { remember } from "./remember.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { startFakeMcp, type FakeAction, type FakeMcp } from "../tools/test-server.ts";
import { rememberAllowedAction, strictTargets, toolPermissionTarget } from "./tool-ask.ts";

const servers: FakeMcp[] = [];
const models: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((m) => m.close().catch(() => {})));
  for (const model of models.splice(0)) {
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
  }
});

/**
 * A model endpoint that never answers: the Jobs' cloud sessions stay running for the whole test.
 * A real provider refuses the test key, and its Job fails, at a time the test doesn't control.
 */
async function silentModel(): Promise<string> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  models.push(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/**
 * An agent that chose a plugin's tool (Echo) and gets another (Notes) only with its skill package;
 * `grant` gives each one action "always allow", `nextJob` says what the next Job runs unasked.
 */
async function setup() {
  const context = await ownerContext();
  const echoActions: FakeAction[] = [{ name: "echo", inputSchema: { type: "object" }, call: () => ({ content: [] }) }];
  const echoServer = await startFakeMcp(echoActions);
  const notesServer = await startFakeMcp([{ name: "note", inputSchema: { type: "object" }, call: () => ({ content: [] }) }]);
  servers.push(echoServer, notesServer);
  const echo = await call(router.tools.create, { name: "Echo", url: echoServer.url, transport: "streamable-http", headers: {} }, { context });
  const notes = await call(router.tools.create, { name: "Notes", url: notesServer.url, transport: "streamable-http", headers: {} }, { context });
  await context.db.insert(plugins).values({ id: "plugin_1", ownerId: context.ownerId, workspaceId: context.workspaceId, name: "Forge", description: "Echo", sha: "a".repeat(40), components: { skills: [], mcpServers: [], agents: [] } });
  await context.db.update(tools).set({ pluginId: "plugin_1" }).where(eq(tools.id, echo.id));
  const skill = { name: "notes", description: "Takes notes.", instructions: "Write it down.", requiredToolIds: [notes.id] };
  const { packageId } = await call(router.skills.create, skill, { context });
  const harness = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", baseUrl: await silentModel(), model: "claude-opus-5-5", systemPrompt: "" }, { context });
  const fields = { name: "Clerk", harnessId: harness.id, systemPrompt: "", skillPackageIds: [packageId], toolIds: [echo.id] };
  const agent = await call(router.agents.create, fields, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work", config: { kind: "manual", placement: "button" } }, { context });
  const startJob = async () => {
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    return { runId, step: step! };
  };
  /** What the Job `runId` gets now, by tool. */
  const jobGets = async (runId: string) => {
    const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
    const { httpTools } = await toolingOf(context.db, run!, agent.id);
    return { echo: httpTools.find((t) => t.id === echo.id)!.unasked, notes: httpTools.find((t) => t.id === notes.id)!.unasked };
  };
  // Stopped once read: a harness works on 5 sessions at once, and a test starts more Jobs than that.
  const nextJob = async () => {
    const { runId, step } = await startJob();
    const { httpTools } = await sessionTooling(context.db, step.sessionId!);
    await call(router.runs.stop, { runId }, { context });
    return { echo: httpTools.find((t) => t.id === echo.id)!.unasked, notes: httpTools.find((t) => t.id === notes.id)!.unasked };
  };
  const grant = async () => {
    await call(router.agents.setToolPermission, { agentId: agent.id, toolId: echo.id, action: "echo", permission: "run" }, { context });
    expect(await rememberAllowedAction(context.db, context.ownerId, { agentId: agent.id, toolId: notes.id, action: "note" })).toBe(true);
  };
  const strict = (on: boolean) => call(router.workspace.setStrictPermissions, { strict: on }, { context });
  const edits = {
    newAction: async () => {
      echoActions.push({ name: "shout", inputSchema: { type: "object" }, call: () => ({ content: [] }) });
      await call(router.tools.refresh, { id: echo.id }, { context });
    },
    // What a plugin update records: the commit its files were read at.
    pluginCommit: () => context.db.update(plugins).set({ sha: "b".repeat(40) }).where(eq(plugins.id, "plugin_1")),
    skillFile: () => call(router.skills.update, { packageId, ...skill, instructions: "Write it all down." }, { context }),
    agent: () => call(router.agents.update, { id: agent.id, ...fields, systemPrompt: "Be brief." }, { context }),
  };
  const shown = async () => (await call(router.agents.toolAsk, { id: agent.id }, { context }))[0]!.actions.find((a) => a.name === "echo")!.permission;
  return { context, agent, fields, packageId, notes, echo, echoServer, startJob, jobGets, nextJob, grant, strict, edits, shown };
}

const GRANTED = { echo: ["echo"], notes: ["note"] };

test("without strict permissions, a tool gaining an action, a new commit, a skill or agent edit keep Always; a tool moved to another address asks again", async () => {
  const s = await setup();
  expect(await call(router.workspace.strictPermissions, undefined, { context: s.context })).toEqual({ strict: false });
  await s.grant();
  expect(await s.nextJob()).toEqual(GRANTED);
  for (const edit of Object.values(s.edits)) await edit();
  expect(await s.nextJob()).toEqual(GRANTED);
  const elsewhere = await startFakeMcp([{ name: "echo", inputSchema: { type: "object" }, call: () => ({ content: [] }) }]);
  servers.push(elsewhere);
  await call(router.tools.update, { id: s.echo.id, url: elsewhere.url }, { context: s.context });
  expect(await s.nextJob()).toEqual({ echo: [], notes: ["note"] });
});

test("with strict permissions, a new action, a plugin's new commit, an edited skill file and an agent edit each make it ask again", async () => {
  const s = await setup();
  await s.strict(true);
  await s.grant();
  expect(await s.nextJob()).toEqual(GRANTED);
  expect(await s.shown()).toBe("run");

  await s.edits.newAction();
  expect(await s.nextJob()).toEqual({ echo: [], notes: ["note"] });
  expect(await s.shown()).toBe("ask");
  await s.grant();
  expect(await s.nextJob()).toEqual(GRANTED);

  await s.edits.pluginCommit();
  expect(await s.nextJob()).toEqual({ echo: [], notes: ["note"] });
  await s.grant();

  await s.edits.skillFile();
  expect(await s.nextJob()).toEqual({ echo: ["echo"], notes: [] });
  await s.grant();
  expect(await s.nextJob()).toEqual(GRANTED);

  await s.edits.agent();
  expect(await s.nextJob()).toEqual({ echo: [], notes: [] });
});

test("with strict permissions, a server that doesn't answer its listing asks", async () => {
  const s = await setup();
  await s.strict(true);
  await s.grant();
  await s.echoServer.close();
  expect((await call(router.tools.refresh, { id: s.echo.id }, { context: s.context })).actionsError).toBeTruthy();
  expect(await s.nextJob()).toEqual({ echo: [], notes: ["note"] });
});

test("turning strict permissions on makes stored choices ask; turning them off keeps them", async () => {
  const s = await setup();
  await s.grant();
  await s.strict(true);
  expect(await call(router.workspace.strictPermissions, undefined, { context: s.context })).toEqual({ strict: true });
  expect(await s.nextJob()).toEqual({ echo: [], notes: [] });
  expect(await s.shown()).toBe("ask");
  await s.strict(false);
  expect(await s.nextJob()).toEqual(GRANTED);
  expect(await s.shown()).toBe("run");
});

test("with strict permissions, a grant for an edited agent doesn't reach a Job made from its earlier configuration", async () => {
  const s = await setup();
  await s.strict(true);
  const { runId: older } = await s.startJob();
  await s.edits.agent();
  await s.grant();
  expect(await s.nextJob()).toEqual(GRANTED);
  expect(await s.jobGets(older)).toEqual({ echo: [], notes: [] });
});

test("with strict permissions, polls read only actions whose grant still holds", async () => {
  const s = await setup();
  await s.context.db.update(tools).set({ pollable: ["echo"] }).where(eq(tools.id, s.echo.id));
  await s.grant();
  const echo = async () => (await pollableActions(s.context.db, s.context.ownerId, s.echo.id))!.find((a) => a.name === "echo")!;
  expect(await echo()).toMatchObject({ pollable: true, askedBy: [] });
  await s.strict(true);
  expect(await echo()).toMatchObject({ pollable: false, askedBy: ["Clerk"] });
});

test("turning strict permissions on narrows the sessions already running", async () => {
  const s = await setup();
  const narrow = vi.spyOn(s.context.engine, "narrowOwnerSessions");
  await s.strict(false);
  expect(narrow).not.toHaveBeenCalled();
  await s.strict(true);
  expect(narrow).toHaveBeenCalledWith(s.context.ownerId, s.context.db);
  narrow.mockClear();
  await call(router.tools.refresh, { id: s.echo.id }, { context: s.context });
  expect(narrow).toHaveBeenCalledWith(s.context.ownerId, s.context.db);
});

/** A pending future-run approval of `action` of `toolId` in a new Job, answered Always: whether it was remembered. */
async function asking(s: Awaited<ReturnType<typeof setup>>, toolId: string, action: string) {
  const { runId, step } = await s.startJob();
  const [tool] = await s.context.db.select().from(tools).where(eq(tools.id, toolId));
  const base = { kind: "tool" as const, agentId: s.agent.id, toolId, action, target: toolPermissionTarget(tool!) };
  const ask = async (id: string, subject: typeof base & { strictTarget?: string }) => {
    await s.context.db.insert(questions).values({ id, ownerId: s.context.ownerId, runId, stepRunId: step.id, sessionId: step.sessionId, placement: "notifications", kind: "approval", payload: { kind: "permission", toolName: "echo", input: {}, canAlwaysAllow: false }, status: "pending", remember: { scopes: ["run", "always"], subject } });
    return remember(s.context.db, { questionId: id, decision: "allow", scope: "always", by: { type: "user", userId: s.context.ownerId } });
  };
  return { tool: tool!, base, ask };
}

test("with strict permissions, an Always answer holds only for the tool and configuration that asked", async () => {
  const s = await setup();
  await s.strict(true);
  const { tool, base, ask } = await asking(s, s.echo.id, "echo");
  const current = (await strictTargets(s.context.db, s.context.workspaceId, s.context.ownerId, s.agent.id, [tool], []))!(tool)!;
  // Offered before strict permissions were on: no strict target, nothing remembered.
  expect(await ask("q_1", base)).toBe(false);
  await s.edits.newAction();
  // Offered for the listing before the new action.
  expect(await ask("q_2", { ...base, strictTarget: current })).toBe(false);
  const [listed] = await s.context.db.select().from(tools).where(eq(tools.id, s.echo.id));
  expect(await ask("q_3", { ...base, strictTarget: (await strictTargets(s.context.db, s.context.workspaceId, s.context.ownerId, s.agent.id, [listed!], []))!(listed!)! })).toBe(true);
  expect((await s.nextJob()).echo).toEqual(["echo"]);
});

test("with strict permissions, an Always answer for a skill's tool holds only for the skill files it was asked under", async () => {
  const s = await setup();
  await s.strict(true);
  const { tool, base, ask } = await asking(s, s.notes.id, "note");
  const target = async () => (await strictTargets(s.context.db, s.context.workspaceId, s.context.ownerId, s.agent.id, [tool], [s.packageId]))!(tool, s.packageId)!;
  const before = await target();
  await s.edits.skillFile();
  expect(await ask("q_1", { ...base, strictTarget: before })).toBe(false);
  expect(await ask("q_2", { ...base, strictTarget: await target() })).toBe(true);
  expect((await s.nextJob()).notes).toEqual(["note"]);
});

test("with strict permissions, an agent update proposal freezes only the grants that still hold", async () => {
  const s = await setup();
  await s.grant();
  const frozen = async () => {
    const item = await snapshotToolPermissions(s.context.db, s.context.workspaceId, s.context.ownerId, [], { tool: "agents_update", input: { id: s.agent.id, ...s.fields } });
    return typeof item === "string" ? item : item.toolPermissions?.find((p) => p.toolId === s.echo.id)?.unasked;
  };
  await s.edits.newAction();
  expect(await frozen()).toEqual(["echo"]);
  await s.strict(true);
  expect(await frozen()).toEqual([]);
});

test("a skill edit narrows the sessions already running", async () => {
  const s = await setup();
  const narrow = vi.spyOn(s.context.engine, "narrowOwnerSessions");
  await s.edits.skillFile();
  expect(narrow).toHaveBeenCalledWith(s.context.ownerId, s.context.db);
});

test("with strict permissions, an approved proposal's frozen list holds only for the tool as it was proposed", async () => {
  const s = await setup();
  await s.strict(true);
  await s.grant();
  const propose = async () => {
    const item = await snapshotToolPermissions(s.context.db, s.context.workspaceId, s.context.ownerId, [], { tool: "agents_update", input: { id: s.agent.id, ...s.fields } });
    if (typeof item === "string") throw new Error(item);
    const permissions = item.toolPermissions as { toolId: string; unasked: string[]; target: string; strictTarget?: string }[];
    expect(permissions.find((p) => p.toolId === s.echo.id)).toMatchObject({ unasked: ["echo"], strictTarget: expect.any(String) });
    return permissions;
  };
  const approve = async (permissions: Awaited<ReturnType<typeof propose>>) => {
    await call(router.agents.update, { id: s.agent.id, ...s.fields, toolPermissions: permissions.map(({ toolId, unasked }) => ({ toolId, unasked })) }, { context: { ...s.context, approvedToolTargets: permissions } });
    return (await s.nextJob()).echo;
  };
  expect(await approve(await propose())).toEqual(["echo"]);
  const proposed = await propose();
  await s.edits.newAction();
  expect(await approve(proposed)).toEqual([]);
  expect(await s.shown()).toBe("ask");
});

test("with strict permissions, a tool an approved proposal adds asks for everything when it changed since, never taking its defaults", async () => {
  const s = await setup();
  const readOnly = await startFakeMcp([{ name: "look", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, call: () => ({ content: [] }) }]);
  servers.push(readOnly);
  const looker = await call(router.tools.create, { name: "Look", url: readOnly.url, transport: "streamable-http", headers: {} }, { context: s.context });
  await s.strict(true);
  const input = { id: s.agent.id, ...s.fields, toolIds: [s.echo.id, looker.id], toolPermissions: [{ toolId: looker.id, unasked: [] }] };
  const item = await snapshotToolPermissions(s.context.db, s.context.workspaceId, s.context.ownerId, [], { tool: "agents_update", input });
  if (typeof item === "string") throw new Error(item);
  const permissions = item.toolPermissions as { toolId: string; unasked: string[]; target: string; strictTarget?: string }[];
  await s.edits.newAction();
  await s.context.db.update(tools).set({ actions: [{ name: "look", description: "", inputSchema: { type: "object", properties: { q: { type: "string" } } }, readOnly: true }] }).where(eq(tools.id, looker.id));
  await call(router.agents.update, { ...input, toolPermissions: permissions.map(({ toolId, unasked }) => ({ toolId, unasked })) }, { context: { ...s.context, approvedToolTargets: permissions } });
  const { runId } = await s.startJob();
  const [run] = await s.context.db.select().from(runs).where(eq(runs.id, runId));
  expect((await toolingOf(s.context.db, run!, s.agent.id)).httpTools.find((t) => t.id === looker.id)!.unasked).toEqual([]);
});
