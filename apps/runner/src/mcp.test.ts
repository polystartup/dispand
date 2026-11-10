import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { codexMcpServers, discoverTool, mcpConfigFor, ToolRefused, withJobServer } from "./mcp.ts";

const echo = { command: process.execPath, args: [resolve("src/fixtures/echo-mcp.ts")] };

test("http server passed with its headers", () => {
  const config = mcpConfigFor(
    [
      { name: "github", type: "http", url: "https://api.example.test/mcp", transport: "streamable-http", headers: { authorization: "Bearer s3cret" } },
      { name: "legacy", type: "http", url: "https://sse.example.test/sse", transport: "sse", headers: {} },
    ],
    undefined,
  );
  expect(config).toEqual({
    github: { type: "http", url: "https://api.example.test/mcp", headers: { authorization: "Bearer s3cret" } },
    legacy: { type: "sse", url: "https://sse.example.test/sse", headers: {} },
  });
});

const fromHome = (command: string, ...args: string[]) => ["-c", 'cd "$1" && shift && exec "$@"', "sh", "/home/me", command, ...args];

test("a runner tool is the machine's own server of that name, started from the home folder", () => {
  const config = mcpConfigFor([{ name: "search", type: "runner", tool: "brave" }], { brave: { command: "npx", args: ["-y", "brave"], env: { BRAVE_API_KEY: "k" } } }, "/home/me");
  expect(config).toEqual({ search: { type: "stdio", command: "/bin/sh", args: fromHome("npx", "-y", "brave"), env: { BRAVE_API_KEY: "k" } } });
});

test("never from the session's folder, where the agent could plant an .npmrc", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mcp-home-")));
  const config = mcpConfigFor([{ name: "pwd", type: "runner", tool: "pwd" }], { pwd: { command: "pwd" } }, dir);
  const server = config.pwd as { command: string; args: string[] };
  const { stdout } = await promisify(execFile)(server.command, server.args, { cwd: tmpdir() });
  expect(stdout.trim()).toBe(dir);
  await rm(dir, { recursive: true });
});

test("an unknown runner tool is refused", () => {
  expect(() => mcpConfigFor([{ name: "x", type: "runner", tool: "fetch" }], { brave: { command: "npx" } })).toThrow(ToolRefused);
  expect(() => mcpConfigFor([{ name: "x", type: "runner", tool: "fetch" }], undefined)).toThrow(/no MCP server fetch/);
  // Not a name the config has, only one every object has.
  expect(() => mcpConfigFor([{ name: "x", type: "runner", tool: "constructor" }], {})).toThrow(ToolRefused);
});

test("a name given twice is refused", () => {
  const ref = { name: "a", type: "http", url: "https://a.test/mcp", transport: "streamable-http", headers: {} } as const;
  expect(() => mcpConfigFor([ref, ref], undefined)).toThrow(/twice/);
});

test("Codex gets header values by environment variable name only", () => {
  const { servers, env } = codexMcpServers(
    [
      { name: "github", type: "http", url: "https://api.example.test/mcp", transport: "streamable-http", headers: { authorization: "Bearer s3cret", "x-org": "acme" } },
      { name: "search", type: "runner", tool: "brave" },
    ],
    { brave: { command: "npx", args: ["brave"], env: { BRAVE_API_KEY: "k" } } },
    "/home/me",
  );
  expect(servers).toEqual({
    github: { url: "https://api.example.test/mcp", env_http_headers: { authorization: "DISPAND_MCP_0_0", "x-org": "DISPAND_MCP_0_1" } },
    search: { command: "/bin/sh", args: fromHome("npx", "brave"), env: { BRAVE_API_KEY: "k" } },
  });
  expect(JSON.stringify(servers)).not.toContain("s3cret");
  expect(env).toEqual({ DISPAND_MCP_0_0: "Bearer s3cret", DISPAND_MCP_0_1: "acme" });
});

test("an SSE server is refused for Codex", () => {
  expect(() => codexMcpServers([{ name: "old", type: "http", url: "https://old.test/sse", transport: "sse", headers: {} }], undefined)).toThrow(
    "Codex can't use the MCP server old: it only speaks SSE",
  );
});

test("discover lists actions of a fixture stdio server", async () => {
  const actions = await discoverTool("echo", echo);
  expect(actions).toEqual([
    { name: "echo", description: "Returns its text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  ]);
});

test("discover redacts the server's env values from what it lists", async () => {
  const actions = await discoverTool("echo", { ...echo, env: { ECHO_LEAK: "API_KEY", API_KEY: "sk-12345" } });
  expect(actions[0]!.description).toBe("Uses key •••• for itself");
  expect(JSON.stringify(actions)).not.toContain("sk-12345");
  // A value that is also a field's name leaves the fields as they are.
  const named = await discoverTool("echo", { ...echo, env: { X: "name", Y: "inputSchema", Z: "description" } });
  expect(named).toEqual([expect.objectContaining({ name: "echo", inputSchema: expect.objectContaining({ type: "object" }) })]);
});

test("discover past its timeout replies with an error", async () => {
  await expect(discoverTool("echo", { ...echo, env: { ECHO_MCP_HANG: "1" } }, 1500)).rejects.toThrow("the MCP server echo didn't answer in time");
});

test("a command that doesn't start is an error in the runner's own words", async () => {
  await expect(discoverTool("gone", { command: "/nonexistent/mcp-server" })).rejects.toThrow("the MCP server gone didn't start or failed while listing its actions");
});

test("the Job server is this runner's own server at /mcp/job, with the Job's token: the start names no address", () => {
  const github = { name: "github", type: "http" as const, url: "https://api.example.test/mcp", transport: "streamable-http" as const, headers: {} };
  expect(withJobServer([github], "https://dispand.test", "dj_token")).toEqual([
    github,
    { name: "job", type: "http", url: "https://dispand.test/mcp/job", transport: "streamable-http", headers: { authorization: "Bearer dj_token" } },
  ]);
  // Whatever the configured server's path or trailing slash.
  expect(withJobServer([], "https://dispand.test/", "t")[0]).toMatchObject({ url: "https://dispand.test/mcp/job" });
  expect(withJobServer([], "http://localhost:3000", "t")[0]).toMatchObject({ url: "http://localhost:3000/mcp/job" });
  // Without a token, nothing is added.
  expect(withJobServer([github], "https://dispand.test", undefined)).toEqual([github]);
});
