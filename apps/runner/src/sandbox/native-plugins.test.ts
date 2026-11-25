import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { afterEach, expect, test } from "vitest";
import { unlock } from "../skills.ts";
import { nativePluginFolders, nativePluginViews, sweepNativePlugins, withoutServers, type FetchNative } from "./native-plugins.ts";

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
  expect(await readdir(join(state, "native-plugins")).catch(() => [])).toEqual([]);
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
  expect(read(out, ".claude-plugin/plugin.json").mcpServers).toEqual(["./servers.json", { inline: { command: "i" } }]);
  expect(Object.keys(read(out, "servers.json"))).toEqual(["linked"]);
  expect(read(out, "plugin.json").mcpServers).toEqual({});
  expect(out.find((f) => f.path === "skills/a/SKILL.md")!.content.toString()).toBe("notes");
  // A server named `mcpServers` hides no managed sibling, whichever way a CLI reads the map.
  const odd = withoutServers([{ path: ".claude-plugin/plugin.json", content: json({ mcpServers: { mcpServers: { notes: { command: "n" } }, notes: { command: "n" }, kept: { command: "k" } } }) }], ["notes"]);
  expect(read(odd, ".claude-plugin/plugin.json").mcpServers).toEqual({ mcpServers: {}, kept: { command: "k" } });
  // A manifest that names itself as a server file keeps its own filtering.
  const self = withoutServers([{ path: ".claude-plugin/plugin.json", content: json({ mcpServers: ["./.claude-plugin/plugin.json", { notes: { command: "n" }, kept: { command: "k" } }] }) }], ["notes"]);
  expect(JSON.stringify(read(self, ".claude-plugin/plugin.json"))).not.toContain('"notes"');
  // Nothing managed: the files as they are.
  expect(withoutServers(plugin, [])).toBe(plugin);
});

test("a view is derived at each start from the stored files, which stay as they are", async () => {
  state = await mkdtemp(join(tmpdir(), "native-"));
  // `.mcp.json` never reaches a runner (a config segment): servers in the manifest, as Dispand stores them.
  const declared = [{ path: ".claude-plugin/plugin.json", content: json({ name: "demo", mcpServers: { notes: { command: "n" }, search: { command: "s" } } }) }];
  const d = contentDigest(declared);
  const stored = await nativePluginFolders(state, [{ pluginId: "plugin_a", digest: d }], serve(declared).fetchFiles);
  const views = join(state, "views");
  // No managed server yet: the stored folder itself.
  expect(await nativePluginViews(views, stored, [{ pluginId: "plugin_a", digest: d, managedServers: [] }])).toEqual(stored);
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
