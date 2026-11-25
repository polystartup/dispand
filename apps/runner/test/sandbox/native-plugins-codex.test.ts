// Codex in a worker installs a conversation's granted native plugin from its read-only mount: its
// skill is listed, its hook is trusted and runs at the turn, and a server Dispand manages, though
// the plugin declares it, isn't configured natively. Real gVisor and Codex in CI, with the model double.
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { codexConfig } from "../../src/codex/config.ts";
import { installNativePlugins } from "../../src/codex/native-plugins.ts";
import { CodexRpc } from "../../src/codex/rpc.ts";
import { CODEX_MARKETPLACE, codexMarketplace, nativePluginFolders, nativePluginViews, sweepNativePlugins } from "../../src/sandbox/native-plugins.ts";
import { Sandbox } from "../../src/sandbox/worker.ts";
import { unlock } from "../../src/skills.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);

const server = { command: "node", args: ["-e", "setInterval(() => {}, 1000)"] };
const files = [
  { path: ".claude-plugin/plugin.json", content: Buffer.from(JSON.stringify({ name: "demo", version: "1.0.0" })) },
  { path: ".mcp.json", content: Buffer.from(JSON.stringify({ mcpServers: { notes: server, kept: server } })) },
  { path: "skills/greet/SKILL.md", content: Buffer.from("---\nname: greet\ndescription: Greets\n---\nGreet.\n") },
  { path: "hooks/hooks.json", content: Buffer.from(JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "touch hooked" }] }] } })) },
];

describe.skipIf(!RUNTIME)(`native plugins in Codex on ${RUNTIME}`, () => {
  const net = `dispand-native-codex-${process.pid}`;
  let state: SandboxState;
  let double: string;
  beforeAll(async () => {
    state = await sandboxState();
    await docker("network", "create", "--internal", net);
    await docker("run", "-d", "--name", net, "--network", net, "--read-only", "-v", `${resolve("test/sandbox/model-double.mjs")}:/double.mjs:ro`, IMAGE, "node", "/double.mjs");
    double = `http://${(await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, net)).stdout.trim()}:8080`;
  }, 120_000);
  afterAll(async () => {
    await docker("rm", "-f", net).catch(() => undefined);
    await docker("network", "rm", net).catch(() => undefined);
    await unlock(join(state.base, "views"));
    await sweepNativePlugins(join(state.base, "store"));
    await state.done();
  });

  test("its skill is listed, its hook runs trusted, and a managed server isn't configured from it", async () => {
    const digest = contentDigest(files);
    const stored = await nativePluginFolders(join(state.base, "store"), [{ pluginId: "plugin_a", digest }], async () => files);
    const views = await nativePluginViews(join(state.base, "views"), stored, [{ pluginId: "plugin_a", digest, managedServers: ["notes"] }]);
    const market = await codexMarketplace(join(state.base, "views"), views);
    const sandbox = new Sandbox({ owner: `test-native-codex-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net, openaiBaseUrl: double });
    await sandbox.sweep();
    const workspace = join(state.base, "runs", "native-codex");
    await mkdir(workspace, { recursive: true });
    const worker = await sandbox.worker(workspace, join(state.base, "cli", "native-codex"), [], { plugins: views, marketplace: market.dir });
    const rpc = await CodexRpc.spawn("codex", { ...process.env, CODEX_HOME: worker.codexHome }, workspace, undefined, worker.launch);
    try {
      await installNativePlugins(rpc, CODEX_MARKETPLACE, market.names, workspace);
      const hooks = (await rpc.request("hooks/list", { cwds: [workspace] })).data.flatMap((e) => e.hooks).filter((h) => h.source === "plugin");
      expect(hooks.map((h) => h.trustStatus)).toEqual(["trusted"]);
      const skills = (await rpc.request("skills/list", { cwds: [workspace], forceReload: true })).data.flatMap((e) => e.skills).map((s) => s.name);
      expect(skills).toContain("demo:greet");
      const config = codexConfig({ denied: [], bypass: false, modelBaseUrl: worker.openaiBaseUrl! });
      // The installed plugin's own servers: the one Dispand doesn't manage, not the managed one.
      const read = (await rpc.request("plugin/read", { pluginName: "demo", marketplacePath: CODEX_MARKETPLACE })) as { plugin: { mcpServers: string[] } };
      expect(read.plugin.mcpServers).toContain("kept");
      expect(read.plugin.mcpServers).not.toContain("notes");
      const { thread } = await rpc.request("thread/start", { cwd: workspace, model: "gpt-double", approvalPolicy: "untrusted", config });
      let done = false;
      rpc.onNotification((n) => { if (n.method === "turn/completed") done = true; });
      await rpc.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "REMEMBER alpha", text_elements: [] }] });
      await vi.waitFor(() => expect(done).toBe(true), { timeout: 120_000, interval: 500 });
      // The plugin's hook ran at the prompt, in the session's folder.
      await stat(join(workspace, "hooked"));
    } finally {
      await rpc.close();
      await worker.remove();
    }
  }, 300_000);
});
