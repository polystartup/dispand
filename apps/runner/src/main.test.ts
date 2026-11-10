import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseRunnerMessage } from "@dispand/runner-protocol";
import { expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";

test("pair refuses a plain-http server that isn't loopback, before sending the code", async () => {
  const err = await promisify(execFile)(process.execPath, [
    "src/main.ts", "pair", "--server", "http://dispand.lan", "--root", "/tmp/never-created",
  ], { env: { ...process.env, DISPAND_PAIRING_CODE: "ABCD2345" } }).then(
    () => null,
    (e: { code: number; stderr: string }) => e,
  );
  expect(err?.code).toBe(1);
  expect(err?.stderr).toContain("https");
});

test.each([
  ["a root inside a project's .claude", (base: string) => ["--root", join(base, "project", ".claude")], {}],
  ["a missing CLAUDE_CONFIG_DIR", (base: string) => ["--root", join(base, "root")], { CLAUDE_CONFIG_DIR: "/nonexistent-claude-config" }],
  ["a missing CODEX_HOME", (base: string) => ["--root", join(base, "root")], { CODEX_HOME: "/nonexistent-codex-home" }],
  ["a root inside Codex's home", (base: string) => ["--root", join(base, "home", ".codex", "work")], {}],
])("pair checks everything locally before spending the code: %s", async (_name, rootArgs, env) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pair-")));
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ runnerId: "r", token: "t" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const err = await promisify(execFile)(
      process.execPath,
      ["src/main.ts", "pair", "--config", join(base, "config"), "--server", url, ...rootArgs(base)],
      { env: { ...process.env, HOME: join(base, "home"), DISPAND_PAIRING_CODE: "ABCD2345", ...env } },
    ).then(
      () => null,
      (e: { code: number }) => e,
    );
    expect(err?.code).toBe(1);
    expect(requests).toBe(0);
    await expect(stat(join(base, "config", "config.json"))).rejects.toThrow();
  } finally {
    server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a valid pairing saves the config and token only once the code is accepted", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pair-")));
  let body = "";
  const server = createServer(async (req, res) => {
    for await (const chunk of req) body += chunk;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ runnerId: "r", token: "secret" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A re-pair keeps what the machine's owner set by hand.
    const mcpServers = { echo: { command: "echo-mcp", args: ["--stdio"] } };
    await mkdir(join(base, "config"));
    await writeFile(join(base, "config", "config.json"), JSON.stringify({ server: url, roots: [join(base, "old")], allowBypass: true, mcpServers }));
    await promisify(execFile)(
      process.execPath,
      ["src/main.ts", "pair", "--config", join(base, "config"), "--server", url, "--root", join(base, "root")],
      { env: { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: "", DISPAND_PAIRING_CODE: "ABCD2345" } },
    );
    expect(JSON.parse(body)).toEqual({ code: "ABCD2345" });
    // One file holds both: written at once, mode 0600.
    expect(JSON.parse(await readFile(join(base, "config", "config.json"), "utf8"))).toMatchObject({ server: url, roots: [join(base, "root")], token: "secret", allowBypass: true, mcpServers });
    expect(((await stat(join(base, "config", "config.json"))).mode & 0o777).toString(8)).toBe("600");
    expect(await readdir(join(base, "config"))).toEqual(["config.json"]);
  } finally {
    server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("run says hello with protocol 8, Claude Code's version and Codex's status", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hello-")));
  const bin = join(base, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), "#!/bin/sh\necho '2.1.300 (Claude Code)'\n");
  await writeFile(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${resolve("src/fixtures/fake-codex.ts")}" "$@"\n`);
  await Promise.all(["claude", "codex"].map((name) => chmod(join(bin, name), 0o755)));
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const server = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  await mkdir(join(base, "config"));
  // Listed from the home folder.
  await mkdir(join(base, "home"));
  const mcpServers = { echo: { command: process.execPath, args: [resolve("src/fixtures/echo-mcp.ts")] } };
  await writeFile(join(base, "config", "config.json"), JSON.stringify({ server, roots: [join(base, "root")], token: "tok", runnerId: "r", mcpServers }));
  const received: string[] = [];
  const hello = new Promise<{ protocol: unknown; raw: string }>((resolve) =>
    wss.once("connection", (ws, req) => {
      ws.once("message", (data) => {
        resolve({ protocol: req.headers["dispand-protocol"], raw: String(data) });
        ws.on("message", (more) => received.push(String(more)));
        for (const tool of ["echo", "missing"]) ws.send(JSON.stringify({ type: "tool.discover", requestId: `req_${tool}`, tool }));
      });
    }),
  );
  const runner = spawn(process.execPath, ["src/main.ts", "run", "--config", join(base, "config")], {
    env: {
      ...process.env,
      HOME: join(base, "home"),
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CODEX_ACCOUNT: JSON.stringify({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }),
    },
    stdio: "ignore",
  });
  try {
    const { protocol, raw } = await hello;
    expect(protocol).toBe("8");
    expect(parseRunnerMessage(raw)).toMatchObject({
      type: "hello",
      clis: { claude: "2.1.300", codex: { version: "0.166.0", signedIn: false } },
      tools: ["echo"],
      lastSeq: 0,
    });
    // Only the machine's own servers are listed.
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 15_000 });
    expect(received.map((r) => parseRunnerMessage(r)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { type: "tool.discovered", requestId: "req_echo", actions: [expect.objectContaining({ name: "echo" })] },
      { type: "tool.discovered", requestId: "req_missing", error: "this runner has no MCP server missing in its config" },
    ]);
  } finally {
    runner.kill("SIGTERM");
    await new Promise((resolve) => runner.once("exit", resolve));
    wss.close();
    await rm(base, { recursive: true, force: true });
  }
});
