// A granted native plugin's command never pre-approves a tool: its `allowed-tools: Write` is left
// out of the view, so the Write its body asks for in the workspace (which Dispand's own hook leaves
// to the broker) still waits for the owner's answer. Real gVisor and Claude Code in CI.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
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

const files = [
  { path: ".claude-plugin/plugin.json", content: Buffer.from(JSON.stringify({ name: "yes", version: "1.0.0" })) },
  { path: "commands/writer.md", content: Buffer.from("---\ndescription: Writes a file\nallowed-tools: Write\n---\nWRITEFILE\n") },
];
const digest = contentDigest(files);

describe.skipIf(!RUNTIME)(`a native plugin's command frontmatter on ${RUNTIME}`, () => {
  const net = `dispand-native-fm-${process.pid}`;
  let state: SandboxState;
  let double: string;
  // Dispand's native-plugins route, as the runner fetches it.
  const dispand = createServer((req, res) => {
    if (!req.url?.startsWith(`/runner/native-plugins/plugin_w?digest=${encodeURIComponent(digest)}`)) return res.writeHead(404).end();
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

  test("a command whose allowed-tools names Write doesn't skip the owner's question", async () => {
    const events: [string, HarnessEvent][] = [];
    const sandbox = new Sandbox({ owner: `test-fm-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net, extraEnv: { ANTHROPIC_BASE_URL: double, ANTHROPIC_API_KEY: "sk-double" } });
    await sandbox.sweep();
    const root = join(state.base, "root");
    const sessions = new Sessions(
      { server: "https://dispand.test", roots: [root], allowBypass: false },
      (sessionId, event) => events.push([sessionId, event]),
      {
        sandbox, claude: { claudePath: "claude", env: process.env }, claudeVersion: "2.1.326", resumeMap: join(state.base, "sessions.json"),
        skills: { server: `http://127.0.0.1:${(dispand.address() as AddressInfo).port}`, token: "runner-token", stateDir: state.stateDir },
      },
    );
    await sessions.handle({ type: "session.start", start: {
      sessionId: "fm", harness: "claude-code", cwd: { mode: "per-run", runKey: "fm" }, systemPrompt: "", prompt: "/yes:writer",
      expectedOutputs: [], interactive: true, permissionMode: "default", skills: [], mcpServers: [], nativePlugins: [{ pluginId: "plugin_w", digest, managedServers: [] }],
    } });
    try {
      await vi.waitFor(() => { expect(events.find(([, e]) => e.type === "error"), JSON.stringify(events)).toBeUndefined(); expect(events.some(([, e]) => e.type === "question")).toBe(true); }, { timeout: 180_000, interval: 500 });
      // Asked, not run: the command's allowed-tools never reached the CLI.
      await expect(stat(join(root, "runs", "fm", "written.txt"))).rejects.toThrow();
    } finally {
      // Ended only once its worker is gone: nothing of it stays on the network.
      await sessions.handle({ type: "session.stop", sessionId: "fm" });
      await vi.waitFor(() => expect(events.some(([, e]) => e.type === "session-ended")).toBe(true), { timeout: 60_000 });
    }
  }, 300_000);
});
