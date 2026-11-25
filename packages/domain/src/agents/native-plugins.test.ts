import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import type { ServerToRunner } from "@dispand/runner-protocol";
import { expect, onTestFinished, test, vi } from "vitest";
import { audit, plugins, stepRuns, tools, workspaces } from "../db/schema.ts";
import { CliHarnessAdapter } from "../engine/cli-harness.ts";
import { Engine } from "../engine/engine.ts";
import { stepView } from "../engine/views.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { toolingOf } from "../engine/tooling.ts";
import { router } from "../rpc/router.ts";
import { asCli, jobIdentity, ownerContext, personContext, runnerWithClis } from "../runners/test-support.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context });
  const plugin = (id: string, extra: Partial<typeof plugins.$inferInsert> = {}) =>
    context.db.insert(plugins).values({ id, ownerId: context.ownerId, workspaceId: context.workspaceId, name: id, description: "", sha: "a".repeat(40), components: { skills: [], mcpServers: [], agents: [] }, ...extra });
  await plugin("plugin_kept", { nativeDigest: DIGEST });
  await plugin("plugin_old");
  return { context, agent, plugin };
}

test("a manager grants an agent native plugins; its sessions get the kept revisions, a restricted one none", async () => {
  const { context, agent } = await setup();
  await call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: ["plugin_kept", "plugin_old"] }, { context });
  expect(await call(router.agents.nativePlugins, { agentId: agent.id }, { context })).toEqual(["plugin_kept", "plugin_old"]);
  const run = { workspaceId: context.workspaceId, snapshot: null };
  // A plugin with no revision kept yet (imported before) isn't sent.
  expect((await toolingOf(context.db, run, agent.id)).nativePlugins).toEqual([{ pluginId: "plugin_kept", digest: DIGEST, managedServers: [] }]);
  const restricted = { workspaceId: context.workspaceId, snapshot: { id: agent.id, name: "Clerk", harnessId: "x", systemPrompt: "", skills: [], tools: [], only: ["plugin_decide"] } };
  expect((await toolingOf(context.db, restricted, agent.id)).nativePlugins).toEqual([]);
  // Ids and counts only.
  const rows = await context.db.select({ details: audit.details, resourceId: audit.resourceId }).from(audit).where(eq(audit.action, "plugin.nativeGranted"));
  expect(rows).toEqual([{ resourceId: agent.id, details: { agentId: agent.id, items: 2 } }]);
  await call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: [] }, { context });
  expect((await toolingOf(context.db, run, agent.id)).nativePlugins).toEqual([]);
});

test("a member, a Job, another workspace's or a generated plugin can't be granted; nothing is saved", async () => {
  const { context, agent, plugin } = await setup();
  await plugin("plugin_generated", { source: "generated", sha: null });
  const member = await personContext(context, "user_member", "member");
  const manager = await personContext(context, "user_manager", "manager");
  for (const pluginId of ["plugin_generated", "plugin_none"]) {
    await expect(call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: ["plugin_kept", pluginId] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  await expect(call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: ["plugin_kept"] }, { context: member })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: ["plugin_kept"] }, { context: manager });
  expect(await call(router.agents.nativePlugins, { agentId: agent.id }, { context: member })).toEqual(["plugin_kept"]);
  await expect(call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: [] }, { context: { ...context, job: await jobIdentity(context, agent.id) } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await context.db.select().from(audit).where(and(eq(audit.action, "plugin.nativeGranted"), eq(audit.ownerId, context.ownerId)))).toHaveLength(0);
  // Removing the plugin removes the grant.
  await context.db.delete(plugins).where(eq(plugins.id, "plugin_kept"));
  expect(await call(router.agents.nativePlugins, { agentId: agent.id }, { context })).toEqual([]);
  // Last: with a second workspace, the owner names theirs.
  await context.db.insert(workspaces).values({ id: "sibling", organizationId: context.organizationId });
  await plugin("plugin_theirs", { workspaceId: "sibling", nativeDigest: DIGEST });
  const here = { ...context, headers: new Headers([...context.headers, ["dispand-workspace", context.workspaceId], ["dispand-organization", context.organizationId]]) };
  await expect(call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: ["plugin_theirs"] }, { context: here })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a session names each granted plugin's servers Dispand manages as tools, read at each start", async () => {
  const { context, agent } = await setup();
  await call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: ["plugin_kept"] }, { context });
  const run = { workspaceId: context.workspaceId, snapshot: null };
  expect((await toolingOf(context.db, run, agent.id)).nativePlugins[0]!.managedServers).toEqual([]);
  // Registered after the grant: named at the next start.
  await context.db.insert(tools).values({ id: "tool_notes", ownerId: context.ownerId, workspaceId: context.workspaceId, name: "notes", kind: "http", url: "https://example.com/mcp", transport: "streamable-http", pluginId: "plugin_kept", pluginComponent: "notes" });
  expect((await toolingOf(context.db, run, agent.id)).nativePlugins).toEqual([{ pluginId: "plugin_kept", digest: DIGEST, managedServers: ["notes"] }]);
});

test("a session's start keeps the native plugins it named on its step, by id and name, for the run view", async () => {
  const { context, agent } = await setup();
  await call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: ["plugin_kept", "plugin_old"] }, { context });
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_id: string, msg: ServerToRunner) => (sent.push(msg), true) };
  const engine = new Engine(context.db, new CliHarnessAdapter(context.db, hub as unknown as RunnerHub, context.secrets), undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  await engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(sent.some((m) => m.type === "session.start")).toBe(true));
  const start = sent.flatMap((m) => (m.type === "session.start" ? [m.start] : []))[0]!;
  expect(start.nativePlugins?.map((p) => p.pluginId)).toEqual(["plugin_kept"]);
  // Only what the start named: a plugin with no revision kept wasn't sent, so it isn't listed.
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.sessionId, start.sessionId));
  expect(step!.nativePlugins).toEqual([{ pluginId: "plugin_kept", name: "plugin_kept" }]);
  expect(stepView(step!).nativePlugins).toEqual(["plugin_kept"]);
});
