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

const base = { harnessIds: ["harness_1"], resource: { kind: "plugin" as const, id: "plugin_1" }, action: "add" as const, dryRun: true };

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
  await expect(call(router.runners.workspacePlugin, { ...base, harnessIds: ["unknown"] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
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


async function secondHarness(context: Awaited<ReturnType<typeof ownerContext>>, runnerId = "runner_1") {
  await context.db.insert(harnesses).values({ id: "harness_2", ownerId: context.ownerId, name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" });
}

test("selected harnesses on one runner share one native operation and preserve per-target outcomes", async () => {
  const { context, request } = await setup();
  await pluginFixture(context);
  await secondHarness(context);
  request.mockImplementation(async (_id, req) => ({ type: "plugin.replied", requestId: req.requestId, report: req.operation.action === "list" ? {} : {
    error: "One target failed", results: [{ name: "dispand-plugin_1", harness: "codex", status: "installed" }, { name: "dispand-plugin_1", harness: "claude-code", status: "failed" }],
  } }));
  const report = await call(router.runners.workspacePlugin, { ...base, harnessIds: ["harness_2", "harness_1"], dryRun: false, revision: "preview123" }, { context });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]![1].operation).toMatchObject({ action: "add", targets: ["codex", "claude-code"], revision: "preview123", sourceRef: "a".repeat(40) });
  expect(report).toEqual({ error: "One target failed", results: [{ name: "dispand-plugin_1", harness: "codex", status: "installed" }, { name: "dispand-plugin_1", harness: "claude-code", status: "failed" }] });
});

test("a grouped install skips verified native bindings while installing the remaining target", async () => {
  const { context, request } = await setup();
  await pluginFixture(context);
  await secondHarness(context);
  const [item] = await call(router.runners.workspaceSkills, undefined, { context });
  const installed = { name: "existing", sourceKey: item!.sourceKey, harness: "codex" as const, installed: true, enabled: true, pending: false };
  request.mockImplementation(async (_id, req) => ({ type: "plugin.replied", requestId: req.requestId, report: req.operation.action === "list" ? { packages: [installed] }
    : { results: [{ name: "dispand-plugin_1", harness: "claude-code", status: "installed" }] } }));
  const report = await call(router.runners.workspacePlugin, { ...base, harnessIds: ["harness_1", "harness_2"], dryRun: false, revision: "preview123" }, { context });
  expect(request.mock.calls[1]![1].operation).toMatchObject({ targets: ["claude-code"] });
  expect(report.results).toEqual([{ name: "existing", harness: "codex", status: "already_installed" }, { name: "dispand-plugin_1", harness: "claude-code", status: "installed" }]);
  request.mockClear().mockImplementation(async (_id, req) => ({ type: "plugin.replied", requestId: req.requestId, report: { packages: [installed, { ...installed, harness: "claude-code" }] } }));
  const existing = await call(router.runners.workspacePlugin, { ...base, harnessIds: ["harness_1", "harness_2"] }, { context });
  expect(request).toHaveBeenCalledTimes(1);
  expect(existing.results?.map((r) => r.status)).toEqual(["already_installed", "already_installed"]);
});

test("a conflicting target blocks mutation without hiding an already installed target", async () => {
  const { context, request } = await setup();
  await pluginFixture(context);
  await secondHarness(context);
  const [item] = await call(router.runners.workspaceSkills, undefined, { context });
  request.mockImplementation(async (_id, req) => ({ type: "plugin.replied", requestId: req.requestId, report: { packages: [
    { name: "dispand-plugin_1", sourceKey: item!.sourceKey, harness: "codex", installed: true, enabled: false, pending: false },
    { name: "existing", sourceKey: item!.sourceKey, harness: "claude-code", installed: true, enabled: true, pending: false },
  ] } }));
  const report = await call(router.runners.workspacePlugin, { ...base, harnessIds: ["harness_1", "harness_2"] }, { context });
  expect(report).toMatchObject({ blocked: true, results: [{ name: "existing", harness: "claude-code", status: "already_installed" }] });
  expect(request).toHaveBeenCalledTimes(1);
});

test("every grouped target must be owned, valid and on the same runner", async () => {
  const { context, request } = await setup();
  await pluginFixture(context);
  await context.db.insert(user).values({ id: "other", name: "Other", email: "other@example.com" });
  await context.db.insert(runners).values({ id: "foreign_runner", ownerId: "other", name: "Other" });
  await context.db.insert(harnesses).values({ id: "foreign_harness", ownerId: "other", name: "Other", runnerId: "foreign_runner", kind: "claude-code", permissionMode: "default" });
  await expect(call(router.runners.workspacePlugin, { ...base, harnessIds: ["harness_1", "foreign_harness"] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await context.db.insert(runners).values({ id: "runner_2", ownerId: context.ownerId, name: "Second" });
  await secondHarness(context, "runner_2");
  await expect(call(router.runners.workspacePlugin, { ...base, harnessIds: ["harness_1", "harness_2"] }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.runners.workspacePlugin, { ...base, harnessIds: ["harness_1", "harness_1"] }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.runners.workspacePlugin, { ...base, harnessIds: ["harness_1", "harness_2"], action: "remove" }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(request).not.toHaveBeenCalled();
});
