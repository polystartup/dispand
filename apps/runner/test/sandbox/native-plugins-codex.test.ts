// Codex in a worker installs a conversation's granted native plugin from its read-only mount: its
// skill is listed, its hook runs at the turn as a managed hook of the conversation's read-only
// requirements (a hook and its trust planted in Codex's writable home run nowhere), its own server (declared with
// `${CLAUDE_PLUGIN_ROOT}`) starts and offers its tool, and a server Dispand manages, though the plugin
// declares it, isn't configured natively. Real gVisor and Codex in CI, with the model double.
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { codexConfig } from "../../src/codex/config.ts";
import { installNativePlugins } from "../../src/codex/native-plugins.ts";
import { CodexRpc } from "../../src/codex/rpc.ts";
import { CODEX_MARKETPLACE, codexMarketplace, nativePluginFolders, nativePluginViews, sweepNativePlugins, codexRequirementsFile } from "../../src/sandbox/native-plugins.ts";
import { NATIVE_PLUGINS, Sandbox } from "../../src/sandbox/worker.ts";
import { unlock } from "../../src/skills.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);

const server = { command: "node", args: ["-e", "setInterval(() => {}, 1000)"] };
/** A stdio MCP server with one tool, `echo`, run from the plugin's own files. */
const ECHO = `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "kept", version: "1" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object", properties: {} } }] } });
  send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;
const files = [
  { path: ".claude-plugin/plugin.json", content: Buffer.from(JSON.stringify({ name: "demo", version: "1.0.0" })) },
  // `${CLAUDE_PLUGIN_ROOT}`, which Claude Code expands and Codex doesn't: Codex's copy has it expanded.
  { path: ".mcp.json", content: Buffer.from(JSON.stringify({ mcpServers: { notes: server, kept: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"] } } })) },
  { path: "server.mjs", content: Buffer.from(ECHO) },
  { path: "skills/greet/SKILL.md", content: Buffer.from("---\nname: greet\ndescription: Greets\n---\nGreet.\n") },
  // Its hook runs a bundled script through `PLUGIN_ROOT`, which Codex gives a plugin's hook: the read-only mount.
  { path: "hooks/hooks.json", content: Buffer.from(JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: 'sh "$PLUGIN_ROOT/hook.sh"' }] }] } })) },
  { path: "hook.sh", content: Buffer.from("touch hooked\n") },
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

  test("its skill is listed, its hook runs managed (a hook planted in Codex's home doesn't), and a managed server isn't configured from it", async () => {
    const digest = contentDigest(files);
    const stored = await nativePluginFolders(join(state.base, "store"), [{ pluginId: "plugin_a", digest }], async () => files);
    const workspace = join(state.base, "runs", "native-codex");
    const views = await nativePluginViews(join(state.base, "views"), stored, [{ pluginId: "plugin_a", digest, managedServers: ["notes"] }], { cwd: workspace });
    const market = await codexMarketplace(join(state.base, "views"), views);
    const requirements = await codexRequirementsFile(join(state.base, "views"));
    const owner = `test-native-codex-${process.pid}`;
    const sandbox = new Sandbox({ owner, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net, openaiBaseUrl: double });
    await sandbox.sweep();
    await mkdir(workspace, { recursive: true });
    const worker = await sandbox.worker(workspace, join(state.base, "cli", "native-codex"), [], { plugins: views, marketplace: market.dir, requirements: requirements.dir });
    const rpc = await CodexRpc.spawn("codex", { ...process.env, CODEX_HOME: worker.codexHome }, workspace, undefined, worker.launch);
    try {
      await installNativePlugins(rpc, CODEX_MARKETPLACE, market.names, { file: requirements.file, cwd: workspace, codexHome: worker.codexHome, roots: Object.fromEntries(market.names.map((name, i) => [name, `${NATIVE_PLUGINS}/${views[i]!.pluginId}`])) });
      const listed = async () => (await rpc.request("hooks/list", { cwds: [workspace] })).data.flatMap((e) => e.hooks).map((h) => ({ source: h.source, trust: h.trustStatus, command: h.handlerType === "command" ? h.command : null }));
      // The plugin's hook as a managed one of the read-only requirements, and no other.
      expect(await listed()).toEqual([{ source: "system", trust: "managed", command: expect.stringMatching(/^export PLUGIN_ROOT='\/run\/plugins\/plugin_a' .*; sh "\$PLUGIN_ROOT\/hook\.sh"$/) }]);
      const skills = (await rpc.request("skills/list", { cwds: [workspace], forceReload: true })).data.flatMap((e) => e.skills).map((s) => s.name);
      expect(skills).toContain("demo:greet");
      const config = codexConfig({ denied: [], bypass: false, modelBaseUrl: worker.openaiBaseUrl! });
      // The installed plugin's own servers: the one Dispand doesn't manage, not the managed one.
      const read = (await rpc.request("plugin/read", { pluginName: "demo", marketplacePath: CODEX_MARKETPLACE })) as { plugin: { mcpServers: string[] } };
      expect(read.plugin.mcpServers).toContain("kept");
      expect(read.plugin.mcpServers).not.toContain("notes");
      const { thread } = await rpc.request("thread/start", { cwd: workspace, model: "gpt-double", approvalPolicy: "untrusted", config });
      // Its own server started from the plugin's mount, its tool offered.
      await vi.waitFor(async () => {
        const status = ((await rpc.request("mcpServerStatus/list", { threadId: thread.id, serverName: "kept" })) as { data: { tools?: Record<string, unknown>; toolsError?: string | null }[] }).data[0];
        expect(Object.keys(status?.tools ?? {}), JSON.stringify(status?.toolsError ?? null)).toContain("echo");
      }, { timeout: 60_000, interval: 1000 });
      let done = false;
      rpc.onNotification((n) => { if (n.method === "turn/completed") done = true; });
      await rpc.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "REMEMBER alpha", text_elements: [] }] });
      await vi.waitFor(() => expect(done).toBe(true), { timeout: 120_000, interval: 500 });
      // The plugin's hook ran at the prompt, in the session's folder.
      await stat(join(workspace, "hooked"));
      // A process in the worker plants a hook and its trust in Codex's writable home: it isn't
      // listed, and doesn't run at a turn, not even of a thread started after it was written.
      const [container] = (await docker("ps", "-q", "--filter", `label=dispand.runner.supervisor=${owner}`)).stdout.trim().split("\n");
      const plant = '[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "touch planted"\n\n[hooks.state."user:planted"]\ntrusted_hash = "planted"\n';
      await docker("exec", container!, "sh", "-c", `printf '%s' '${plant}' >> "$CODEX_HOME/config.toml"`);
      expect(await listed()).toEqual([{ source: "system", trust: "managed", command: expect.stringMatching(/^export PLUGIN_ROOT='\/run\/plugins\/plugin_a' .*; sh "\$PLUGIN_ROOT\/hook\.sh"$/) }]);
      const { thread: next } = await rpc.request("thread/start", { cwd: workspace, model: "gpt-double", approvalPolicy: "untrusted", config });
      done = false;
      await rpc.request("turn/start", { threadId: next.id, input: [{ type: "text", text: "REMEMBER beta", text_elements: [] }] });
      await vi.waitFor(() => expect(done).toBe(true), { timeout: 120_000, interval: 500 });
      await expect(stat(join(workspace, "planted"))).rejects.toThrow();
    } finally {
      await rpc.close();
      await worker.remove();
    }
  }, 300_000);
});
