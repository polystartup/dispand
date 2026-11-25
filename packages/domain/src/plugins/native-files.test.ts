import { call } from "@orpc/server";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { audit, pluginFiles, pluginNativeFiles, plugins as pluginsTable } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, jobIdentity, ownerContext, personContext, runnerWithClis } from "../runners/test-support.ts";
import { nativePluginForRunner } from "./runner-servers.ts";
import { fixtureRepo, installReviewed, lawFirm, updatePlugin } from "./test-support.ts";

const MCP = JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { notes: { type: "stdio", command: "./server.mjs" } },
});

/** The law-firm fixture (no stdio server unless `extra` adds one), in a marketplace of the owner's. */
async function market(extra: Record<string, string> = {}) {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  const plugin = fixtureRepo({ ...lawFirm(), ...extra });
  const repo = fixtureRepo({ ".claude-plugin/marketplace.json": JSON.stringify({ name: "firms", plugins: [{ name: "law-firm", source: { source: "url", url: plugin.url } }] }) });
  const { id: marketplaceId } = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const { pluginId } = await installReviewed(ctx, { marketplaceId, entryName: "law-firm" });
  const row = async () => (await ctx.db.select().from(pluginsTable).where(eq(pluginsTable.id, pluginId)))[0]!;
  const native = () => ctx.db.select({ path: pluginNativeFiles.path, content: pluginNativeFiles.content }).from(pluginNativeFiles).where(eq(pluginNativeFiles.pluginId, pluginId));
  return { ctx, plugin, pluginId, row, native, remove: () => (plugin.remove(), repo.remove()) };
}

test("an install keeps the whole plugin as its native revision, and leaves the stdio files' digest as it was", async () => {
  const plain = await market();
  try {
    const files = await plain.native();
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(Object.keys(lawFirm())));
    expect((await plain.row()).nativeDigest).toBe(contentDigest(files));
    // No stdio server: still no runner files and no digest.
    expect((await plain.row()).digest).toBeNull();
    expect(await plain.ctx.db.select().from(pluginFiles).where(eq(pluginFiles.pluginId, plain.pluginId))).toEqual([]);
  } finally {
    plain.remove();
  }
  const stdio = await market({ "mcp.json": MCP, "server.mjs": "console.log('notes');\n" });
  try {
    const row = await stdio.row();
    expect(row.digest).toBe(contentDigest(await stdio.ctx.db.select().from(pluginFiles).where(eq(pluginFiles.pluginId, stdio.pluginId))));
    expect(row.nativeDigest).toBe(contentDigest(await stdio.native()));
  } finally {
    stdio.remove();
  }
});

test("an update moves the native revision, and the runner gets it only while one of its agents holds the grant", async () => {
  const fx = await market();
  try {
    const { runnerId } = await runnerWithClis(fx.ctx);
    const other = (await runnerWithClis(fx.ctx, "Other")).runnerId;
    const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: fx.ctx }));
    const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context: fx.ctx });
    const first = (await fx.row()).nativeDigest!;
    expect(await nativePluginForRunner(fx.ctx.db, runnerId, fx.pluginId, first)).toBeNull();

    await call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: [fx.pluginId] }, { context: fx.ctx });
    const sent = await nativePluginForRunner(fx.ctx.db, runnerId, fx.pluginId, first);
    expect(sent!.files.map((f) => f.path).sort()).toEqual((await fx.native()).map((f) => f.path).sort());
    // Another runner, whose agents hold no grant, gets nothing.
    expect(await nativePluginForRunner(fx.ctx.db, other, fx.pluginId, first)).toBeNull();

    fx.plugin.commit({ "README.md": "One more line.\n" });
    await updatePlugin(fx.ctx, fx.pluginId);
    const moved = (await fx.row()).nativeDigest!;
    expect(moved).not.toBe(first);
    expect(moved).toBe(contentDigest(await fx.native()));
    // The revision a start named before the update is no longer served; the new one is.
    expect(await nativePluginForRunner(fx.ctx.db, runnerId, fx.pluginId, first)).toBeNull();
    expect((await nativePluginForRunner(fx.ctx.db, runnerId, fx.pluginId, moved))!.files.some((f) => f.path === "README.md")).toBe(true);

    await call(router.agents.setNativePlugins, { agentId: agent.id, pluginIds: [] }, { context: fx.ctx });
    expect(await nativePluginForRunner(fx.ctx.db, runnerId, fx.pluginId, moved)).toBeNull();
  } finally {
    fx.remove();
  }
});

test("a plugin too large to read whole still installs, with no native revision", async () => {
  // Past the read's budget of entries, in a folder the import itself never reads.
  const data = Object.fromEntries(Array.from({ length: 20_100 }, (_, i) => [`data/${i}.txt`, ""]));
  const fx = await market(data);
  try {
    expect((await fx.row()).nativeDigest).toBeNull();
    expect(await fx.native()).toEqual([]);
  } finally {
    fx.remove();
  }
}, 120_000);

test("a Job's own update never moves the native revision, even when a manager started it; a proposal item a person approved does", async () => {
  const fx = await market();
  try {
    const job = { ...fx.ctx, job: await jobIdentity(fx.ctx) };
    const first = (await fx.row()).nativeDigest!;
    const sha = fx.plugin.commit({ "README.md": "From a Job.\n" });
    await updatePlugin(job, fx.pluginId);
    // The update went through, its revision didn't: the pinned files are still the first ones.
    expect((await fx.row()).sha).toBe(sha);
    expect((await fx.row()).nativeDigest).toBe(first);
    expect(contentDigest(await fx.native())).toBe(first);

    fx.plugin.commit({ "README.md": "Approved.\n" });
    await updatePlugin({ ...job, approvedBy: fx.ctx.ownerId }, fx.pluginId);
    const approved = (await fx.row()).nativeDigest!;
    expect(approved).not.toBe(first);
    expect(approved).toBe(contentDigest(await fx.native()));
  } finally {
    fx.remove();
  }
});

test("a manager approves the revision a Job's update left behind; a member or the Job itself can't", async () => {
  const fx = await market();
  try {
    const behind = async () => (await call(router.plugins.list, undefined, { context: fx.ctx })).find((p) => p.id === fx.pluginId)!.nativeBehind;
    expect(await behind()).toBe(false);
    const job = { ...fx.ctx, job: await jobIdentity(fx.ctx) };
    const first = (await fx.row()).nativeDigest!;
    const sha = fx.plugin.commit({ "run.sh": "echo from a Job\n" });
    await updatePlugin(job, fx.pluginId);
    expect(await behind()).toBe(true);

    // The screen first: what would run natively, against the pinned revision.
    const shown = await call(router.plugins.nativePreview, { id: fx.pluginId }, { context: fx.ctx });
    expect(shown.sha).toBe(sha);
    expect(shown.runsNatively.changed).toBe(true);
    const { reviewed } = shown;
    await expect(call(router.plugins.approveNative, { id: fx.pluginId, sha, reviewed }, { context: job })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const member = await personContext(fx.ctx, "user_member", "member");
    await expect(call(router.plugins.approveNative, { id: fx.pluginId, sha, reviewed }, { context: { ...member, gitFileUrls: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await fx.row()).nativeDigest).toBe(first);

    // A revision other than the one shown is refused.
    await expect(call(router.plugins.approveNative, { id: fx.pluginId, sha: first.slice(7, 47), reviewed }, { context: fx.ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    // A token other than the screen's is refused.
    await expect(call(router.plugins.approveNative, { id: fx.pluginId, sha, reviewed: "0".repeat(64) }, { context: fx.ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    await call(router.plugins.approveNative, { id: fx.pluginId, sha, reviewed }, { context: fx.ctx });
    const row = await fx.row();
    expect(row.nativeSha).toBe(sha);
    expect(row.nativeDigest).toBe(contentDigest(await fx.native()));
    expect(row.nativeDigest).not.toBe(first);
    expect(await behind()).toBe(false);
    // Ids and a count only.
    const rows = await fx.ctx.db.select({ resourceId: audit.resourceId, details: audit.details }).from(audit).where(eq(audit.action, "plugin.nativeApproved"));
    expect(rows).toEqual([{ resourceId: fx.pluginId, details: { items: (await fx.native()).length } }]);

    // The source moved past the plugin's commit: approving is a conflict, the plugin is updated instead.
    fx.plugin.commit({ "README.md": "Upstream again.\n" });
    await expect(call(router.plugins.approveNative, { id: fx.pluginId, sha, reviewed }, { context: fx.ctx })).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    fx.remove();
  }
});

test("a plugin whose servers are declared only in its root .mcp.json keeps it in its native revision, never in its runner files", async () => {
  const mcp = JSON.stringify({ mcpServers: { notes: { type: "stdio", command: "./server.mjs" } } });
  const fx = await market({ ".mcp.json": mcp, "server.mjs": "console.log('notes');\n", "nested/.mcp.json": "{}" });
  try {
    const native = await fx.native();
    expect(Buffer.from(native.find((f) => f.path === ".mcp.json")!.content).toString()).toBe(mcp);
    expect(native.some((f) => f.path === "nested/.mcp.json")).toBe(false);
    expect((await fx.row()).nativeDigest).toBe(contentDigest(native));
    expect((await fx.ctx.db.select().from(pluginFiles).where(eq(pluginFiles.pluginId, fx.pluginId))).some((f) => f.path.endsWith(".mcp.json"))).toBe(false);
  } finally {
    fx.remove();
  }
});

test("a change only to what runs natively makes an update stop on its screen, shown against the pinned revision", async () => {
  const hooks = (command: string) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
  const fx = await market({ "hooks/hooks.json": hooks("./a.sh"), "a.sh": "echo one\n" });
  try {
    const install = await call(router.plugins.preview, { marketplaceId: (await fx.row()).marketplaceId!, entryName: "law-firm" }, { context: fx.ctx });
    expect(install.runsNatively.map((e) => `${e.kind} ${e.label}`)).toEqual(expect.arrayContaining(["hook Stop", "file a.sh"]));

    // A Job's own update moves the commit, not the pin: the next screen compares with the pinned revision.
    fx.plugin.commit({ "a.sh": "echo two\n" });
    await updatePlugin({ ...fx.ctx, job: await jobIdentity(fx.ctx) }, fx.pluginId);
    fx.plugin.commit({ "a.sh": "echo three\n" });
    const preview = await call(router.plugins.updatePreview, { id: fx.pluginId }, { context: fx.ctx });
    expect(preview.runsNatively.changed).toBe(true);
    expect(preview.runsNatively.before.find((e) => e.label === "a.sh")!.text).toBe("echo one\n");
    expect(preview.runsNatively.after.find((e) => e.label === "a.sh")!.text).toBe("echo three\n");
    // Not silent: without the screen's token, it doesn't apply, and the pin stays.
    const pinned = (await fx.row()).nativeDigest;
    await expect(call(router.plugins.update, { id: fx.pluginId }, { context: fx.ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await fx.row()).nativeDigest).toBe(pinned);
    // A revision that moved since the screen: its token no longer matches.
    fx.plugin.commit({ "a.sh": "echo four\n" });
    await expect(call(router.plugins.update, { id: fx.pluginId, reviewed: preview.reviewed }, { context: fx.ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    await updatePlugin(fx.ctx, fx.pluginId);
    expect((await fx.row()).nativeDigest).toBe(contentDigest(await fx.native()));
  } finally {
    fx.remove();
  }
});
