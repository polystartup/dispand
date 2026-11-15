import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { plugins, stepRuns, tools } from "../db/schema.ts";
import { sessionTooling } from "../engine/tooling.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { startFakeMcp, type FakeAction, type FakeMcp } from "../tools/test-server.ts";
import { rememberAllowedAction } from "./tool-ask.ts";

const servers: FakeMcp[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((m) => m.close().catch(() => {})));
});

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
  await context.db.insert(plugins).values({ id: "plugin_1", ownerId: context.ownerId, name: "Forge", description: "Echo", sha: "a".repeat(40), components: { skills: [], mcpServers: [], agents: [] } });
  await context.db.update(tools).set({ pluginId: "plugin_1" }).where(eq(tools.id, echo.id));
  const skill = { name: "notes", description: "Takes notes.", instructions: "Write it down.", requiredToolIds: [notes.id] };
  const { packageId } = await call(router.skills.create, skill, { context });
  const harness = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context });
  const fields = { name: "Clerk", harnessId: harness.id, systemPrompt: "", skillPackageIds: [packageId], toolIds: [echo.id] };
  const agent = await call(router.agents.create, fields, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work", config: { kind: "manual", placement: "button" } }, { context });
  const nextJob = async () => {
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    const { httpTools } = await sessionTooling(context.db, step!.sessionId!);
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
  return { context, echo, echoServer, nextJob, grant, strict, edits, shown };
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
