import { createHash } from "node:crypto";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { harnesses, marketplaces, plugins, runners, skillPackages, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { packageForRunner } from "../skills/runner-access.ts";
import { ownerContext } from "./test-support.ts";

async function setup() {
  const context = await ownerContext();
  await context.db.insert(runners).values({ id: "runner_1", ownerId: context.ownerId, name: "Workstation" });
  await context.db.insert(harnesses).values({ id: "harness_1", ownerId: context.ownerId, name: "Review", runnerId: "runner_1", kind: "codex", permissionMode: "default" });
  const request = vi.spyOn(context.hub, "plugins").mockImplementation(async (_id, request) => ({ type: "plugin.replied", requestId: request.requestId, report: { revision: "preview123", blocked: false, changes: [] } }));
  return { context, request };
}

async function pluginFixture(context: Awaited<ReturnType<typeof ownerContext>>) {
  await context.db.insert(marketplaces).values({ id: "market_1", ownerId: context.ownerId, name: "Team", url: "https://example.com/team.git" });
  await context.db.insert(plugins).values({ id: "plugin_1", ownerId: context.ownerId, name: "A friendly display name", description: "Reviews", marketplaceId: "market_1", entryName: "review-tools", nativeRoot: ".", url: "https://example.com/review.git", sha: "a".repeat(40), components: { skills: [], mcpServers: [], agents: [] } });
  await context.db.insert(skillPackages).values({ id: "skillpkg_plugin", ownerId: context.ownerId, name: "review-tools", description: "Reviews", pluginId: "plugin_1" });
}

const base = { harnessId: "harness_1", resource: { kind: "plugin" as const, id: "plugin_1" }, action: "add" as const, dryRun: true };

test("workspace native installation derives pinned source and stable identity from owned records", async () => {
  const { context, request } = await setup();
  await pluginFixture(context);
  await call(router.runners.workspacePlugin, base, { context });
  expect(request.mock.calls[0]![0]).toBe("runner_1");
  expect(request.mock.calls[1]![1].operation).toEqual({ action: "add", name: "dispand-plugin_1", targets: ["codex"], source: "https://example.com/review.git", sourceRef: "a".repeat(40), plugin: "review-tools", dryRun: true });
  await context.db.update(plugins).set({ name: "Renamed display name" }).where(eq(plugins.id, "plugin_1"));
  await call(router.runners.workspacePlugin, { ...base, dryRun: false, revision: "preview123" }, { context });
  expect(request.mock.calls[3]![1].operation).toMatchObject({ name: "dispand-plugin_1", plugin: "review-tools", sourceRef: "a".repeat(40), revision: "preview123" });
  const inventory = await call(router.runners.workspaceSkills, undefined, { context });
  expect(inventory).toHaveLength(1);
  expect(inventory[0]).toMatchObject({ name: "Renamed display name", resource: { kind: "plugin", id: "plugin_1" }, nativeName: "dispand-plugin_1", sourceKey: createHash("sha256").update(JSON.stringify(["https://example.com/review", "a".repeat(40), "review-tools"])).digest("hex") });
  await expect(call(router.runners.workspacePlugin, { ...base, resource: { kind: "skill", id: "skillpkg_plugin" } }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("whole native plugin") });
  expect(request).toHaveBeenCalledTimes(4);
});

test("standalone skills can install before an agent uses them; session fallback tracks exact content", async () => {
  const { context, request } = await setup();
  const fields = { name: "writing", description: "Write clearly", instructions: "Use plain words", requiredToolIds: [] };
  const { packageId } = await call(router.skills.create, { ...fields, files: [{ path: "notes.txt", base64: Buffer.from("Notes").toString("base64") }] }, { context });
  const resource = { kind: "skill" as const, id: packageId };
  await call(router.runners.workspacePlugin, { ...base, resource }, { context });
  expect(request.mock.calls[1]![1].operation).toMatchObject({ action: "add-workspace", name: `dispand-${packageId}`, targets: ["codex"], files: expect.arrayContaining([{ path: "writing/notes.txt", base64: Buffer.from("Notes").toString("base64") }]) });
  const [before] = await call(router.runners.workspaceSkills, undefined, { context });
  await call(router.agents.create, { name: "Writer", harnessId: "harness_1", systemPrompt: "", skillPackageIds: [packageId] }, { context });
  expect(await packageForRunner(context.db, "runner_1", packageId)).toMatchObject({ nativePlugin: before!.nativeName, nativeKey: before!.sourceKey });
  await call(router.skills.update, { ...fields, packageId, instructions: "Updated instructions" }, { context });
  const [after] = await call(router.runners.workspaceSkills, undefined, { context });
  expect(after!.nativeName).toBe(before!.nativeName);
  expect(after!.sourceKey).not.toBe(before!.sourceKey);
  await call(router.runners.workspacePlugin, { ...base, resource, action: "remove" }, { context });
  expect(request.mock.calls.at(-1)![1].operation).toEqual({ action: "remove", name: `dispand-${packageId}`, targets: ["codex"], dryRun: true });
  expect((await call(router.skills.get, { packageId }, { context })).instructions).toBe("Updated instructions\n");
});

test("native workspace APIs reject foreign records, unreviewed apply, jobs and unsupported sources", async () => {
  const { context, request } = await setup();
  await pluginFixture(context);
  await context.db.insert(user).values({ id: "other", name: "Other", email: "other@example.com" });
  await context.db.insert(skillPackages).values({ id: "foreign", ownerId: "other", name: "writing", description: "Private" });
  await expect(call(router.runners.workspacePlugin, { ...base, resource: { kind: "skill", id: "foreign" } }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.runners.workspacePlugin, { ...base, harnessId: "unknown" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.runners.workspacePlugin, { ...base, dryRun: false }, { context })).rejects.toThrow();
  const jobContext = { ...context, job: { runId: "run_1", ownerId: context.ownerId, agentId: "agent_1" } };
  await expect(call(router.runners.workspacePlugin, base, { context: jobContext })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(call(router.runners.workspaceSkills, undefined, { context: jobContext })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(call(router.runners.plugins, { runnerId: "runner_1", operation: { action: "list" } }, { context: jobContext })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await context.db.update(plugins).set({ url: "file:///private/source" }).where(eq(plugins.id, "plugin_1"));
  await expect(call(router.runners.workspacePlugin, base, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(request).not.toHaveBeenCalled();
});

test("uninstall reuses a differently named Skillshare binding only by the verified workspace source", async () => {
  const { context, request } = await setup();
  await pluginFixture(context);
  const [item] = await call(router.runners.workspaceSkills, undefined, { context });
  let enabled = true;
  request.mockImplementation(async (_id, req) => ({ type: "plugin.replied", requestId: req.requestId, report: req.operation.action === "list" ? {
    packages: [
      { name: "display-name-collision", sourceKey: "different-source", harness: "codex", installed: true, enabled: true, pending: false },
      { name: "already-managed", sourceKey: item!.sourceKey, harness: "codex", installed: true, enabled, pending: false },
    ],
  } : { revision: "preview123", blocked: false, changes: [] } }));
  const existing = await call(router.runners.workspacePlugin, base, { context });
  expect(existing.results).toEqual([{ name: "already-managed", harness: "codex", status: "already_installed" }]);
  expect(request).toHaveBeenCalledTimes(1);
  enabled = false;
  expect(await call(router.runners.workspacePlugin, base, { context })).toMatchObject({ blocked: true, error: expect.stringContaining("disabled") });
  expect(request).toHaveBeenCalledTimes(2);
  enabled = true;
  await call(router.runners.workspacePlugin, { ...base, action: "remove" }, { context });
  expect(request.mock.calls.at(-1)![1].operation).toEqual({ action: "remove", name: "already-managed", targets: ["codex"], dryRun: true });
});

test("unverified and subdirectory imports cannot select a different native root plugin", async () => {
  const { context, request } = await setup();
  await pluginFixture(context);
  for (const nativeRoot of [null, "plugins/review"]) {
    await context.db.update(plugins).set({ nativeRoot }).where(eq(plugins.id, "plugin_1"));
    await expect(call(router.runners.workspacePlugin, base, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const inventory = await call(router.runners.workspaceSkills, undefined, { context });
    expect(inventory[0]!.sourceKey).toBeUndefined();
  }
  expect(request).not.toHaveBeenCalled();
});
