// A granted native plugin's own MCP tool asks the owner first, on both CLIs, whatever the plugin
// says of it: its tool labelled read-only (which Codex otherwise runs unasked) and its server's
// declaration asking Codex to approve every tool. Through the runner's sessions, with real gVisor,
// Claude Code and Codex in CI, and the model double.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { HarnessEvent } from "@dispand/runner-protocol";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Sandbox } from "../../src/sandbox/worker.ts";
import { Sessions } from "../../src/sessions.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);

/** A stdio MCP server with one tool, `echo`, labelled read-only. */
const ECHO = `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "kept", version: "1" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } });
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ECHOED" }] } });
  send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;
const files = [
  { path: ".claude-plugin/plugin.json", content: Buffer.from(JSON.stringify({ name: "demo", version: "1.0.0" })) },
  // Its own settings would have Codex approve every tool of it unasked.
  { path: ".mcp.json", content: Buffer.from(JSON.stringify({ mcpServers: { kept: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"], default_tools_approval_mode: "approve", tools: { echo: { approval_mode: "approve" } } } } })) },
  { path: "server.mjs", content: Buffer.from(ECHO) },
];
const digest = contentDigest(files);

describe.skipIf(!RUNTIME)(`a native plugin's read-only-labelled tool on ${RUNTIME}`, () => {
  const net = `dispand-native-readonly-${process.pid}`;
  let state: SandboxState;
  let double: string;
  // Dispand's native-plugins route, as the runner fetches it.
  const dispand = createServer((req, res) => {
    if (!req.url?.startsWith(`/runner/native-plugins/plugin_r?digest=${encodeURIComponent(digest)}`)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ files: files.map((f) => ({ path: f.path, base64: f.content.toString("base64") })) }));
  });
  beforeAll(async () => {
    state = await sandboxState();
    await new Promise<void>((done) => dispand.listen(0, "127.0.0.1", done));
    await docker("network", "create", "--internal", net);
    await docker("run", "-d", "--name", net, "--network", net, "--read-only", "-v", `${resolve("test/sandbox/model-double.mjs")}:/double.mjs:ro`, IMAGE, "node", "/double.mjs");
    double = `http://${(await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, net)).stdout.trim()}:8080`;
  }, 120_000);
  afterAll(async () => {
    dispand.close();
    await docker("rm", "-f", net).catch(() => undefined);
    await docker("network", "rm", net).catch(() => undefined);
    await state.done();
  });

  test.each(["claude-code", "codex"] as const)("%s: the owner is asked before the plugin's tool runs", async (harness) => {
    const events: [string, HarnessEvent][] = [];
    const sandbox = new Sandbox({ owner: `test-readonly-${harness}-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net, extraEnv: { ANTHROPIC_BASE_URL: double, ANTHROPIC_API_KEY: "sk-double" }, openaiBaseUrl: double });
    await sandbox.sweep();
    const root = join(state.base, harness, "root");
    const sessions = new Sessions(
      { server: "https://dispand.test", roots: [root], allowBypass: false },
      (sessionId, event) => events.push([sessionId, event]),
      {
        sandbox, claude: { claudePath: "claude", env: process.env }, codex: { codexPath: "codex", env: process.env, version: "0.169.0" }, claudeVersion: "2.1.326", resumeMap: join(state.base, harness, "sessions.json"),
        skills: { server: `http://127.0.0.1:${(dispand.address() as AddressInfo).port}`, token: "runner-token", stateDir: state.stateDir },
      },
    );
    await sessions.handle({ type: "session.start", start: {
      sessionId: harness, harness, cwd: { mode: "per-run", runKey: `readonly-${harness}` }, systemPrompt: "", prompt: "PLUGINTOOL",
      expectedOutputs: [], interactive: true, permissionMode: "default", skills: [], mcpServers: [], nativePlugins: [{ pluginId: "plugin_r", digest, managedServers: [] }],
      ...(harness === "codex" ? { model: "gpt-double" } : {}),
    } });
    try {
      // The plugin's tool, asked about: nothing of it ran before the owner's answer.
      await vi.waitFor(() => {
        expect(events.find(([, e]) => e.type === "error"), JSON.stringify(events)).toBeUndefined();
        expect(events.find(([, e]) => e.type === "turn-end"), `ended unasked: ${JSON.stringify(events)}`).toBeUndefined();
        const question = events.find(([, e]) => e.type === "question")?.[1] as { questionId: string; payload: { kind: string; toolName?: string } } | undefined;
        expect(question?.payload).toMatchObject({ kind: "permission", toolName: expect.stringMatching(/echo/) });
      }, { timeout: 180_000, interval: 500 });
      const q = events.find(([, e]) => e.type === "question")![1] as { questionId: string };
      await sessions.handle({ type: "session.answer", sessionId: harness, questionId: q.questionId, answer: { kind: "permission", decision: "allow" } });
      await vi.waitFor(() => expect(events.some(([, e]) => e.type === "turn-end")).toBe(true), { timeout: 120_000, interval: 500 });
    } finally {
      await sessions.handle({ type: "session.stop", sessionId: harness });
      await vi.waitFor(() => expect(events.some(([, e]) => e.type === "session-ended")).toBe(true), { timeout: 60_000 });
    }
  }, 300_000);
});
