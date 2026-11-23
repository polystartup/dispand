import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRunnerMessage, type ServerToRunner } from "@dispand/runner-protocol";
import { expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { SANDBOX_PENDING } from "./image-gate.ts";

const dockerfile = (path: string) => readFile(path, "utf8");
const CLIS = /^COPY apps\/runner\/clis\/package\.json apps\/runner\/clis\/package-lock\.json \/opt\/dispand-clis\/$/m;

test("images › the worker runs as a non-root user and both images pin the same CLI versions", async () => {
  const worker = await dockerfile("worker/Dockerfile");
  const users = [...worker.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]!);
  expect(users.at(-1)).toMatch(/^[1-9]\d*:[1-9]\d*$/);
  // Nothing of the runner: the CLIs' lockfile is all it copies.
  expect([...worker.matchAll(/^(COPY|ADD)\s.*$/gm)].map((m) => m[0])).toEqual([expect.stringMatching(CLIS)]);
  // Both install the CLIs from that one lockfile, exactly as locked.
  for (const file of [worker, await dockerfile("Dockerfile")]) {
    expect(file).toMatch(CLIS);
    expect(file).toMatch(/cd \/opt\/dispand-clis \\\n && npm ci /);
  }
  const { dependencies } = JSON.parse(await readFile("clis/package.json", "utf8")) as { dependencies: Record<string, string> };
  const lock = JSON.parse(await readFile("clis/package-lock.json", "utf8")) as { packages: Record<string, { version: string }> };
  for (const [name, version] of Object.entries(dependencies)) {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
  }
});

test("› every server-triggered launch is refused by the image until the sandbox exists", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "image-")));
  const bin = join(base, "bin");
  const launched = join(base, "launched");
  await mkdir(bin);
  await mkdir(join(base, "home"));
  // Each records how it was started: only `claude --version` (read at start) may run.
  await writeFile(join(bin, "claude"), `#!/bin/sh\necho "claude $*" >> "${launched}"\necho '2.1.326 (Claude Code)'\n`);
  await writeFile(join(bin, "codex"), `#!/bin/sh\necho "codex $*" >> "${launched}"\nexec "${process.execPath}" "${resolve("src/fixtures/fake-codex.ts")}" "$@"\n`);
  await writeFile(join(bin, "echo-mcp"), `#!/bin/sh\necho "echo-mcp" >> "${launched}"\nexit 1\n`);
  await Promise.all(["claude", "codex", "echo-mcp"].map((name) => chmod(join(bin, name), 0o755)));
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const server = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const config = join(base, "config");
  const plugin = { tool: "t1", plugin: "law", digest: `sha256:${"a".repeat(64)}`, entry: { command: "./server" } };
  const launches: ServerToRunner[] = [
    { type: "clis.request", requestId: "q_clis" },
    { type: "commands.request", requestId: "q_commands", harness: "claude-code" },
    { type: "models.request", requestId: "q_models", harness: "codex" },
    { type: "plugin.request", requestId: "q_plugin", operation: { action: "list" } },
    { type: "tool.discover", requestId: "q_discover", tool: "echo" },
    { type: "tool.call", requestId: "q_call", tool: plugin, action: "a", arguments: {} },
  ];
  const received: unknown[] = [];
  wss.on("connection", (ws) => {
    ws.once("message", () => {
      ws.on("message", (data) => received.push(parseRunnerMessage(String(data))));
      for (const msg of launches) ws.send(JSON.stringify(msg));
      const start: ServerToRunner = {
        type: "session.start",
        start: { sessionId: "s1", harness: "claude-code", cwd: { mode: "per-run", runKey: "k" }, systemPrompt: "", prompt: "hi", expectedOutputs: [], interactive: false, permissionMode: "default", skills: [], mcpServers: [] },
      };
      ws.send(JSON.stringify(start));
    });
  });
  const runner = spawn(process.execPath, ["src/main.ts", "run", "--config", config], {
    env: {
      ...process.env,
      HOME: join(base, "home"),
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PATH: `${bin}:${process.env.PATH}`,
      DISPAND_WORKER_IMAGE: `ghcr.io/example/worker@sha256:${"b".repeat(64)}`,
      FAKE_CODEX_ACCOUNT: JSON.stringify({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  runner.stdout.on("data", (d) => (out += d));
  try {
    // Unpaired, it waits; once `pair` has written the config, it connects without a restart.
    await vi.waitFor(() => expect(out).toContain("not paired yet"), { timeout: 15_000 });
    await mkdir(config);
    await writeFile(join(config, "config.json"), JSON.stringify({ server, roots: [join(base, "root")], token: "tok", runnerId: "r", mcpServers: { echo: { command: join(bin, "echo-mcp") } } }));
    await vi.waitFor(() => expect(received).toHaveLength(7), { timeout: 15_000 });
    const error = SANDBOX_PENDING;
    expect(received).toEqual(expect.arrayContaining([
      { type: "clis.replied", requestId: "q_clis", error },
      { type: "commands.replied", requestId: "q_commands", error },
      { type: "models.replied", requestId: "q_models", error },
      { type: "plugin.replied", requestId: "q_plugin", report: { error } },
      { type: "tool.discovered", requestId: "q_discover", error },
      { type: "tool.called", requestId: "q_call", error },
      expect.objectContaining({ type: "event", sessionId: "s1", event: { type: "error", message: error } }),
    ]));
    // Only what the runner reads at start ran: no session, discovery, plugin or tool server.
    const ran = (await readFile(launched, "utf8")).trim().split("\n");
    expect(ran.filter((line) => !["claude --version", "codex --version"].includes(line) && !line.startsWith("codex app-server"))).toEqual([]);
  } finally {
    runner.kill("SIGTERM");
    await new Promise((resolve) => runner.once("exit", resolve));
    wss.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("› the image's wait for pairing ends on SIGTERM", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "image-")));
  const runner = spawn(process.execPath, ["src/main.ts", "run", "--config", join(base, "config")], {
    env: { ...process.env, HOME: base, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", PATH: "/usr/bin:/bin", DISPAND_WORKER_IMAGE: `w@sha256:${"c".repeat(64)}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  runner.stdout.on("data", (d) => (out += d));
  try {
    await vi.waitFor(() => expect(out).toContain("not paired yet"), { timeout: 15_000 });
    runner.kill("SIGTERM");
    expect(await new Promise((resolve) => runner.once("exit", resolve))).toBe(0);
  } finally {
    runner.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  }
});
