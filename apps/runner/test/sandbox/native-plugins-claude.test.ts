// Claude Code in a worker loads a conversation's granted native plugin from its read-only mount:
// its command is offered, and a server Dispand manages, though the plugin declares it, never
// starts natively. Real gVisor and Claude Code in CI, with the model double.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { nativePluginFolders, nativePluginViews, sweepNativePlugins } from "../../src/sandbox/native-plugins.ts";
import { NATIVE_PLUGINS, Sandbox, spawnIn } from "../../src/sandbox/worker.ts";
import { unlock } from "../../src/skills.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);

/** A stdio server that does nothing but exist: listed by Claude Code when it starts it. */
const server = { command: "node", args: ["-e", "setInterval(() => {}, 1000)"] };
const files = [
  { path: ".claude-plugin/plugin.json", content: Buffer.from(JSON.stringify({ name: "demo", version: "1.0.0", mcpServers: { notes: server, kept: server } })) },
  { path: "commands/hello.md", content: Buffer.from("---\ndescription: Say hello\n---\nSay hello.\n") },
];

describe.skipIf(!RUNTIME)(`native plugins in Claude Code on ${RUNTIME}`, () => {
  const net = `dispand-native-${process.pid}`;
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

  test("its command is offered, and only the servers Dispand doesn't manage start from it", async () => {
    const digest = contentDigest(files);
    const stored = await nativePluginFolders(join(state.base, "store"), [{ pluginId: "plugin_a", digest }], async () => files);
    const views = await nativePluginViews(join(state.base, "views"), stored, [{ pluginId: "plugin_a", digest, managedServers: ["notes"] }]);
    const sandbox = new Sandbox({
      owner: `test-native-claude-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net,
      extraEnv: { ANTHROPIC_BASE_URL: double, ANTHROPIC_API_KEY: "sk-double" },
    });
    await sandbox.sweep();
    const workspace = join(state.base, "runs", "native");
    await mkdir(workspace, { recursive: true });
    const worker = await sandbox.worker(workspace, join(state.base, "cli", "native"), [], { plugins: views });
    let init: { slash_commands?: string[]; mcp_servers?: { name: string }[]; plugins?: { name: string }[] } | undefined;
    try {
      const q = query({
        prompt: "Hello",
        options: {
          cwd: workspace, pathToClaudeCodeExecutable: "claude", persistSession: false, settingSources: [], env: process.env,
          plugins: [{ type: "local", path: `${NATIVE_PLUGINS}/plugin_a` }],
          ...spawnIn(worker.launch, workspace),
        },
      });
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") init = msg as typeof init;
        if (msg.type === "result") break;
      }
    } finally {
      await worker.remove();
    }
    expect(init?.plugins?.map((p) => p.name)).toContain("demo");
    expect(init?.slash_commands).toContain("demo:hello");
    const servers = (init?.mcp_servers ?? []).map((s) => s.name);
    expect(servers.some((name) => name.includes("kept")), JSON.stringify(servers)).toBe(true);
    expect(servers.some((name) => name.includes("notes")), JSON.stringify(servers)).toBe(false);
  }, 300_000);
});
