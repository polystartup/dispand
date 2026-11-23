import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseRunnerMessage, PROTOCOL_VERSION } from "@dispand/runner-protocol";
import { contentDigest } from "@dispand/runner-protocol/digest";
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
    const allowedPlugins = [{ name: "law", digest: `sha256:${"a".repeat(64)}`, entry: { command: "./server" } }];
    await mkdir(join(base, "config"));
    await writeFile(join(base, "config", "config.json"), JSON.stringify({ server: url, roots: [join(base, "old")], allowBypass: true, mcpServers, allowedPlugins }));
    await promisify(execFile)(
      process.execPath,
      ["src/main.ts", "pair", "--config", join(base, "config"), "--server", url, "--root", join(base, "root")],
      { env: { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: "", DISPAND_PAIRING_CODE: "ABCD2345" } },
    );
    expect(JSON.parse(body)).toEqual({ code: "ABCD2345" });
    // One file holds both: written at once, mode 0600.
    expect(JSON.parse(await readFile(join(base, "config", "config.json"), "utf8"))).toMatchObject({ server: url, roots: [join(base, "root")], token: "secret", allowBypass: true, mcpServers, allowedPlugins });
    expect(((await stat(join(base, "config", "config.json"))).mode & 0o777).toString(8)).toBe("600");
    expect(await readdir(join(base, "config"))).toEqual(["config.json"]);
  } finally {
    server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("run reports installed CLIs and launches a Codex installed after startup on refresh", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hello-")));
  const bin = join(base, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), "#!/bin/sh\necho '2.1.300 (Claude Code)'\n");
  await chmod(join(bin, "claude"), 0o755);
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
  const runner = spawn(process.execPath, [resolve("src/main.ts"), "run", "--config", join(base, "config")], {
    cwd: base,
    env: {
      ...process.env,
      HOME: join(base, "home"),
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PATH: "bin",
      FAKE_CODEX_ACCOUNT: JSON.stringify({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }),
    },
    stdio: "ignore",
  });
  try {
    const { protocol, raw } = await hello;
    expect(protocol).toBe(String(PROTOCOL_VERSION));
    expect(parseRunnerMessage(raw)).toMatchObject({
      type: "hello",
      clis: { claude: "2.1.300" },
      tools: ["echo"],
      lastSeq: 0,
    });
    // Only the machine's own servers are listed.
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 15_000 });
    expect(received.map((r) => parseRunnerMessage(r)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { type: "tool.discovered", requestId: "req_echo", actions: [expect.objectContaining({ name: "echo" })] },
      { type: "tool.discovered", requestId: "req_missing", error: "this runner has no MCP server missing in its config" },
    ]);
    await rm(join(bin, "claude"));
    await writeFile(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${resolve("src/fixtures/fake-codex.ts")}" "$@"\n`);
    await chmod(join(bin, "codex"), 0o755);
    const [ws] = wss.clients;
    ws!.send(JSON.stringify({ type: "clis.request", requestId: "req_clis" }));
    await vi.waitFor(() => expect(received).toHaveLength(3), { timeout: 15_000 });
    expect(parseRunnerMessage(received[2]!)).toEqual({
      type: "clis.replied", requestId: "req_clis", clis: { codex: { version: "0.166.0", signedIn: false } },
    });
    ws!.send(JSON.stringify({
      type: "session.start", start: { sessionId: "s1", harness: "codex", cwd: { mode: "per-run", runKey: "r1" },
        systemPrompt: "", prompt: "hello", expectedOutputs: [], interactive: false, permissionMode: "default", skills: [], mcpServers: [] },
    }));
    await vi.waitFor(() => expect(received.map(parseRunnerMessage)).toContainEqual(expect.objectContaining({
      type: "event", sessionId: "s1", event: expect.objectContaining({ type: "cli-session" }),
    })), { timeout: 15_000 });
  } finally {
    runner.kill("SIGTERM");
    await new Promise((resolve) => runner.once("exit", resolve));
    wss.close();
    await rm(base, { recursive: true, force: true });
  }
});


test("native-plugins opts in locally while preserving pairing and machine restrictions", async () => {
  const base = await mkdtemp(join(tmpdir(), "native-opt-in-"));
  try {
    const dir = join(base, "config");
    await mkdir(dir);
    const path = join(dir, "config.json");
    const config = { server: "http://127.0.0.1:9", roots: [join(base, "work")], token: "kept-token", runnerId: "kept-runner", allowBypass: false, mcpServers: { echo: { command: "echo-mcp" } } };
    await writeFile(path, JSON.stringify(config));
    await promisify(execFile)(process.execPath, ["src/main.ts", "native-plugins", "--config", dir]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...config, pluginTargets: "managed" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally { await rm(base, { recursive: true, force: true }); }
});

/** Runs `allow-plugin` against a fake server returning `plugin` for tool `t1`, typing `answer`. */
async function allowPlugin(spec: (digest: string) => string, answer: string, entry: Record<string, unknown> = { command: "./server", args: ["--x"] }, legacyToken = false, extra: { path: string; content: Buffer }[] = []) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "allow-")));
  const files = [{ path: "server", content: Buffer.from("#!/bin/sh\n") }, { path: "plugin.json", content: Buffer.from("{}") }, ...extra];
  const digest = contentDigest(files);
  let auth: string | undefined;
  let path: string | undefined;
  const server = createServer((req, res) => {
    auth = req.headers.authorization;
    path = req.url;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "law", entry, files: files.map((f) => ({ path: f.path, base64: f.content.toString("base64") })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await mkdir(join(base, "config"));
    await writeFile(join(base, "config", "config.json"), JSON.stringify({ server: url, roots: [join(base, "root")], ...(legacyToken ? {} : { token: "tok" }), runnerId: "r" }));
    if (legacyToken) await writeFile(join(base, "config", "token"), "tok\n");
    const child = spawn(process.execPath, ["src/main.ts", "allow-plugin", "--config", join(base, "config"), "t1", spec(digest)], { env: { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: "" } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    child.stdin.end(`${answer}\n`);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    const config = JSON.parse(await readFile(join(base, "config", "config.json"), "utf8")) as Record<string, unknown>;
    return { code, out, config, digest, auth, path, mode: (await stat(join(base, "config", "config.json"))).mode & 0o777 };
  } finally {
    server.close();
    await rm(base, { recursive: true, force: true });
  }
}

test("allow-plugin writes the record after a typed yes, from the files it fetched itself", async () => {
  const { code, out, config, digest, auth, path, mode } = await allowPlugin((d) => `law@${d}`, "yes");
  expect(code).toBe(0);
  expect(auth).toBe("Bearer tok");
  expect(path).toBe("/runner/plugins/t1");
  expect(out).toContain('"--x"');
  expect(out).not.toContain("not what it downloads");
  expect(config).toMatchObject({ token: "tok", allowedPlugins: [{ name: "law", digest, entry: { command: "./server", args: ["--x"] } }] });
  expect(mode.toString(8)).toBe("600");
});

test("allow-plugin keeps an older runner's token, moved from its token file into the config it rewrites", async () => {
  const { code, config } = await allowPlugin((d) => `law@${d}`, "yes", undefined, true);
  expect(code).toBe(0);
  expect(config).toMatchObject({ token: "tok", allowedPlugins: [{ name: "law" }] });
});

test("allow-plugin refuses a digest that differs from the fetched files", async () => {
  const { code, out, config } = await allowPlugin(() => `law@sha256:${"0".repeat(64)}`, "yes");
  expect(code).toBe(1);
  expect(out).toContain("nothing was written");
  expect(config.allowedPlugins).toBeUndefined();
});

test("allow-plugin refuses another plugin's name, and writes nothing without a yes", async () => {
  const other = await allowPlugin((d) => `contracts@${d}`, "yes");
  expect(other.code).toBe(1);
  expect(other.out).toContain("runs the plugin law, not contracts");
  expect(other.config.allowedPlugins).toBeUndefined();
  const no = await allowPlugin((d) => `law@${d}`, "y");
  expect(no.code).toBe(1);
  expect(no.config.allowedPlugins).toBeUndefined();
});

test("allow-plugin writes no record for files the runner would never launch", async () => {
  const { code, out, config } = await allowPlugin((d) => `law@${d}`, "yes", undefined, false, [{ path: ".mcp.json", content: Buffer.from("{}") }]);
  expect(code).toBe(1);
  expect(out).toContain("holds an unsafe or repeated path. Nothing was written.");
  expect(config.allowedPlugins).toBeUndefined();
});

test("allow-plugin says so when the command isn't a file of the plugin", async () => {
  const { code, out } = await allowPlugin((d) => `law@${d}`, "yes", { command: "npx", args: ["some-package"] });
  expect(code).toBe(0);
  expect(out).toContain("this record covers the command line, not what it downloads");
});
