import { call } from "@orpc/server";
import { contentDigest } from "@dispand/runner-protocol/digest";
import type { ServerToRunner } from "@dispand/runner-protocol";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { pluginFiles, plugins as pluginsTable, tools } from "../db/schema.ts";
import { toolingOf } from "../engine/tooling.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { InstalledTools } from "../tools/executor.ts";
import { pollCaller } from "../tools/poll.ts";
import { pluginForRunner } from "./runner-servers.ts";
import { fixtureRepo, installReviewed, lawFirm, removePlugin, updatePlugin } from "./test-support.ts";
import { stored } from "../messages/index.ts";

const SERVER = "#!/usr/bin/env node\nconsole.log('notes');\n";
const MCP = JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { notes: { type: "stdio", command: "./server.mjs", args: ["--stdio", "${PLUGIN_DATA}"] } },
});

/** The law-firm fixture with a stdio server (`notes`, a file of the plugin), installed; a runner of the owner. */
async function installed(extra: Record<string, string> = {}) {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  const plugin = fixtureRepo({ ...lawFirm(), "mcp.json": MCP, "server.mjs": SERVER, ...extra });
  const repo = fixtureRepo({ ".claude-plugin/marketplace.json": JSON.stringify({ name: "firms", plugins: [{ name: "law-firm", source: { source: "url", url: plugin.url } }] }) });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context: ctx });
  const discovered: ServerToRunner[] = [];
  ctx.hub.request = async (_id, msg) => {
    discovered.push(msg);
    return { type: "tool.discovered", requestId: msg.requestId, actions: [{ name: "search", description: "Searches notes", inputSchema: { type: "object" }, readOnly: true }] };
  };
  return { ctx, plugin, market, runnerId, discovered, remove: () => (plugin.remove(), repo.remove()) };
}

type Installed = Awaited<ReturnType<typeof installed>>;

async function addOnRunner({ ctx, runnerId }: Installed, pluginId: string, servers: { name: string; runnerId?: string }[] = [{ name: "notes", runnerId }]) {
  const pick = { servers };
  const { reviewed, waiting } = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  const done = await call(router.plugins.setUp, { id: pluginId, pick, reviewed }, { context: ctx });
  return { ...done, previewWaiting: waiting };
}

test("a standard plugin's stdio server becomes a runner tool: the files kept, their digest shown, a plugin reference sent", async () => {
  const fx = await installed();
  try {
    const { pluginId } = await installReviewed(fx.ctx, { marketplaceId: fx.market.id, entryName: "law-firm" });
    const [row] = await fx.ctx.db.select().from(pluginsTable).where(eq(pluginsTable.id, pluginId));
    const files = await fx.ctx.db.select().from(pluginFiles).where(eq(pluginFiles.pluginId, pluginId));
    expect(files.map((f) => f.path)).toContain("server.mjs");
    expect(files.map((f) => f.path).some((p) => p.startsWith(".git"))).toBe(false);
    expect(row!.digest).toBe(contentDigest(files));

    // Without a runner picked, it waits, and says how to add it.
    expect((await addOnRunner(fx, pluginId, [{ name: "notes" }])).previewWaiting).toEqual([{ definition: "tool:notes", reason: { key: "plugins.setup.waiting.onRunner" } }]);
    await addOnRunner(fx, pluginId);
    const [tool] = await fx.ctx.db.select().from(tools).where(eq(tools.pluginId, pluginId));
    expect(tool).toMatchObject({ kind: "runner", runnerId: fx.runnerId, runnerTool: null, pluginComponent: "notes" });
    const ref = { tool: tool!.id, plugin: "law-firm", digest: row!.digest, entry: { command: "./server.mjs", args: ["--stdio", "${PLUGIN_DATA}"], env: {} } };
    expect(fx.discovered).toEqual([{ type: "tool.discover", requestId: expect.stringMatching(/^req_/), tool: ref }]);
    const view = await call(router.tools.get, { id: tool!.id }, { context: fx.ctx });
    expect(view).toMatchObject({ actions: [{ name: "search" }], pluginServer: { plugin: "law-firm", digest: row!.digest, entry: ref.entry, commandIsFile: true } });

    // Polls and sessions reach it by the same reference.
    const calls: ServerToRunner[] = [];
    fx.ctx.hub.call = async (_id, msg) => {
      calls.push(msg);
      return { type: "tool.called", requestId: msg.requestId, content: [{ type: "text", text: "[]" }] };
    };
    const polled = await pollCaller(new InstalledTools(fx.ctx.db, fx.ctx.secrets, fx.ctx.tools), fx.ctx.hub).call(tool!, "search", {});
    expect(polled).toEqual({ ok: true, data: [], hasMore: false });
    expect(calls).toEqual([{ type: "tool.call", requestId: expect.any(String), tool: ref, action: "search", arguments: {} }]);
    const harness = await call(router.harnesses.create, { name: "Claude", runnerId: fx.runnerId, kind: "claude-code", permissionMode: "default" }, { context: fx.ctx });
    const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", toolIds: [tool!.id] }, { context: fx.ctx });
    expect((await toolingOf(fx.ctx.db, { ownerId: fx.ctx.ownerId, snapshot: null }, agent.id)).runnerTools).toMatchObject([{ id: tool!.id, tool: tool!.id, plugin: ref }]);

    // The files go to that runner only.
    expect(await pluginForRunner(fx.ctx.db, fx.runnerId, tool!.id)).toMatchObject({ name: "law-firm", entry: ref.entry, files: expect.arrayContaining([{ path: "server.mjs", base64: Buffer.from(SERVER).toString("base64") }]) });
    const { runnerId: other } = await call(router.runners.create, { name: "Laptop" }, { context: fx.ctx });
    expect(await pluginForRunner(fx.ctx.db, other, tool!.id)).toBeNull();
  } finally {
    fx.remove();
  }
});

test("an update that changes a file changes the digest; uninstalling keeps the tool, which says its plugin was removed", async () => {
  const fx = await installed();
  try {
    const { pluginId } = await installReviewed(fx.ctx, { marketplaceId: fx.market.id, entryName: "law-firm" });
    await addOnRunner(fx, pluginId);
    const [tool] = await fx.ctx.db.select().from(tools).where(eq(tools.pluginId, pluginId));
    const before = (await call(router.tools.get, { id: tool!.id }, { context: fx.ctx })).pluginServer!.digest;
    fx.plugin.commit({ "server.mjs": `${SERVER}// one more line\n` });
    await updatePlugin(fx.ctx, pluginId);
    const after = (await call(router.tools.get, { id: tool!.id }, { context: fx.ctx })).pluginServer!.digest;
    expect(after).not.toBe(before);
    expect(after).toBe(contentDigest(await fx.ctx.db.select().from(pluginFiles).where(eq(pluginFiles.pluginId, pluginId))));

    await removePlugin(fx.ctx, pluginId);
    expect(await fx.ctx.db.select().from(pluginFiles).where(eq(pluginFiles.pluginId, pluginId))).toEqual([]);
    const kept = await call(router.tools.refresh, { id: tool!.id }, { context: fx.ctx });
    expect(kept).toMatchObject({ id: tool!.id, plugin: null, pluginServer: null, actionsError: stored("tools.plugin.removed") });
    expect(await pluginForRunner(fx.ctx.db, fx.runnerId, tool!.id)).toBeNull();
  } finally {
    fx.remove();
  }
});

test("a plugin larger than a runner takes installs and updates, keeping no files; its stdio server isn't added, with the reason", async () => {
  const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`data/${i}.txt`, "x"]));
  const fx = await installed(many);
  try {
    const { pluginId } = await installReviewed(fx.ctx, { marketplaceId: fx.market.id, entryName: "law-firm", skills: ["legal-research"] });
    const [row] = await fx.ctx.db.select().from(pluginsTable).where(eq(pluginsTable.id, pluginId));
    expect(row!.digest).toBeNull();
    expect(row!.notImported).toContainEqual({ component: "mcp-server", name: "notes", reason: "The plugin is larger than a runner takes (500 files or 11 MiB): this server can't run as a runner tool" });
    expect(await fx.ctx.db.select().from(pluginFiles).where(eq(pluginFiles.pluginId, pluginId))).toEqual([]);
    const { previewWaiting } = await addOnRunner(fx, pluginId);
    expect(previewWaiting).toEqual([{ definition: "tool:notes", reason: { key: "plugins.setup.waiting.noFiles" } }]);
    await expect(call(router.plugins.addServer, { pluginId, server: "notes", runnerId: fx.runnerId, digest: `sha256:${"0".repeat(64)}` }, { context: fx.ctx })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "notes can't run as a runner tool: Dispand keeps no files of this plugin for runners. Update the plugin if it follows the Agent Plugins standard.",
    });
    fx.plugin.commit({ "server.mjs": `${SERVER}// one more line\n` });
    await updatePlugin(fx.ctx, pluginId);
    const [after] = await fx.ctx.db.select().from(pluginsTable).where(eq(pluginsTable.id, pluginId));
    expect(after!.sha).not.toBe(row!.sha);
    expect(after!.digest).toBeNull();
  } finally {
    fx.remove();
  }
});
