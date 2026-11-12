import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import type { MarketplaceEntry } from "./marketplace.ts";
import { readPlugin } from "./read-plugin.ts";
import { PLUGIN_NAME } from "./standard.ts";
import { type FixtureFile, skillMd, writeTree } from "./test-support.ts";

// One test per item of the Agent Plugins 1.0.0 client conformance checklist (agent-plugins.org),
// named after it. The items about running servers are the runner's.

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function tree(files: Record<string, FixtureFile>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dispand-standard-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(dir, files);
  return dir;
}

const entry: MarketplaceEntry = { name: "demo", source: { type: "path", path: "./" } };
const manifest = (more: Record<string, unknown> = {}) => JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "demo", ...more });
const mcp = (servers: Record<string, unknown>, more: Record<string, unknown> = {}) => JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: servers, ...more });
/** Reads a standard plugin made of `files` (with a minimal `plugin.json` unless given). */
const read = (files: Record<string, FixtureFile>, links: string[] = []) => readPlugin(tree({ "plugin.json": manifest(), ...files }), entry, links);
const reasons = (got: ReturnType<typeof read>) => got.notImported.map((n) => `${n.component} ${n.name}: ${n.reason}`);

test("loads a plugin from a directory and enforces the filesystem-resolved boundary", () => {
  const outside = tree({ "secret/SKILL.md": skillMd("secret") });
  const got = read({
    "skills/ok/SKILL.md": skillMd("ok"),
    "skills/ok/host": { link: "/etc/hostname" },
    "skills/linked": { link: join(outside, "secret") },
  });
  expect(got.layout).toBe("standard");
  expect(got.skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([["ok", ["ok/SKILL.md"]]]);
  expect(reasons(got)).toEqual(["file ok/host: A symbolic link"]);
  // A checkout's links are removed by fetchGit and listed; a linked manifest rejects the plugin.
  expect(reasons(read({}, ["skills/x"]))).toEqual(["file skills/x: A symbolic link"]);
  expect(() => readPlugin(tree({}), entry, ["plugin.json"])).toThrow("plugin.json is a symbolic link");
  expect(() => readPlugin(tree({ "plugin.json": { link: join(outside, "secret/SKILL.md") } }), entry)).toThrow("plugin.json isn't a regular file");
});

test("selects manifest rules from `$schema` without retrieving a schema", () => {
  // No network is reachable from this test: an id that would need fetching would fail.
  expect(read({}).version).toBeNull();
  expect(read({ "plugin.json": manifest({ version: "1.2.0" }) }).version).toBe("1.2.0");
  for (const $schema of ["https://agent-plugins.org/schemas/1.1.0/plugin.schema.json", "https://example.com/plugin.schema.json", 1]) {
    expect(() => read({ "plugin.json": manifest({ $schema }) }), String($schema)).toThrow("Agent Plugins version Dispand doesn't support");
  }
});

test("validates the closed `plugin.json` schema and required `$schema` and `name`", () => {
  expect(() => read({ "plugin.json": JSON.stringify({ name: "demo" }) })).toThrow("plugin.json has no $schema");
  expect(() => read({ "plugin.json": JSON.stringify({ $schema: PLUGIN_SCHEMA }) })).toThrow("plugin.json's name isn't valid");
  for (const name of ["my-plugin", "acme.tools", "lint3r", "a", "x".repeat(64)]) {
    expect(PLUGIN_NAME.test(name) && name.length <= 64, name).toBe(true);
    expect(read({ "plugin.json": manifest({ name }) }).layout, name).toBe("standard");
  }
  for (const name of ["My-Plugin", "-start", "has--double", "too.many..dots", "", "end-", "x".repeat(65), 7]) {
    expect(() => read({ "plugin.json": manifest({ name }) }), String(name)).toThrow("plugin.json's name isn't valid");
  }
  const full = manifest({
    version: "1.2.0",
    description: "Brief",
    author: { name: "Author", email: "author@example.com", url: "https://example.com" },
    homepage: "https://example.com/plugin",
    repository: "https://example.com/plugin.git",
    license: "MIT",
    keywords: ["a", "b"],
    extensions: { "com.example.client": { setting: true } },
  });
  expect(read({ "plugin.json": full }).notImported).toEqual([]);
});

test("reports and ignores unknown top-level fields", () => {
  const got = read({ "plugin.json": manifest({ hooks: "./hooks.json", mcpServers: { x: { type: "stdio", command: "x" } } }), "skills/ok/SKILL.md": skillMd("ok") });
  expect(reasons(got)).toEqual(["manifest hooks: Not a field of plugin.json: ignored", "manifest mcpServers: Not a field of plugin.json: ignored"]);
  // An unknown field is given no meaning: its servers aren't read.
  expect(got.mcpServers).toEqual([]);
  expect(got.skills.map((s) => s.name)).toEqual(["ok"]);
});

test("ignores a non-object `extensions` and unimplemented namespaces", () => {
  for (const extensions of ["com.dispand", ["com.dispand"], null, 3]) {
    const got = read({ "plugin.json": manifest({ extensions }), "skills/ok/SKILL.md": skillMd("ok") });
    expect(reasons(got), JSON.stringify(extensions)).toEqual(["manifest extensions: Not an object: ignored"]);
    expect(got.skills.map((s) => s.name)).toEqual(["ok"]);
  }
  // A namespace's value and folder aren't validated or read, whatever they hold.
  const got = read({
    "plugin.json": manifest({ extensions: { "com.example.client": "not an object", "org.other": { deep: [1] } } }),
    "com.example.client/hooks/hooks.json": "{",
    "com.example.client/link": { link: "/etc/hostname" },
    "com.example.client/bad\\name": "",
  });
  expect(got.notImported).toEqual([]);
});

test("rejects other fatal manifest violations before discovery", () => {
  const bad: Record<string, unknown>[] = [
    { version: 1 },
    { description: ["x"] },
    { author: "Author" },
    { author: { name: "Author", company: "Acme" } },
    { author: { email: 3 } },
    { homepage: false },
    { repository: {} },
    { license: null },
    { keywords: "a, b" },
    { keywords: ["a", 2] },
  ];
  for (const more of bad) {
    // A skill that doesn't validate would be listed if discovery had started.
    expect(() => read({ "plugin.json": manifest(more), "skills/x/SKILL.md": skillMd("y") }), JSON.stringify(more)).toThrow(/^plugin\.json's \w+ isn't valid$/);
  }
  expect(() => read({ "plugin.json": "{" })).toThrow("plugin.json isn't valid JSON");
  expect(() => read({ "plugin.json": "[]" })).toThrow("plugin.json isn't a JSON object");
});

test("discovers components only from their fixed locations", () => {
  const got = read({
    "plugin.json": manifest(),
    "skills/top/SKILL.md": skillMd("top"),
    "skills/top/nested/SKILL.md": skillMd("nested"),
    "skills/group/inner/SKILL.md": skillMd("inner"),
    "skills/notes.md": "not a skill",
    ".claude-plugin/plugin.json": JSON.stringify({ name: "demo", mcpServers: { a: { url: "https://a.example.com/mcp" } } }),
    ".mcp.json": JSON.stringify({ mcpServers: { b: { url: "https://b.example.com/mcp" } } }),
    "agents/reviewer.md": "You review.",
    "hooks/hooks.json": "{}",
    "commands/plan.md": "Plan.",
    "bin/tool": "#!/bin/sh\n",
    "other/SKILL.md": skillMd("other"),
  });
  expect(got.skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([["top", ["top/SKILL.md", "top/nested/SKILL.md"]]]);
  expect(got.mcpServers).toEqual([]);
  expect(got.agents).toEqual([]);
  expect(got.notImported).toEqual([]);
  // A marketplace entry can't add skills or servers to a standard plugin either.
  const listed = readPlugin(tree({ "plugin.json": manifest(), "other/SKILL.md": skillMd("other") }), { ...entry, skills: ["./other"], manifest: { mcpServers: { a: { url: "https://a.example.com" } } } });
  expect([listed.skills, listed.mcpServers]).toEqual([[], []]);
});

test("treats missing component locations as valid absence", () => {
  expect(read({})).toEqual({ layout: "standard", version: null, skills: [], mcpServers: [], agents: [], notImported: [] });
});

test("isolates invalid component types, skills and MCP entries", () => {
  const server = { type: "streamable-http", url: "https://ok.example.com/mcp" };
  const notDir = read({ skills: "a file", "mcp.json": mcp({ ok: server }) });
  expect(reasons(notDir)).toEqual(["skill skills: Not a folder: no skill is read"]);
  expect(notDir.mcpServers.map((s) => s.name)).toEqual(["ok"]);

  const notFile = read({ "mcp.json/x": "", "skills/ok/SKILL.md": skillMd("ok") });
  expect(reasons(notFile)).toEqual(["mcp-server mcp.json: Not a regular file: no MCP server is read"]);
  expect(notFile.skills.map((s) => s.name)).toEqual(["ok"]);

  const mixed = read({
    "skills/ok/SKILL.md": skillMd("ok"),
    "skills/wrong/SKILL.md": skillMd("other-name"),
    "skills/Bad_Name/SKILL.md": skillMd("Bad_Name"),
    "mcp.json": mcp({ ok: server, bad: { type: "websocket", url: "wss://x.example.com" } }),
  });
  expect(mixed.skills.map((s) => s.name)).toEqual(["ok"]);
  expect(mixed.mcpServers.map((s) => s.name)).toEqual(["ok"]);
  expect(reasons(mixed)).toEqual([
    "skill Bad_Name: Its name isn't lowercase letters, digits and hyphens",
    'skill wrong: wrong/SKILL.md: the frontmatter\'s name must be "wrong", its folder',
    "mcp-server bad: Its type isn't stdio, streamable-http or sse",
  ]);
});

test("validates the closed `mcp.json` and each entry independently", () => {
  const ok = { type: "stdio", command: "node" };
  for (const [doc, reason] of [
    ["{", "Not valid JSON"],
    ["[]", "Not a JSON object"],
    [JSON.stringify({ mcpServers: {} }), "Its $schema isn't an Agent Plugins version Dispand supports"],
    [JSON.stringify({ $schema: MCP_SCHEMA }), "Its mcpServers isn't an object"],
    [JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: [] }), "Its mcpServers isn't an object"],
    [mcp({ ok }, { servers: {} }), "It has a field mcp.json doesn't take"],
  ] as const) {
    const got = read({ "mcp.json": doc, "skills/ok/SKILL.md": skillMd("ok") });
    expect(reasons(got), doc).toEqual([`mcp-server mcp.json: ${reason}: no MCP server is read`]);
    expect(got.skills.map((s) => s.name)).toEqual(["ok"]);
  }
  expect(read({ "mcp.json": mcp({}) }).notImported).toEqual([]);

  const got = read({
    "mcp.json": mcp({
      local: { type: "stdio", command: "./bin/server", args: ["--data", "${PLUGIN_DATA}/x"], env: { CONFIG: "${PLUGIN_ROOT}/config.json" }, cwd: "${PLUGIN_ROOT}" },
      remote: { type: "streamable-http", url: "https://deploy.example.com/mcp", headers: { "X-Tenant": "public-tenant" } },
      legacy: { type: "sse", url: "https://legacy.example.com/sse" },
      untyped: { command: "node" },
      extra: { type: "stdio", command: "node", timeout: 5 },
      crossed: { type: "streamable-http", url: "https://x.example.com/mcp", command: "node" },
      args: { type: "stdio", command: "node", args: "--x" },
      env: { type: "stdio", command: "node", env: { N: 1 } },
      scalar: "node",
    }),
  });
  expect(got.mcpServers).toEqual([
    {
      name: "local",
      type: "stdio",
      command: "./bin/server",
      args: ["--data", "${PLUGIN_DATA}/x"],
      env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
      cwd: "${PLUGIN_ROOT}",
      settings: [],
    },
    { name: "remote", type: "http", url: "https://deploy.example.com/mcp", transport: "streamable-http", headers: { "X-Tenant": "public-tenant" }, settings: [] },
    { name: "legacy", type: "http", url: "https://legacy.example.com/sse", transport: "sse", headers: {}, settings: [] },
  ]);
  expect(reasons(got)).toEqual([
    "mcp-server untyped: It has no type",
    "mcp-server extra: It has a field its type doesn't take: timeout",
    "mcp-server crossed: It has a field its type doesn't take: command",
    "mcp-server args: Its arguments aren't a list of strings",
    "mcp-server env: Its environment isn't an object of strings",
    "mcp-server scalar: Not an object",
  ]);
});

test("requires matching versions in `plugin.json` and `mcp.json`", () => {
  const later = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json", mcpServers: { x: { type: "stdio", command: "node" } } });
  expect(reasons(read({ "mcp.json": later }))).toEqual(["mcp-server mcp.json: Its $schema isn't an Agent Plugins version Dispand supports: no MCP server is read"]);
  // The same version: read.
  expect(read({ "mcp.json": mcp({ x: { type: "stdio", command: "node" } }) }).mcpServers.map((s) => s.name)).toEqual(["x"]);
});

test("resolves stdio commands as single executable tokens", () => {
  const server = (command: unknown) => ({ type: "stdio", command });
  const valid = ["node", "uvx", "./bin/server", "./server.js", "./a/../b"];
  const invalid = ["", "npx -y pkg", "node\t", "bin/server", "/usr/bin/node", "../bin/server", "./../x", "./a/../../x", "./", ".", "..", "./bin/", "${PLUGIN_ROOT}/bin/server", ".\\bin\\server", 3];
  const got = read({ "mcp.json": mcp(Object.fromEntries([...valid, ...invalid].map((c, i) => [`s${i}`, server(c)]))) });
  expect(got.mcpServers.map((s) => s.type === "stdio" && s.command)).toEqual(valid);
  expect(got.notImported).toHaveLength(invalid.length);
  expect(new Set(got.notImported.map((n) => n.reason))).toEqual(new Set(["Its command isn't one name or one ./ path inside the plugin"]));
});

test("enforces cwd containment and remote URL and header rules", () => {
  const stdio = (more: Record<string, unknown>) => ({ type: "stdio", command: "node", ...more });
  const remote = (url: string, headers?: Record<string, unknown>) => ({ type: "streamable-http", url, ...(headers ? { headers } : {}) });
  const got = read({
    "mcp.json": mcp({
      cwdRel: stdio({ cwd: "./data" }),
      cwdRoot: stdio({ cwd: "${PLUGIN_ROOT}/x/.." }),
      cwdData: stdio({ cwd: "${PLUGIN_DATA}" }),
      cwdDataSub: stdio({ cwd: "${PLUGIN_DATA}/cache" }),
      cwdBare: stdio({ cwd: "data" }),
      cwdAbs: stdio({ cwd: "/tmp" }),
      cwdUp: stdio({ cwd: "./../x" }),
      cwdRootUp: stdio({ cwd: "${PLUGIN_ROOT}/../x" }),
      cwdDataUp: stdio({ cwd: "${PLUGIN_DATA}/../plugin-root" }),
      cwdGlued: stdio({ cwd: "${PLUGIN_ROOT}x" }),
      envRoot: stdio({ env: { PLUGIN_ROOT: "/x" } }),
      envData: stdio({ env: { PLUGIN_DATA: "/x" } }),
      https: remote("https://mcp.example.com/mcp"),
      loopback: remote("http://localhost:8080/mcp"),
      loopbackIp: remote("http://127.0.0.1/mcp"),
      plainHttp: remote("http://mcp.example.com/mcp"),
      relative: remote("/mcp"),
      ftp: remote("ftp://mcp.example.com/mcp"),
      userInfo: remote("https://user:pass@mcp.example.com/mcp"),
      fragment: remote("https://mcp.example.com/mcp#x"),
      headerOk: remote("https://mcp.example.com/mcp", { "X-Tenant": "public" }),
      headerName: remote("https://mcp.example.com/mcp", { "X Tenant": "public" }),
      headerValue: remote("https://mcp.example.com/mcp", { "X-Tenant": "a\nb" }),
      headerType: remote("https://mcp.example.com/mcp", { "X-Tenant": 1 }),
      headerTwice: remote("https://mcp.example.com/mcp", { "X-Tenant": "a", "x-tenant": "b" }),
      placeholder: remote("https://mcp.example.com/${PLUGIN_ROOT}"),
      nul: remote("https://mcp.example.com/a\u0000b"),
      surrogate: stdio({ args: ["\ud800"] }),
    }),
  });
  expect(got.mcpServers.map((s) => s.name)).toEqual(["cwdRel", "cwdRoot", "cwdData", "cwdDataSub", "https", "loopback", "loopbackIp", "headerOk"]);
  const cwd = "Its working directory isn't inside the plugin or its data folder";
  const url = "Its URL isn't absolute http(s), https unless loopback, without credentials or fragment";
  const headers = "Its headers aren't valid HTTP headers";
  expect(Object.fromEntries(got.notImported.map((n) => [n.name, n.reason]))).toEqual({
    cwdBare: cwd,
    cwdAbs: cwd,
    cwdUp: cwd,
    cwdRootUp: cwd,
    cwdDataUp: cwd,
    cwdGlued: cwd,
    envRoot: "Its environment sets PLUGIN_ROOT or PLUGIN_DATA",
    envData: "Its environment sets PLUGIN_ROOT or PLUGIN_DATA",
    plainHttp: url,
    relative: url,
    ftp: url,
    userInfo: url,
    fragment: url,
    headerName: headers,
    headerValue: headers,
    headerType: headers,
    headerTwice: "It names a header twice",
    placeholder: "Its URL or headers hold ${…}, which Dispand would read as a setting",
    nul: "Its settings aren't readable",
    surrogate: "Its settings aren't readable",
  });
});

test("a root plugin.json wins over the Claude layout's manifest; without one, a plugin reads as before", () => {
  const both = { ".claude-plugin/plugin.json": JSON.stringify({ name: "demo", version: "2.0.0" }), "agents/a.md": "Prompt." };
  expect(readPlugin(tree({ ...both, "plugin.json": manifest() }), entry)).toMatchObject({ layout: "standard", agents: [] });
  expect(readPlugin(tree(both), entry)).toMatchObject({ layout: "claude", version: "2.0.0", agents: [{ name: "a" }] });
});

test("one read of a standard plugin has the same budget", () => {
  const servers = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`s${i}`, { type: "stdio", command: "node" }]));
  expect(() => read({ "mcp.json": mcp(servers) })).toThrow("more than 100 MCP servers");
  const skills: Record<string, string> = {};
  for (let i = 0; i < 201; i++) skills[`skills/s${i}/SKILL.md`] = skillMd(`s${i}`);
  expect(() => read(skills)).toThrow("more than 200 skills");
});
