import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { afterEach, expect, test } from "vitest";
import { nativePluginFolders, sweepNativePlugins, type FetchNative } from "./native-plugins.ts";

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
