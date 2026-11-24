// A session's tool reaches the CLI in a worker only over the CLI's own channel, after the
// permission broker: nothing in the worker holds its secret or reaches its server. Real gVisor
// in CI (DISPAND_SANDBOX_RUNTIME=runsc), with the model doubles (`model-double.mjs`).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { HarnessEvent, SessionStart } from "@dispand/runner-protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Sandbox } from "../../src/sandbox/worker.ts";
import { Sessions } from "../../src/sessions.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);
const SECRET = "tool-secret-0123456789";

/** A tool server by URL on the supervisor's loopback: one tool, `note`, counting its calls and their bearer. */
function notesServer() {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      const msg = JSON.parse(raw) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (msg.id === undefined) return void res.writeHead(202).end();
      const reply = (result: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      if (msg.method === "initialize") return reply({ protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1.0.0" } });
      if (msg.method === "tools/list") return reply({ tools: [{ name: "note", description: "Take a note", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
      if (msg.method === "tools/call") {
        calls.push(String(req.headers.authorization));
        return reply({ content: [{ type: "text", text: "noted" }] });
      }
      reply({});
    });
  });
  return { server, calls };
}

describe.skipIf(!RUNTIME)(`a session's tools on ${RUNTIME}`, () => {
  const net = `dispand-tools-${process.pid}`;
  let state: SandboxState;
  let double: string;
  let notes: ReturnType<typeof notesServer>;
  let port: number;

  beforeAll(async () => {
    state = await sandboxState();
    await docker("network", "create", "--internal", net);
    await docker("run", "-d", "--name", net, "--network", net, "--read-only", "-v", `${resolve("test/sandbox/model-double.mjs")}:/double.mjs:ro`, IMAGE, "node", "/double.mjs");
    double = `http://${(await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, net)).stdout.trim()}:8080`;
    notes = notesServer();
    await new Promise<void>((r) => (notes.server as Server).listen(0, "127.0.0.1", r));
    port = (notes.server.address() as { port: number }).port;
  }, 120_000);
  afterAll(async () => {
    notes?.server.close();
    await docker("rm", "-f", net).catch(() => undefined);
    await docker("network", "rm", net).catch(() => undefined);
    await state.done();
  });

  test.each(["claude-code", "codex"] as const)("%s: a tool subprocess can't reach the tool, and the CLI calls it only after the broker", async (harness) => {
    const root = join(state.base, harness, "root");
    const key = `${harness}-tools`;
    const events: [string, HarnessEvent][] = [];
    const sandbox = new Sandbox({ owner: `test-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net, extraEnv: { ANTHROPIC_BASE_URL: double, ANTHROPIC_API_KEY: "sk-double" }, openaiBaseUrl: double });
    await sandbox.sweep();
    const sessions = new Sessions(
      // The tool server stands for Dispand's own (a Job's tools): the one origin on the supervisor's loopback it may reach.
      { server: `http://127.0.0.1:${port}`, roots: [root], allowBypass: false },
      (sessionId, event) => events.push([sessionId, event]),
      { sandbox, claude: { claudePath: "claude", env: process.env }, codex: { codexPath: "codex", env: process.env, version: "0.169.0" }, claudeVersion: "2.1.326", resumeMap: join(state.base, harness, "sessions.json") },
    );
    const start: SessionStart = {
      sessionId: key, harness, cwd: { mode: "per-run", runKey: key }, systemPrompt: "", prompt: `TOOL ${port}`,
      ...(harness === "codex" ? { model: "gpt-double" } : {}),
      expectedOutputs: [], interactive: true, permissionMode: "default", skills: [],
      mcpServers: [{ name: "notes", type: "http", url: `http://127.0.0.1:${port}/mcp`, transport: "streamable-http", headers: { authorization: `Bearer ${SECRET}` } }],
    };
    await sessions.handle({ type: "session.start", start });
    const questions = () => events.filter(([, e]) => e.type === "question").map(([, e]) => e as Extract<HarnessEvent, { type: "question" }>);
    const answer = (q: Extract<HarnessEvent, { type: "question" }>) => sessions.handle({ type: "session.answer", sessionId: key, questionId: q.questionId, answer: { kind: "permission", decision: "allow" } });
    const failure = () => events.find(([, e]) => e.type === "error");
    // The shell probe asks first.
    await vi.waitFor(() => { expect(failure(), JSON.stringify(events)).toBeUndefined(); expect(questions()).toHaveLength(1); }, { timeout: 120_000, interval: 500 });
    await answer(questions()[0]!);
    // Then the tool: asked about, not called before the answer.
    await vi.waitFor(() => { expect(failure(), JSON.stringify(events)).toBeUndefined(); expect(questions()).toHaveLength(2); }, { timeout: 120_000, interval: 500 });
    expect(questions()[1]!.payload).toMatchObject({ kind: "permission", toolName: "mcp__notes__note" });
    expect(notes.calls).toEqual([]);
    await answer(questions()[1]!);
    await vi.waitFor(() => expect(events.filter(([, e]) => e.type === "turn-end").length).toBeGreaterThan(0), { timeout: 120_000, interval: 500 });
    // Called once, by the supervisor with the tool's own bearer; the worker held neither, nor reached the server.
    expect(notes.calls).toEqual([`Bearer ${SECRET}`]);
    expect((await readFile(join(root, "runs", key, "probe.txt"), "utf8")).trim().split("\n")).toEqual(["0", "closed"]);
    await sessions.handle({ type: "session.stop", sessionId: key });
    await vi.waitFor(() => expect(events.some(([, e]) => e.type === "session-ended")).toBe(true), { timeout: 60_000 });
    notes.calls.length = 0;
  }, 300_000);
});
