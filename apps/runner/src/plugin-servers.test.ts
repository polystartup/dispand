import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { canonicalEntry, contentDigest, type PluginEntry } from "./plugin-digest.ts";
import { materializePlugin, pluginLaunch, PluginRefused } from "./plugin-servers.ts";
import { unlock } from "./skills.ts";

const files = () => [
  { path: "bin/server", content: Buffer.from("#!/bin/sh\necho hi\n") },
  { path: "mcp.json", content: Buffer.from("{}") },
  { path: "plugin.json", content: Buffer.from('{"name":"law"}') },
];
const entry: PluginEntry = { command: "./bin/server", args: ["--root", "${PLUGIN_ROOT}"], env: { MODE: "fast", DATA: "${PLUGIN_DATA}/db" } };
const allowed = (over: Partial<PluginEntry> = {}) => ({ allowedPlugins: [{ name: "law", digest: contentDigest(files()), entry: { ...entry, ...over } }] });

const hex = () => contentDigest(files()).slice("sha256:".length);

let state: string;
beforeEach(async () => {
  state = await realpath(await mkdtemp(join(tmpdir(), "plugin-")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await unlock(state);
  await rm(state, { recursive: true, force: true });
});

test("the digest is stable across file order and changes with one byte", () => {
  expect(contentDigest(files().reverse())).toBe(contentDigest(files()));
  expect(contentDigest(files())).toMatch(/^sha256:[0-9a-f]{64}$/);
  const altered = files();
  altered[1]!.content = Buffer.from("{ }");
  expect(contentDigest(altered)).not.toBe(contentDigest(files()));
  // Sorted by UTF-8 bytes: U+FF5E sorts before U+1F600 in UTF-16, after it in UTF-8.
  const a = { path: "\u{ff5e}", content: Buffer.from("a") };
  const b = { path: "\u{1f600}", content: Buffer.from("b") };
  expect(contentDigest([a, b])).toBe(contentDigest([b, a]));
});

test("the canonical entry sorts keys and fills defaults", () => {
  expect(canonicalEntry({ command: "x", env: { B: "1", A: "2" } })).toBe(canonicalEntry({ cwd: "./", env: { A: "2", B: "1" }, args: [], command: "x" }));
  expect(canonicalEntry({ command: "x", args: ["a", "b"] })).not.toBe(canonicalEntry({ command: "x", args: ["b", "a"] }));
});

test("an allowed plugin launches from its materialized root, with both variables set last", async () => {
  const launch = await pluginLaunch(allowed({ env: { ...entry.env, PLUGIN_ROOT: "/elsewhere" } }), state, "law", files(), { ...entry, env: { ...entry.env, PLUGIN_ROOT: "/elsewhere" } });
  const root = join(state, "plugins", "law", hex());
  const data = join(state, "plugin-data", "law");
  expect(launch).toEqual({ command: join(root, "bin/server"), args: ["--root", root], env: { MODE: "fast", DATA: `${data}/db`, PLUGIN_ROOT: root, PLUGIN_DATA: data }, cwd: root });
  expect(await readFile(join(root, "mcp.json"), "utf8")).toBe("{}");
  await expect(writeFile(join(root, "mcp.json"), "x")).rejects.toThrow();
});

test("refuses content altered under an unchanged claimed digest", async () => {
  const altered = files();
  altered[0]!.content = Buffer.from("#!/bin/sh\nrm -rf ~\n");
  await expect(pluginLaunch(allowed(), state, "law", altered, entry)).rejects.toThrow(/have the digest sha256:[0-9a-f]+, not sha256:/);
  await expect(readFile(join(state, "plugins"))).rejects.toThrow();
});

test("refuses an entry that gained an argument", async () => {
  await expect(pluginLaunch(allowed(), state, "law", files(), { ...entry, args: [...entry.args!, "--evil"] })).rejects.toThrow(/launch entry of the plugin law isn't/);
});

test("refuses a changed env value", async () => {
  await expect(pluginLaunch(allowed(), state, "law", files(), { ...entry, env: { ...entry.env, MODE: "slow" } })).rejects.toThrow(PluginRefused);
});

test("refuses a record of another name", async () => {
  await expect(pluginLaunch(allowed(), state, "other", files(), entry)).rejects.toThrow(/No record on this runner allows the plugin "other"/);
});

test("expands only in args, env values and cwd: a variable in command or an env key stays as written", async () => {
  const odd: PluginEntry = { command: "${PLUGIN_ROOT}", args: ["${PLUGIN_DATA}${PLUGIN_ROOT}"], env: { "${PLUGIN_ROOT}": "v" }, cwd: "${PLUGIN_DATA}" };
  const launch = await pluginLaunch(allowed(odd), state, "law", files(), odd);
  const root = join(state, "plugins", "law", hex());
  const data = join(state, "plugin-data", "law");
  expect(launch.command).toBe("${PLUGIN_ROOT}");
  expect(launch.args).toEqual([`${data}${root}`]);
  expect(launch.env["${PLUGIN_ROOT}"]).toBe("v");
  expect(launch.cwd).toBe(data);
});

test("a cwd leaving the root and the data folder, or a command path not starting with ./, is refused", async () => {
  const out = { ...entry, cwd: "./../.." };
  await expect(pluginLaunch(allowed(out), state, "law", files(), out)).rejects.toThrow(/working directory/);
  const path = { ...entry, command: "bin/server" };
  await expect(pluginLaunch(allowed(path), state, "law", files(), path)).rejects.toThrow(/neither one name/);
});

test("PLUGIN_DATA survives a new digest", async () => {
  const first = await pluginLaunch(allowed(), state, "law", files(), entry);
  await writeFile(join(first.env.PLUGIN_DATA!, "kept"), "yes");
  const next = [...files(), { path: "README.md", content: Buffer.from("v2") }];
  const second = await pluginLaunch({ allowedPlugins: [{ name: "law", digest: contentDigest(next), entry }] }, state, "law", next, entry);
  expect(second.env.PLUGIN_ROOT).not.toBe(first.env.PLUGIN_ROOT);
  expect(await readFile(join(second.env.PLUGIN_DATA!, "kept"), "utf8")).toBe("yes");
});

test("a ./ command that is a link out of the root is refused", async () => {
  const root = await materializePlugin(state, "law", files());
  await chmod(join(root, "bin"), 0o755);
  await rm(join(root, "bin", "server"));
  await symlink("/bin/sh", join(root, "bin", "server"));
  await expect(pluginLaunch(allowed(), state, "law", files(), entry)).rejects.toThrow(/isn't a file inside the plugin/);
  const escape = { ...entry, command: "./../../../../bin/sh" };
  await expect(pluginLaunch(allowed(escape), state, "law", files(), escape)).rejects.toThrow(/isn't a file inside the plugin/);
});

test("materializing refuses unsafe paths and reuses a complete folder", async () => {
  await expect(materializePlugin(state, "law", [{ path: "../x", content: Buffer.from("") }])).rejects.toThrow(PluginRefused);
  await expect(materializePlugin(state, "law", [{ path: "a", content: Buffer.from("") }, { path: "a/b", content: Buffer.from("") }])).rejects.toThrow(PluginRefused);
  await expect(materializePlugin(state, "../law", files())).rejects.toThrow(PluginRefused);
  const [one, two] = await Promise.all([materializePlugin(state, "law", files()), materializePlugin(state, "law", files())]);
  expect(one).toBe(two);
});
