import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { deniedTools, runnerArgumentsAllowed, narrowUnasked, unaskedTools, callTool, codexMcpServers, credentialValues, discoverTool, mcpConfigFor, ToolRefused, withJobServer } from "./mcp.ts";
import { codexDenied } from "./boundary.ts";

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
    github: { url: "https://api.example.test/mcp", env_http_headers: { authorization: "DISPAND_MCP_0_0", "x-org": "DISPAND_MCP_0_1" }, default_tools_approval_mode: "prompt" },
    search: { command: "/bin/sh", args: fromHome("npx", "brave"), env: { BRAVE_API_KEY: "k" }, default_tools_approval_mode: "prompt" },
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

test("discover says which actions the server marks read-only", async () => {
  expect(await discoverTool("echo", readOnly)).toEqual([expect.objectContaining({ name: "echo", readOnly: true })]);
  expect((await discoverTool("echo", echo))[0]).not.toHaveProperty("readOnly");
});

test("discover past its timeout replies with an error", async () => {
  await expect(discoverTool("echo", { ...echo, env: { ECHO_MCP_HANG: "1" } }, 1500)).rejects.toThrow("the MCP server echo didn't answer in time");
});

test("a command that doesn't start is an error in the runner's own words", async () => {
  await expect(discoverTool("gone", { command: "/nonexistent/mcp-server" })).rejects.toThrow("the MCP server gone didn't start or failed while listing its actions");
});

test("a Job's session gets both of Dispand's servers at the runner's own address: the start names none", () => {
  const github = { name: "github", type: "http" as const, url: "https://api.example.test/mcp", transport: "streamable-http" as const, headers: {} };
  const headers = { authorization: "Bearer dj_token" };
  expect(withJobServer([github], "https://dispand.test", "dj_token")).toEqual([
    github,
    { name: "job", type: "http", url: "https://dispand.test/mcp/job", transport: "streamable-http", headers },
    { name: "job_tools", type: "http", url: "https://dispand.test/mcp/job/tools", transport: "streamable-http", headers },
  ]);
  // Whatever the configured server's path or trailing slash.
  expect(withJobServer([], "https://dispand.test/", "t").map((r) => (r.type === "http" ? r.url : ""))).toEqual(["https://dispand.test/mcp/job", "https://dispand.test/mcp/job/tools"]);
  expect(withJobServer([], "http://localhost:3000", "t")[1]).toMatchObject({ url: "http://localhost:3000/mcp/job/tools" });
  // Without a token, nothing is added.
  expect(withJobServer([github], "https://dispand.test", undefined)).toEqual([github]);
});

const readOnly = { ...echo, env: { ECHO_READ_ONLY: "1" } };

test("a poll's call of a read-only action returns its result", async () => {
  expect(await callTool("echo", readOnly, "echo", { text: "hi" })).toEqual({ content: [{ type: "text", text: "hi" }], isError: false, hasMore: false });
});

test("a result the server cut short at its own cap says so (`_meta.result_has_more`)", async () => {
  expect(await callTool("echo", { ...echo, env: { ECHO_READ_ONLY: "1", ECHO_HAS_MORE: "1" } }, "echo", { text: "hi" })).toMatchObject({ isError: false, hasMore: true });
});

test("an action the server doesn't mark read-only is refused, whatever the call asks, unless the runner's config lists it", async () => {
  await expect(callTool("echo", echo, "echo", { text: "hi" })).rejects.toThrow("the action echo of echo isn't read-only, and this runner's config doesn't list it as pollable");
  expect(await callTool("echo", { ...echo, pollable: ["echo"] }, "echo", { text: "hi" })).toMatchObject({ isError: false });
});

test("an empty pollable list forbids every call, read-only or not", async () => {
  await expect(callTool("echo", { ...readOnly, pollable: [] }, "echo", { text: "hi" })).rejects.toThrow("the MCP server echo allows no polls on this runner");
});

test("an action the server doesn't have is refused", async () => {
  await expect(callTool("echo", readOnly, "send", {})).rejects.toThrow("the MCP server echo has no action send");
});

test("the server's env values are redacted from what the call returns", async () => {
  const result = await callTool("echo", { ...echo, env: { ECHO_READ_ONLY: "1", ECHO_PREFIX: "sk-12345 " } }, "echo", { text: "hi" });
  expect(JSON.stringify(result)).not.toContain("sk-12345");
  expect(result.content).toEqual([{ type: "text", text: "••••hi" }]);
});

test("a call past its timeout is an error, and one that doesn't start is in the runner's own words", async () => {
  await expect(callTool("echo", { ...echo, env: { ECHO_MCP_HANG: "1" } }, "echo", {}, undefined, 1500)).rejects.toThrow("the MCP server echo didn't answer in time");
  await expect(callTool("gone", { command: "/nonexistent/mcp-server", pollable: ["x"] }, "x", {})).rejects.toThrow("the MCP server gone didn't start or failed while calling x");
});

test("a call naming a path the runner keeps out of reach is refused before the server starts, however the path is written", async () => {
  const guard = { forbidden: [join(homedir(), ".config", "dispand-runner"), join(homedir(), ".claude")], secrets: [] };
  for (const path of [join(homedir(), ".config", "dispand-runner", "config.json"), "~/.claude/.credentials.json", ".claude", "file://" + join(homedir(), ".claude"), join(homedir(), ".claude", "..", ".claude")]) {
    await expect(callTool("echo", readOnly, "echo", { text: "hi", path: { nested: [path] } }, guard)).rejects.toThrow("the call names a path this runner keeps out of reach");
  }
  expect(await callTool("echo", readOnly, "echo", { text: "hi" }, guard)).toMatchObject({ isError: false });
});

test("the runner's own token is redacted, and an env value that is an envelope field leaves the content well-formed", async () => {
  // The token is no env value of the server: only the runner's own secrets catch it.
  const result = await callTool("echo", { ...echo, env: { ECHO_READ_ONLY: "1", FORMAT: "text" } }, "echo", { text: "dr_token1234 hi" }, { forbidden: [], secrets: ["dr_token1234"] });
  expect(result.content).toEqual([{ type: "text", text: "•••• hi" }]);
  expect(JSON.stringify(result)).not.toContain("dr_token1234");
});

test("a file URL with a host, and a credentials file linked from outside, are refused like the paths they name", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "poll-guard-")));
  try {
    const codex = join(base, ".codex");
    const outside = join(base, "elsewhere");
    await mkdir(codex);
    await mkdir(outside);
    await writeFile(join(outside, "auth.json"), "{}");
    await symlink(join(outside, "auth.json"), join(codex, "auth.json"));
    const guard = { forbidden: codexDenied([codex]), secrets: [] };
    const encoded = `file://${codex.replaceAll("/", "%2F")}%2Fauth.json`;
    // Read literally from the home folder, `file://host/../../.claude` is `~/.claude`.
    await expect(callTool("echo", readOnly, "echo", { path: "file://host/../../.claude/settings.json" }, { forbidden: [join(homedir(), ".claude")], secrets: [] })).rejects.toThrow("keeps out of reach");
    for (const path of [`file://localhost${join(codex, "auth.json")}`, `file://${join(codex, "auth.json").replace(/\//g, "%2F").replace(/^%2F/, "/")}`, encoded, join(codex, "auth.json"), join(outside, "auth.json")]) {
      await expect(callTool("echo", readOnly, "echo", { text: "hi", path }, guard)).rejects.toThrow("the call names a path this runner keeps out of reach");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a credential's value is redacted from a result however the server reached it, and so is a secret in a nested key", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "poll-creds-")));
  try {
    await writeFile(join(base, "auth.json"), JSON.stringify({ tokens: { access_token: "codex-access-token-0123456789" } }));
    const secrets = credentialValues([join(base, "auth.json"), join(base, "missing.json")]);
    expect(secrets).toEqual(["codex-access-token-0123456789"]);
    // No env value of the server holds it: only the credentials' values catch it.
    const read = await callTool("echo", readOnly, "echo", { text: "codex-access-token-0123456789" }, { forbidden: [], secrets });
    expect(read.content).toEqual([{ type: "text", text: "••••" }]);
    // A secret as a key inside an item is redacted too; the item's own keys stay.
    const keyed = await callTool("echo", { ...echo, env: { ECHO_READ_ONLY: "1", ECHO_META: "sk-env-secret-key" } }, "echo", { text: "hi" });
    expect(JSON.stringify(keyed)).not.toContain("sk-env-secret-key");
    expect(keyed.content[0]).toEqual({ type: "text", text: "hi", _meta: { "••••": "x" } });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test.each([undefined, []])("runner grants are namespaced and only shrink live (Job context: %j)", (jobTools) => {
  const refs = [{ name: "mail", type: "runner" as const, tool: "gmail", unasked: ["draft_email"] }];
  const { names, servers } = unaskedTools(refs, jobTools);
  expect(servers.includes("job_tools")).toBe(jobTools !== undefined);
  expect([...names]).toEqual(["mcp__mail__draft_email"]);
  expect(names.has("mcp__other__draft_email")).toBe(false);
  narrowUnasked(names, servers, [{ name: "mail", unasked: ["draft_email", "send_email"] }]);
  expect([...names]).toEqual(["mcp__mail__draft_email"]);
  narrowUnasked(names, servers, []);
  expect([...names]).toEqual([]);
  narrowUnasked(names, servers, [{ name: "mail", unasked: ["draft_email"] }]);
  expect([...names]).toEqual([]);
});

test("automatic runner grants use the poll guard for protected paths", () => {
  const forbidden = ["/guarded/config.json"];
  for (const path of ["/guarded/config.json", "file:///guarded/config.json", "%2Fguarded%2Fconfig.json", "/allowed/" + "../".repeat(1500) + "guarded/config.json"]) expect(runnerArgumentsAllowed({ nested: [{ path }] }, forbidden)).toBe(false);
  expect(runnerArgumentsAllowed({ path: "/allowed/note.txt" }, forbidden)).toBe(true);
});


test("runner denials accumulate and removing a server cannot be undone in a live session", () => {
  const permissions = deniedTools([{ name: "mail", type: "runner", tool: "gmail", denied: ["send.email"] }], "codex");
  expect([...permissions.names]).toEqual(["mcp__mail__send.email"]);
  expect(permissions.blocks("mcp__mail__send.email")).toBe(true);
  expect(permissions.blocks("mcp__other__send.email")).toBe(false);
  expect(permissions.blocks("mcp__mail__draft")).toBe(false);
  permissions.narrow([{ name: "mail", unasked: [], denied: ["draft"] }]);
  permissions.narrow([{ name: "mail", unasked: ["draft"], denied: [] }]);
  expect(permissions.blocks("mcp__mail__draft")).toBe(true);
  expect(permissions.blocks("mcp__mail__send.email")).toBe(true);
  permissions.narrow([]);
  permissions.narrow([{ name: "mail", unasked: ["new_action"], denied: [] }]);
  expect(permissions.blocks("mcp__mail__new_action")).toBe(true);
  expect(permissions.blocks("mcp__mailbox__new_action")).toBe(false);
  expect(permissions.blocks("Bash")).toBe(false);
});

test("Codex hides denied runner actions from its native tool list", () => {
  const { servers } = codexMcpServers([{ name: "mail", type: "runner", tool: "gmail", denied: ["send.email"] }], { gmail: { command: "mail" } });
  expect(servers.mail).toMatchObject({ disabled_tools: ["send.email"], default_tools_approval_mode: "prompt" });
});


test.each([
  ["send.email", "send_email"],
  ["send email", "send_email"],
  ["send/email", "send_email"],
  ["send:email", "send_email"],
  ["send😀email", "send__email"],
  ["claude.ai  send.email", "claude_ai_send_email"],
])("denied %s uses Claude's alias %s and preserves Codex's raw action name", (action, alias) => {
  const ref = { name: "mail", type: "runner" as const, tool: "gmail", denied: [action] };
  for (const initial of [true, false]) {
    const refs = [{ ...ref, denied: initial ? [action] : [] }];
    const claude = deniedTools(refs, "claude-code");
    const codex = deniedTools(refs, "codex");
    if (!initial) {
      claude.narrow([{ name: "mail", unasked: [], denied: [action] }]);
      codex.narrow([{ name: "mail", unasked: [], denied: [action] }]);
    }
    expect([...claude.names]).toEqual([`mcp__mail__${alias}`]);
    expect(claude.blocks(`mcp__mail__${alias}`)).toBe(true);
    expect(codex.blocks(`mcp__mail__${action}`)).toBe(true);
    expect(codex.blocks(`mcp__mail__${alias}`)).toBe(false);
  }
});
