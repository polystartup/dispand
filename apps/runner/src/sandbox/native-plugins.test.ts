import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { afterEach, expect, test } from "vitest";
import { unlock } from "../skills.ts";
import { codexMarketplace, managedLoaded, nativePluginFolders, nativePluginViews, sweepNativePlugins, withClaudeVariables, withoutDecidingHooks, withoutGrantingFrontmatter, withoutServers, type FetchNative } from "./native-plugins.ts";

const files = [{ path: ".claude-plugin/plugin.json", content: Buffer.from('{"name":"demo"}') }, { path: "hooks/hooks.json", content: Buffer.from("{}") }];
const digest = contentDigest(files);
let state: string;
afterEach(async () => {
  await sweepNativePlugins(state);
  await rm(state, { recursive: true, force: true });
});

/** A fake Dispand: these files for any plugin, counting its requests. */
function serve(given = files) {
  const asked: string[] = [];
  const fetchFiles: FetchNative = async (pluginId, d) => (asked.push(`${pluginId}@${d}`), given);
  return { asked, fetchFiles };
}

test("a plugin is written read-only under its digest, then reused without another fetch", async () => {
  state = await mkdtemp(join(tmpdir(), "native-"));
  const fake = serve();
  const [first] = await nativePluginFolders(state, [{ pluginId: "plugin_a", digest }], fake.fetchFiles);
  expect(first!.dir).toBe(join(state, "native-plugins", digest.slice(7)));
  expect(await readFile(join(first!.dir, "hooks/hooks.json"), "utf8")).toBe("{}");
  await expect(writeFile(join(first!.dir, "hooks/hooks.json"), "x")).rejects.toThrow();
  expect(((await stat(first!.dir)).mode & 0o222)).toBe(0);
  const [again] = await nativePluginFolders(state, [{ pluginId: "plugin_a", digest }], fake.fetchFiles);
  expect(again!.dir).toBe(first!.dir);
  expect(fake.asked).toEqual([`plugin_a@${digest}`]);
});

test("files that aren't the digest the start named, or with an unsafe path, are refused and nothing is kept", async () => {
  state = await mkdtemp(join(tmpdir(), "native-"));
  const other = `sha256:${"0".repeat(64)}`;
  await expect(nativePluginFolders(state, [{ pluginId: "plugin_a", digest: other }], serve().fetchFiles)).rejects.toThrow("don't have the digest");
  const unsafe = [{ path: "../escape", content: Buffer.from("x") }];
  await expect(nativePluginFolders(state, [{ pluginId: "plugin_a", digest: contentDigest(unsafe) }], serve(unsafe).fetchFiles)).rejects.toThrow("unsafe or repeated path");
  // A config file anywhere but the plugin root's own `.mcp.json` stays refused.
  for (const path of ["x/.mcp.json", ".claude/settings.json"]) {
    const config = [{ path, content: Buffer.from("{}") }];
    await expect(nativePluginFolders(state, [{ pluginId: "plugin_a", digest: contentDigest(config) }], serve(config).fetchFiles)).rejects.toThrow("unsafe or repeated path");
  }
  expect(await readdir(join(state, "native-plugins")).catch(() => [])).toEqual([]);
});

test("the plugin root's .mcp.json is kept, and a managed server it declares is out of the view", async () => {
  state = await mkdtemp(join(tmpdir(), "native-"));
  const declared = [...files, { path: ".mcp.json", content: json({ mcpServers: { notes: { command: "n" }, search: { command: "s" } } }) }];
  const d = contentDigest(declared);
  const stored = await nativePluginFolders(state, [{ pluginId: "plugin_a", digest: d }], serve(declared).fetchFiles);
  const servers = (dir: string) => readFile(join(dir, ".mcp.json"), "utf8").then((t) => Object.keys(JSON.parse(t).mcpServers));
  expect(await servers(stored[0]!.dir)).toEqual(["notes", "search"]);
  const views = join(state, "views");
  const [view] = await nativePluginViews(views, stored, [{ pluginId: "plugin_a", digest: d, managedServers: ["notes"] }]);
  expect(await servers(view!.dir)).toEqual(["search"]);
  await unlock(views);
});

test("the sweep at start removes the whole store, read-only folders included", async () => {
  state = await mkdtemp(join(tmpdir(), "native-"));
  await nativePluginFolders(state, [{ pluginId: "plugin_a", digest }], serve().fetchFiles);
  await sweepNativePlugins(state);
  await expect(stat(join(state, "native-plugins"))).rejects.toThrow();
  await sweepNativePlugins(state);
});

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const read = (out: { path: string; content: Buffer }[], path: string) => JSON.parse(out.find((f) => f.path === path)!.content.toString()) as Record<string, unknown>;

test("a managed server is left out of every place a plugin declares servers; the others stay", () => {
  const plugin = [
    { path: ".mcp.json", content: json({ mcpServers: { notes: { command: "n" }, search: { command: "s" } } }) },
    { path: "mcp.json", content: json({ mcpServers: { notes: { type: "stdio", command: "n" }, other: { type: "stdio", command: "o" } } }) },
    { path: ".claude-plugin/plugin.json", content: json({ name: "demo", mcpServers: ["./servers.json", { notes: { command: "n" }, inline: { command: "i" } }] }) },
    { path: "servers.json", content: json({ notes: { command: "n" }, linked: { command: "l" } }) },
    { path: "plugin.json", content: json({ name: "demo", mcpServers: { notes: { command: "n" } } }) },
    { path: "skills/a/SKILL.md", content: Buffer.from("notes") },
  ];
  const out = withoutServers(plugin, ["notes"]);
  expect(Object.keys(read(out, ".mcp.json").mcpServers as object)).toEqual(["search"]);
  expect(Object.keys(read(out, "mcp.json").mcpServers as object)).toEqual(["other"]);
  // A list mixing files and maps isn't a shape the filter reads for sure: its maps go, its files are filtered.
  expect(read(out, ".claude-plugin/plugin.json")).toEqual({ name: "demo" });
  expect(Object.keys(read(out, "servers.json"))).toEqual(["linked"]);
  expect(read(out, "plugin.json").mcpServers).toEqual({});
  expect(out.find((f) => f.path === "skills/a/SKILL.md")!.content.toString()).toBe("notes");
  // A server named `mcpServers` beside others: no guess, the declaration goes.
  const odd = withoutServers([{ path: ".claude-plugin/plugin.json", content: json({ name: "demo", mcpServers: { mcpServers: { notes: { command: "n" } }, notes: { command: "n" }, kept: { command: "k" } } }) }], ["notes"]);
  expect(read(odd, ".claude-plugin/plugin.json")).toEqual({ name: "demo" });
  // A manifest that names itself as a server file keeps its own filtering.
  const self = withoutServers([{ path: ".claude-plugin/plugin.json", content: json({ mcpServers: ["./.claude-plugin/plugin.json", { notes: { command: "n" }, kept: { command: "k" } }] }) }], ["notes"]);
  expect(JSON.stringify(read(self, ".claude-plugin/plugin.json"))).not.toContain('"notes"');
  // Nothing managed: the files as they are.
  expect(withoutServers(plugin, [])).toBe(plugin);
  // For Codex, a server keeps only how it starts: its own approval settings would override the prompt.
  const approving = { command: "node", args: ["s.mjs"], env: { A: "1" }, default_tools_approval_mode: "approve", tools: { echo: { approval_mode: "approve" } }, enabled_tools: ["echo"] };
  for (const forms of [[{ path: ".mcp.json", content: json({ mcpServers: { kept: approving } }) }], [{ path: ".mcp.json", content: json({ kept: approving }) }], [{ path: ".claude-plugin/plugin.json", content: json({ name: "demo", mcpServers: { kept: approving } }) }]]) {
    const codex = withoutServers(forms, [], true);
    const text = codex.map((f) => f.content.toString()).join("");
    expect(text).toMatch(/"command":\s*"node"/);
    expect(text).toMatch(/"A":\s*"1"/);
    expect(text).not.toMatch(/approval/);
    // What only narrows it stays: fewer tools.
    expect(text).toMatch(/"enabled_tools":/);
  }
});

test("a declaration of a shape the filter doesn't read for sure is dropped whole; nothing else of the plugin is lost", () => {
  const rest = [{ path: "skills/a/SKILL.md", content: Buffer.from("notes") }, { path: ".claude-plugin/plugin.json", content: json({ name: "demo" }) }];
  const shapes: unknown[] = [
    { mcpServers: [{ notes: { command: "n" } }, { kept: { command: "k" } }] }, // an array of maps
    [{ notes: { command: "n" } }], // the file an array
    { mcpServers: { mcpServers: { notes: { command: "n" } } } }, // a wrapper in the wrapper
    { mcpServers: { kept: { command: "k" } }, extra: { notes: { command: "n" } } }, // a map beside the wrapper
    { notes: "n" }, // a server that isn't an object
  ];
  for (const shape of shapes) {
    const out = withoutServers([...rest, { path: ".mcp.json", content: json(shape) }], ["notes"]);
    expect(out.map((f) => f.path).sort(), JSON.stringify(shape)).toEqual([".claude-plugin/plugin.json", "skills/a/SKILL.md"]);
    expect(out.every((f) => !f.content.toString().includes('"notes"'))).toBe(true);
  }
  // Not JSON: dropped too.
  expect(withoutServers([...rest, { path: ".mcp.json", content: Buffer.from("{ notes") }], ["notes"]).map((f) => f.path)).not.toContain(".mcp.json");
  // A managed server named `mcpServers` can't be told from the wrapper: its file goes.
  expect(withoutServers([...rest, { path: ".mcp.json", content: json({ mcpServers: { command: "m" } }) }], ["mcpServers"]).map((f) => f.path)).not.toContain(".mcp.json");
  // A root `plugin.json` a Claude plugin names as its server file, holding a bare map: filtered.
  const named = withoutServers([{ path: "skills/a/SKILL.md", content: Buffer.from("notes") }, { path: ".claude-plugin/plugin.json", content: json({ name: "demo", mcpServers: "./plugin.json" }) }, { path: "plugin.json", content: json({ notes: { command: "n" }, kept: { command: "k" } }) }], ["notes"]);
  expect(read(named, "plugin.json")).toEqual({ kept: { command: "k" } });
  // The reference stays, as the path it resolves to, with the `./` both CLIs require.
  expect(read(named, ".claude-plugin/plugin.json")).toEqual({ name: "demo", mcpServers: "./plugin.json" });
  // A manifest with a byte-order mark is read as Claude Code reads it, and filtered.
  const bom = withoutServers([{ path: ".claude-plugin/plugin.json", content: Buffer.from(`\uFEFF${JSON.stringify({ name: "demo", mcpServers: { notes: { command: "n" }, kept: { command: "k" } } })}`) }], ["notes"]);
  expect(read(bom, ".claude-plugin/plugin.json").mcpServers).toEqual({ kept: { command: "k" } });
  // The shapes it reads stay, filtered.
  const map = withoutServers([...rest, { path: ".mcp.json", content: json({ notes: { command: "n" }, kept: { command: "k" } }) }], ["notes"]);
  expect(read(map, ".mcp.json")).toEqual({ kept: { command: "k" } });
});

test("a view is derived at each start from the stored files, which stay as they are", async () => {
  state = await mkdtemp(join(tmpdir(), "native-"));
  // Servers declared in the manifest.
  const declared = [{ path: ".claude-plugin/plugin.json", content: json({ name: "demo", mcpServers: { notes: { command: "n" }, search: { command: "s" } } }) }];
  const d = contentDigest(declared);
  const stored = await nativePluginFolders(state, [{ pluginId: "plugin_a", digest: d }], serve(declared).fetchFiles);
  const views = join(state, "views");
  // No managed server yet: a view all the same (hooks are filtered too), with every server.
  const [first] = await nativePluginViews(views, stored, [{ pluginId: "plugin_a", digest: d, managedServers: [] }]);
  expect(first!.dir).toBe(join(views, "plugin_a"));
  expect(Object.keys(JSON.parse(await readFile(join(first!.dir, ".claude-plugin/plugin.json"), "utf8")).mcpServers)).toEqual(["notes", "search"]);
  // Registered since, same digest: left out at the next start, in a read-only view of its own.
  const [view] = await nativePluginViews(views, stored, [{ pluginId: "plugin_a", digest: d, managedServers: ["notes"] }]);
  expect(view!.dir).toBe(join(views, "plugin_a"));
  const manifest = (dir: string) => readFile(join(dir, ".claude-plugin/plugin.json"), "utf8").then((t) => Object.keys(JSON.parse(t).mcpServers));
  expect(await manifest(view!.dir)).toEqual(["search"]);
  await expect(writeFile(join(view!.dir, ".claude-plugin/plugin.json"), "x")).rejects.toThrow();
  expect(await manifest(stored[0]!.dir)).toEqual(["notes", "search"]);
  // A later start replaces the view whole.
  const [again] = await nativePluginViews(views, stored, [{ pluginId: "plugin_a", digest: d, managedServers: ["search"] }]);
  expect(await manifest(again!.dir)).toEqual(["notes"]);
  await unlock(views);
});

test("Codex's marketplace lists each plugin under its manifest's name at ./<id>, read-only; two names alike are refused", async () => {
  state = await mkdtemp(join(tmpdir(), "native-"));
  const { fetchFiles } = serve();
  const plain = [{ path: "skills/x/SKILL.md", content: Buffer.from("---\nname: x\ndescription: x\n---\n") }];
  const stored = [
    ...(await nativePluginFolders(state, [{ pluginId: "plugin_a", digest }], fetchFiles)),
    ...(await nativePluginFolders(state, [{ pluginId: "plugin_B", digest: contentDigest(plain) }], async () => plain)),
  ];
  const views = join(state, "views");
  const market = await codexMarketplace(views, stored);
  expect(market.names).toEqual(["demo", "dispand-plugin-b"]);
  expect(JSON.parse(await readFile(join(market.dir, "marketplace.json"), "utf8"))).toEqual({ name: "dispand", owner: { name: "Dispand" }, plugins: [{ name: "demo", source: "./plugin_a" }, { name: "dispand-plugin-b", source: "./plugin_B" }] });
  await expect(writeFile(join(market.dir, "marketplace.json"), "x")).rejects.toThrow();
  await unlock(views);
  await rm(views, { recursive: true, force: true });
  await expect(codexMarketplace(views, [stored[0]!, { pluginId: "plugin_c", dir: stored[0]!.dir }])).rejects.toThrow("both named demo");
  await unlock(views);
});

test("Codex's marketplace takes the name of the manifest Codex reads, and its own manifest is filtered too", async () => {
  state = await mkdtemp(join(tmpdir(), "native-"));
  const both = [
    { path: ".codex-plugin/plugin.json", content: Buffer.from(JSON.stringify({ name: "codex-name", mcpServers: { notes: { command: "x" }, kept: { command: "y" } } })) },
    { path: ".claude-plugin/plugin.json", content: Buffer.from('{"name":"claude-name"}') },
  ];
  const standard = [{ path: "plugin.json", content: Buffer.from('{"name":"standard-name"}') }];
  const stored = [
    ...(await nativePluginFolders(state, [{ pluginId: "plugin_a", digest: contentDigest(both) }], async () => both)),
    ...(await nativePluginFolders(state, [{ pluginId: "plugin_s", digest: contentDigest(standard) }], async () => standard)),
  ];
  const views = await nativePluginViews(join(state, "views"), stored, [{ pluginId: "plugin_a", digest: contentDigest(both), managedServers: ["notes"] }, { pluginId: "plugin_s", digest: contentDigest(standard) }]);
  expect(Object.keys(JSON.parse(await readFile(join(views[0]!.dir, ".codex-plugin", "plugin.json"), "utf8")).mcpServers)).toEqual(["kept"]);
  expect((await codexMarketplace(join(state, "views"), views)).names).toEqual(["codex-name", "standard-name"]);
  await unlock(join(state, "views"));
  // A root manifest declaring its schema comes before Codex's own.
  const schema = [{ path: "plugin.json", content: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "root-name" })) }, { path: ".codex-plugin/plugin.json", content: Buffer.from('{"name":"overlay-name"}') }];
  const s = await nativePluginFolders(state, [{ pluginId: "plugin_r", digest: contentDigest(schema) }], async () => schema);
  expect((await codexMarketplace(join(state, "views2"), s)).names).toEqual(["root-name"]);
  await unlock(join(state, "views2"));
});

test("a hook that could decide a permission is left out of every place a plugin declares hooks; the others stay", () => {
  const events = (deciding: string, other: string) => ({ [deciding]: [{ hooks: [{ type: "command", command: "allow" }] }], [other]: [{ hooks: [{ type: "command", command: "log" }] }] });
  const read = (out: { path: string; content: Buffer }[], path: string) => JSON.parse(out.find((f) => f.path === path)!.content.toString());
  const out = withoutDecidingHooks([
    { path: "hooks/hooks.json", content: json({ description: "d", hooks: events("PreToolUse", "PostToolUse") }) },
    { path: "hooks.json", content: json({ hooks: events("permissionRequest", "stop") }) },
    { path: ".claude-plugin/plugin.json", content: json({ name: "a", hooks: events("PermissionRequest", "SessionStart") }) },
    { path: ".codex-plugin/plugin.json", content: json({ name: "a", hooks: "./more/hooks.json" }) },
    { path: "more/hooks.json", content: json({ hooks: events("preToolUse", "userPromptSubmit") }) },
  ]);
  expect(read(out, "hooks/hooks.json")).toEqual({ description: "d", hooks: { PostToolUse: expect.any(Array) } });
  expect(Object.keys(read(out, "hooks.json").hooks)).toEqual(["stop"]);
  expect(Object.keys(read(out, ".claude-plugin/plugin.json").hooks)).toEqual(["SessionStart"]);
  expect(read(out, ".codex-plugin/plugin.json").hooks).toBe("./more/hooks.json");
  expect(Object.keys(read(out, "more/hooks.json").hooks)).toEqual(["userPromptSubmit"]);
});

test("a hooks declaration of a shape the filter doesn't read for sure is dropped whole; nothing else of the plugin is lost", () => {
  const out = withoutDecidingHooks([
    { path: "hooks/hooks.json", content: json([{ PreToolUse: [] }]) },
    { path: "hooks.json", content: Buffer.from("not json") },
    { path: ".claude-plugin/plugin.json", content: json({ name: "a", hooks: { PreToolUse: "allow" } }) },
    { path: "skills/x/SKILL.md", content: Buffer.from("x") },
  ]);
  expect(out.map((f) => f.path).sort()).toEqual([".claude-plugin/plugin.json", "skills/x/SKILL.md"]);
  expect(JSON.parse(out.find((f) => f.path === ".claude-plugin/plugin.json")!.content.toString())).toEqual({ name: "a" });
});

test("skills, commands and agents keep only the frontmatter that grants nothing; their bodies stay; an unreadable one is dropped", () => {
  const md = (text: string) => Buffer.from(text);
  const files = [
    { path: "skills/deploy/SKILL.md", content: md("---\nname: deploy\ndescription: Deploys.\nallowed-tools: Write, Bash\nhooks:\n  PreToolUse: []\nmodel: opus\n---\nDo it.\n") },
    { path: "commands/ship.md", content: md("\uFEFF---\ndescription: Ships\nargument-hint: <branch>\nallowed-tools: [Bash]\n---\nShip $ARGUMENTS\n") },
    { path: "agents/helper.md", content: md("---\nname: helper\ndescription: Helps\ntools: Write\npermissionMode: bypassPermissions\n---\nYou help.\n") },
    // Named by a manifest, anywhere in the plugin: the same rule.
    { path: "extra/where.md", content: md("---\nname: where\nallowed-tools: Write\n---\nBody\n") },
    { path: "skills/bad/SKILL.md", content: md("---\nname: [unclosed\n---\nBody\n") },
    { path: "skills/open/SKILL.md", content: md("---\nname: open\nallowed-tools: Write\n") },
    { path: "skills/list/SKILL.md", content: md("---\n- a\n---\nBody\n") },
    { path: "README.md", content: md("# No frontmatter\n---\nallowed-tools: Write\n") },
    { path: "scripts/run.sh", content: md("---\nallowed-tools: Write\n---\n") },
  ];
  const out = new Map(withoutGrantingFrontmatter(files).map((f) => [f.path, f.content.toString()]));
  expect(out.get("skills/deploy/SKILL.md")).toBe("---\nname: deploy\ndescription: Deploys.\n---\nDo it.\n");
  expect(out.get("commands/ship.md")).toBe("---\ndescription: Ships\nargument-hint: <branch>\n---\nShip $ARGUMENTS\n");
  expect(out.get("agents/helper.md")).toBe("---\nname: helper\ndescription: Helps\n---\nYou help.\n");
  expect(out.get("extra/where.md")).toBe("---\nname: where\n---\nBody\n");
  // Unreadable, unterminated or not a map: dropped.
  for (const path of ["skills/bad/SKILL.md", "skills/open/SKILL.md", "skills/list/SKILL.md"]) expect(out.has(path)).toBe(false);
  // No frontmatter, or not markdown: as it was.
  expect(out.get("README.md")).toBe("# No frontmatter\n---\nallowed-tools: Write\n");
  expect(out.get("scripts/run.sh")).toBe("---\nallowed-tools: Write\n---\n");
});

test("a manifest's skills, commands and agents stay only as paths; an inline one, with its allowedTools, is dropped", () => {
  const manifest = (value: object) => ({ path: ".claude-plugin/plugin.json", content: Buffer.from(JSON.stringify(value)) });
  const read = (value: object) => JSON.parse(withoutGrantingFrontmatter([manifest(value)])[0]!.content.toString()) as Record<string, unknown>;
  expect(read({ name: "p", commands: ["./extra/ship.md"], agents: "./agents", skills: ["./skills"] })).toEqual({ name: "p", commands: ["./extra/ship.md"], agents: "./agents", skills: ["./skills"] });
  expect(read({ name: "p", commands: { ship: { source: "./ship.md", allowedTools: ["Write"] } }, agents: [{ name: "a", tools: ["Write"] }], skills: { s: { content: "---\nallowed-tools: Write\n---\n" } } })).toEqual({ name: "p" });
});

test("for Codex, the Claude variables in every server and hook declaration lead to the plugin's mount and the working folder", () => {
  const values = { CLAUDE_PLUGIN_ROOT: "/run/plugins/plugin_a", CLAUDE_PROJECT_DIR: "/work/runs/r1" };
  const server = { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs", "--project", "${CLAUDE_PROJECT_DIR}"], env: { ROOT: "$CLAUDE_PLUGIN_ROOT", DATA: "${CLAUDE_PLUGIN_DATA}" }, cwd: "${CLAUDE_PLUGIN_ROOT}" };
  const hooks = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "$CLAUDE_PLUGIN_ROOT/hook.sh > $CLAUDE_PROJECT_DIR/out.txt" }] }] } };
  const out = withClaudeVariables([
    { path: ".mcp.json", content: json({ mcpServers: { a: server } }) },
    { path: ".claude-plugin/plugin.json", content: json({ name: "demo", mcpServers: "./servers.json", hooks: "./more-hooks.json" }) },
    { path: ".codex-plugin/plugin.json", content: json({ name: "demo", mcpServers: { b: server }, hooks: hooks.hooks }) },
    { path: "servers.json", content: json({ mcpServers: { c: server } }) },
    { path: "hooks/hooks.json", content: json(hooks) },
    { path: "more-hooks.json", content: json(hooks) },
    { path: "data/notes.json", content: json({ note: "${CLAUDE_PLUGIN_ROOT}" }) },
    { path: "commands/run.md", content: Buffer.from("Run ${CLAUDE_PLUGIN_ROOT}/x") },
  ], values);
  const read = (path: string) => JSON.parse(out.find((f) => f.path === path)!.content.toString());
  const expanded = { command: "node", args: ["/run/plugins/plugin_a/server.mjs", "--project", "/work/runs/r1"], env: { ROOT: "/run/plugins/plugin_a", DATA: "${CLAUDE_PLUGIN_DATA}" }, cwd: "/run/plugins/plugin_a" };
  expect(read(".mcp.json").mcpServers.a).toEqual(expanded);
  expect(read(".codex-plugin/plugin.json").mcpServers.b).toEqual(expanded);
  expect(read("servers.json").mcpServers.c).toEqual(expanded);
  const command = "/run/plugins/plugin_a/hook.sh > /work/runs/r1/out.txt";
  for (const path of ["hooks/hooks.json", "more-hooks.json"]) expect(read(path).hooks.UserPromptSubmit[0].hooks[0].command).toBe(command);
  expect(read(".codex-plugin/plugin.json").hooks.UserPromptSubmit[0].hooks[0].command).toBe(command);
  // A manifest's references to its server and hook files stay as the filters read them.
  const pointing = withClaudeVariables([{ path: ".codex-plugin/plugin.json", content: json({ name: "demo", mcpServers: "${CLAUDE_PLUGIN_ROOT}/other.json", hooks: ["${CLAUDE_PLUGIN_ROOT}/h.json"] }) }], values);
  expect(JSON.parse(pointing[0]!.content.toString())).toEqual({ name: "demo", mcpServers: "${CLAUDE_PLUGIN_ROOT}/other.json", hooks: ["${CLAUDE_PLUGIN_ROOT}/h.json"] });
  // Not a declaration: as it was. A longer name isn't one of these variables.
  expect(read("data/notes.json").note).toBe("${CLAUDE_PLUGIN_ROOT}");
  expect(out.find((f) => f.path === "commands/run.md")!.content.toString()).toBe("Run ${CLAUDE_PLUGIN_ROOT}/x");
  expect(JSON.parse(withClaudeVariables([{ path: ".mcp.json", content: json({ mcpServers: { a: { command: "$CLAUDE_PLUGIN_ROOTS/x" } } }) }], values)[0]!.content.toString()).mcpServers.a.command).toBe("$CLAUDE_PLUGIN_ROOTS/x");
});

test("only Codex's view has the variables expanded; Claude Code expands them itself", async () => {
  state = await mkdtemp(join(tmpdir(), "native-"));
  const declared = [{ path: ".mcp.json", content: json({ mcpServers: { a: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/s.mjs"] } } }) }];
  const d = contentDigest(declared);
  const stored = await nativePluginFolders(state, [{ pluginId: "plugin_a", digest: d }], serve(declared).fetchFiles);
  const views = join(state, "views");
  const args = async (codex?: { cwd: string }) => {
    const [view] = await nativePluginViews(views, stored, [{ pluginId: "plugin_a", digest: d }], codex);
    return JSON.parse(await readFile(join(view!.dir, ".mcp.json"), "utf8")).mcpServers.a.args;
  };
  expect(await args()).toEqual(["${CLAUDE_PLUGIN_ROOT}/s.mjs"]);
  expect(await args({ cwd: "/work/runs/r1" })).toEqual(["/run/plugins/plugin_a/s.mjs"]);
  await unlock(views);
});

test("a manifest's file reference is resolved as the CLIs resolve it, and dropped when it doesn't lead to a filtered file", () => {
  const servers = json({ mcpServers: { notes: { command: "n" }, kept: { command: "k" } } });
  for (const ref of ["./servers.json/", "servers.json//", ".//servers.json", "./sub/../servers.json", "${CLAUDE_PLUGIN_ROOT}/servers.json"]) {
    const out = withoutServers([{ path: ".codex-plugin/plugin.json", content: json({ name: "demo", mcpServers: ref }) }, { path: "servers.json", content: servers }], ["notes"]);
    const read = (path: string) => JSON.parse(out.find((f) => f.path === path)!.content.toString());
    expect(read(".codex-plugin/plugin.json").mcpServers, ref).toBe("./servers.json");
    expect(Object.keys(read("servers.json").mcpServers), ref).toEqual(["kept"]);
  }
  // Leading out of the plugin, to nothing, or to a file the filter dropped: the reference goes.
  for (const ref of ["../servers.json", "/servers.json", "missing.json", "./", "broken.json"]) {
    const out = withoutServers([{ path: ".codex-plugin/plugin.json", content: json({ name: "demo", mcpServers: [ref] }) }, { path: "broken.json", content: Buffer.from("[1,") }], ["notes"]);
    expect(JSON.parse(out.find((f) => f.path === ".codex-plugin/plugin.json")!.content.toString()), ref).toEqual({ name: "demo" });
  }
  // A list keeps only what resolves, as `./` paths.
  const both = withoutServers([{ path: ".claude-plugin/plugin.json", content: json({ name: "demo", mcpServers: ["./servers.json/", "../elsewhere.json"] }) }, { path: "servers.json", content: servers }], ["notes"]);
  expect(JSON.parse(both.find((f) => f.path === ".claude-plugin/plugin.json")!.content.toString()).mcpServers).toEqual(["./servers.json"]);
});

test("a hooks file reference resolves the same way; one to an unfiltered or missing file is dropped", () => {
  const hooks = json({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "allow" }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: "touch x" }] }] } });
  const out = withoutDecidingHooks([{ path: ".codex-plugin/plugin.json", content: json({ name: "a", hooks: ["./more/hooks.json/", "nowhere.json"] }) }, { path: "more/hooks.json", content: hooks }]);
  const read = (path: string) => JSON.parse(out.find((f) => f.path === path)!.content.toString());
  expect(read(".codex-plugin/plugin.json").hooks).toEqual(["./more/hooks.json"]);
  expect(Object.keys(read("more/hooks.json").hooks)).toEqual(["UserPromptSubmit"]);
});

test("a second manifest used as a server or hooks file loses the reference to it: only files the filter wrote are referenced", () => {
  // The root manifest names its own server file, and holds a managed server at its top level.
  const root = json({ name: "demo", mcpServers: ["./servers.json"], hooks: ["./h.json"], notes: { command: "managed" } });
  const out = withoutDecidingHooks(withoutServers([
    { path: ".claude-plugin/plugin.json", content: json({ name: "demo", mcpServers: "./plugin.json", hooks: "./plugin.json" }) },
    { path: "plugin.json", content: root },
    { path: "servers.json", content: json({ mcpServers: { notes: { command: "n" }, kept: { command: "k" } } }) },
    { path: "h.json", content: json({ hooks: { PreToolUse: [], Stop: [] } }) },
  ], ["notes"]));
  // No reference leads to the root manifest, which the filters left as it was.
  expect(read(out, ".claude-plugin/plugin.json")).toEqual({ name: "demo" });
  expect(read(out, "plugin.json").mcpServers).toEqual(["./servers.json"]);
  expect(Object.keys((read(out, "servers.json").mcpServers as object))).toEqual(["kept"]);
  expect(Object.keys((read(out, "h.json").hooks as object))).toEqual(["Stop"]);
});

test("for Codex, a plugin whose paths would grow past the store's cap once filled in is refused before its copy is built", () => {
  const values = { CLAUDE_PLUGIN_ROOT: "/run/plugins/plugin_a", CLAUDE_PROJECT_DIR: `/work/${"x".repeat(100_000)}` };
  const many = json({ mcpServers: { a: { command: "node", args: Array.from({ length: 200 }, () => "${CLAUDE_PROJECT_DIR}") } } });
  expect(() => withClaudeVariables([{ path: ".mcp.json", content: many }], values)).toThrow(/too large/);
  // A few are fine.
  const few = json({ mcpServers: { a: { command: "node", args: ["${CLAUDE_PROJECT_DIR}"] } } });
  expect(read(withClaudeVariables([{ path: ".mcp.json", content: few }], values), ".mcp.json")).toBeTruthy();
});

test("the check at use finds a managed server a CLI loaded from a native plugin, by each CLI's naming, and nothing else", () => {
  const plugins = [{ names: ["plugin_a", "demo"], managed: ["notes"] }];
  // Claude Code: `plugin:<plugin>:<server>` in its init message (`plugin_<plugin>_<server>` in tool names).
  expect(managedLoaded("claude-code", [{ name: "plugin:demo:kept" }, { name: "plugin:demo:notes" }], plugins)).toBe("plugin:demo:notes");
  expect(managedLoaded("claude-code", [{ name: "plugin_demo_notes" }], plugins)).toBe("plugin_demo_notes");
  expect(managedLoaded("claude-code", [{ name: "plugin:other:notes" }, { name: "notes" }, { name: "tool_abc" }], plugins)).toBeNull();
  // Codex: the server's name with its plugin's id, `<plugin>@<marketplace>`.
  expect(managedLoaded("codex", [{ name: "kept", pluginId: "demo@dispand" }, { name: "notes", pluginId: "demo@dispand" }], plugins)).toBe("notes");
  expect(managedLoaded("codex", [{ name: "notes", pluginId: null }, { name: "notes", pluginId: "other@dispand" }], plugins)).toBeNull();
});
