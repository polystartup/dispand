// A plugin's server (code from Dispand) runs in a worker of its own: its files read-only, its
// data folder writable, nothing of the supervisor's. Real gVisor in CI (DISPAND_SANDBOX_RUNTIME).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { callTool, discoverTool } from "../../src/mcp.ts";
import { serveInWorker } from "../../src/sandbox/plugins.ts";
import { Sandbox } from "../../src/sandbox/worker.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";

/** A plugin's stdio MCP server with no dependency: one tool, `where`, telling what it can reach. */
const SERVER = `
const { existsSync, writeFileSync } = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const can = (path) => { try { writeFileSync(path, "x"); return "yes"; } catch { return "no"; } };
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "where", version: "1" } } });
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "where", description: "Where it runs", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } });
  if (msg.method === "tools/call") {
    const report = { echoed: process.env.PLUGIN_TOKEN, uid: process.getuid(), files: can(process.env.PLUGIN_ROOT + "/w"), data: can(process.env.PLUGIN_DATA + "/w"), config: existsSync(process.env.CONFIG_PATH) ? "seen" : "hidden", socket: existsSync("/var/run/docker.sock") ? "seen" : "hidden" };
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(report) }] } });
  }
  send({ jsonrpc: "2.0", id: msg.id, result: {} });
});`;

describe.skipIf(!RUNTIME)(`a plugin's server on ${RUNTIME}`, () => {
  let state: SandboxState;
  beforeAll(async () => {
    state = await sandboxState();
  });
  afterAll(() => state.done());

  test("runs in a worker: its files read-only, its data writable, nothing of the supervisor's", async () => {
    const root = join(state.base, "plugins", "where");
    const data = join(state.base, "plugin-data", "where");
    await mkdir(root, { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(join(root, "server.js"), SERVER);
    // The runner's own config, which no plugin may see.
    const config = join(state.base, "config.json");
    await writeFile(config, "{\"token\":\"secret\"}");
    const sandbox = new Sandbox({ owner: `test-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: "none" });
    await sandbox.sweep();
    const launch = { command: "node", args: [join(root, "server.js")], env: { PLUGIN_ROOT: root, PLUGIN_DATA: data, CONFIG_PATH: config, PLUGIN_TOKEN: "plugin-token-0123456789" }, cwd: root };
    // As a poll does: listed, then called, each in a worker of its own.
    const listing = await serveInWorker(sandbox, launch, join(state.base, "root"));
    try {
      expect((await discoverTool("where", listing.launch)).map((a) => a.name)).toEqual(["where"]);
    } finally {
      await listing.remove();
    }
    const calling = await serveInWorker(sandbox, launch, join(state.base, "root"));
    try {
      const { content } = await callTool("where", calling.launch, "where", {}, { forbidden: [], secrets: [] });
      const report = JSON.parse((content[0] as { text: string }).text) as Record<string, unknown>;
      expect(report).toMatchObject({ files: "no", data: "yes", config: "hidden", socket: "hidden" });
      // Its own value reached it, and what it echoes of it is redacted by the supervisor.
      expect(report.echoed).not.toBe("plugin-token-0123456789");
      expect(report.echoed).toBeDefined();
      expect(report.uid).not.toBe(0);
    } finally {
      await calling.remove();
    }
  }, 180_000);
});
