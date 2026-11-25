import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { audit, plugins, workspaces } from "../db/schema.ts";
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
  expect((await toolingOf(context.db, run, agent.id)).nativePlugins).toEqual([{ pluginId: "plugin_kept", digest: DIGEST }]);
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
