// The check at use: whatever form a plugin declares it in, a server Dispand manages that a CLI
// actually loaded from a native plugin stops the session before its first turn. Here the view
// keeps the managed server (as if the filter missed it) and each CLI reports it loaded.
// Real gVisor, Claude Code and Codex in CI (DISPAND_SANDBOX_RUNTIME).
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { HarnessEvent } from "@dispand/runner-protocol";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { startClaudeSession } from "../../src/claude.ts";
import { startCodexSession } from "../../src/codex/session.ts";
import { CODEX_MARKETPLACE, codexMarketplace, nativePluginFolders, nativePluginViews, sweepNativePlugins } from "../../src/sandbox/native-plugins.ts";
import { NATIVE_PLUGINS, Sandbox } from "../../src/sandbox/worker.ts";
import { unlock } from "../../src/skills.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);

const files = [
  { path: ".claude-plugin/plugin.json", content: Buffer.from(JSON.stringify({ name: "demo", version: "1.0.0" })) },
  { path: ".mcp.json", content: Buffer.from(JSON.stringify({ mcpServers: { notes: { command: "node", args: ["-e", "setInterval(() => {}, 1000)"] } } })) },
];
const digest = contentDigest(files);

describe.skipIf(!RUNTIME)(`a managed server loaded from a native plugin on ${RUNTIME}`, () => {
  const net = `dispand-native-managed-${process.pid}`;
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
    for (const harness of ["claude-code", "codex"]) await unlock(join(state.base, harness, "views"));
    await sweepNativePlugins(join(state.base, "store"));
    await state.done();
  });

  test.each(["claude-code", "codex"] as const)("%s: the session stops before its first turn, no tool called", async (harness) => {
    const stored = await nativePluginFolders(join(state.base, "store"), [{ pluginId: "plugin_a", digest }], async () => files);
    const workspace = join(state.base, harness, "work");
    await mkdir(workspace, { recursive: true });
    // No managed server named to the filter: the view keeps `notes`, as a form the filter missed would.
    const views = await nativePluginViews(join(state.base, harness, "views"), stored, [{ pluginId: "plugin_a", digest, managedServers: [] }], harness === "codex" ? { cwd: workspace } : undefined);
    const market = harness === "codex" ? await codexMarketplace(join(state.base, harness, "views"), views) : undefined;
    const sandbox = new Sandbox({ owner: `test-native-managed-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net, extraEnv: { ANTHROPIC_BASE_URL: double, ANTHROPIC_API_KEY: "sk-double" }, openaiBaseUrl: double });
    await sandbox.sweep();
    const worker = await sandbox.worker(workspace, join(state.base, harness, "cli"), [], { plugins: views, ...(market ? { marketplace: market.dir } : {}) });
    const events: HarnessEvent[] = [];
    const start = { sessionId: `managed-${harness}`, systemPrompt: "", prompt: "TOOL", expectedOutputs: [], interactive: false, permissionMode: "default" as const, skills: [], mcpServers: [] };
    const nativeManaged = views.map((v, i) => ({ names: [...v.names, ...(market ? [market.names[i]!] : [])], managed: ["notes"] }));
    const session = harness === "codex"
      ? startCodexSession({ ...start, harness, model: "gpt-double" } as never, workspace, (e) => events.push(e), { codexPath: "codex", env: { ...process.env, CODEX_HOME: worker.codexHome }, launch: worker.launch, modelBaseUrl: worker.openaiBaseUrl!, secrets: [], nativePlugins: { marketplacePath: CODEX_MARKETPLACE, names: market!.names }, nativeManaged })
      : startClaudeSession({ ...start, harness } as never, workspace, (e) => events.push(e), { claudePath: "claude", env: { ...process.env, CLAUDE_CONFIG_DIR: worker.claudeConfigDir }, launch: worker.launch, secrets: [], nativePlugins: views.map((v) => `${NATIVE_PLUGINS}/${v.pluginId}`), nativeManaged });
    try {
      await vi.waitFor(() => expect(events.find((e) => e.type === "error"), JSON.stringify(events)).toMatchObject({ message: expect.stringContaining("notes") }), { timeout: 180_000, interval: 500 });
      expect(events.some((e) => e.type === "tool")).toBe(false);
    } finally {
      session.stop("test finished");
      await session.done;
      await worker.remove();
    }
  }, 300_000);
});
