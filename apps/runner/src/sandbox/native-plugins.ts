// A conversation's native plugins in the container image: the files of each plugin its agent was
// granted, fetched from Dispand by the digest its start names, checked against that digest, and
// kept read-only under `<state>/native-plugins/<digest>`. A worker mounts only its own set.
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { z } from "zod";
import { checkFiles, PluginRefused, writeReadOnly } from "../plugin-servers.ts";
import { readCapped, unlock } from "../skills.ts";

type Files = { path: string; content: Buffer }[];
export type NativePluginRef = { pluginId: string; digest: string; managedServers?: string[] };
/** Fetches one plugin's files at `digest`; throws `PluginRefused` in the runner's words. */
export type FetchNative = (pluginId: string, digest: string) => Promise<Files>;

const Body = z.object({ files: z.array(z.object({ path: z.string().max(255), base64: z.base64() })).max(500) });

/** `GET <server>/runner/native-plugins/<id>?digest=` with the runner's token. Redirects refused, body capped. */
export function fetchNativePlugin(server: string, token: string): FetchNative {
  return async (pluginId, digest) => {
    let res: Response;
    try {
      res = await fetch(`${server}/runner/native-plugins/${encodeURIComponent(pluginId)}?digest=${encodeURIComponent(digest)}`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new PluginRefused(`can't reach ${server}: ${(err as Error).message}`);
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new PluginRefused(`Dispand refused the native plugin ${pluginId} (HTTP ${res.status})`);
    }
    try {
      return Body.parse(JSON.parse(await readCapped(res, 24 * 1024 * 1024))).files.map((f) => ({ path: f.path, content: Buffer.from(f.base64, "base64") }));
    } catch {
      throw new PluginRefused(`the native plugin ${pluginId} isn't readable or is too large`);
    }
  };
}

const storeOf = (stateDir: string) => join(stateDir, "native-plugins");

/**
 * The folders of a conversation's native plugins, one per plugin, each its digest's folder of the
 * store: kept from an earlier start, or fetched, checked (caps, paths, the digest the start named)
 * and written read-only first. Throws `PluginRefused` before anything is written for a plugin
 * that fails.
 */
export async function nativePluginFolders(stateDir: string, plugins: NativePluginRef[], fetchFiles: FetchNative): Promise<{ pluginId: string; dir: string }[]> {
  const out: { pluginId: string; dir: string }[] = [];
  for (const { pluginId, digest } of plugins) {
    const dir = join(storeOf(stateDir), digest.slice("sha256:".length));
    // Only ever written whole, after its digest was checked: an existing folder is that revision.
    if (await stat(dir).then(() => true, () => false)) {
      out.push({ pluginId, dir });
      continue;
    }
    const what = `The native plugin ${pluginId}`;
    const files = await fetchFiles(pluginId, digest);
    checkFiles(what, files);
    if (contentDigest(files) !== digest) throw new PluginRefused(`${what}'s files don't have the digest ${digest} its start named`);
    out.push({ pluginId, dir: await writeReadOnly(storeOf(stateDir), dir, files, what) });
  }
  return out;
}

/** Removes the whole store, at start: no conversation runs yet, and each start fetches its set again. */
export async function sweepNativePlugins(stateDir: string): Promise<void> {
  await unlock(storeOf(stateDir));
  await rm(storeOf(stateDir), { recursive: true, force: true });
}

/** Where a Claude plugin, or an Agent Plugins one, declares MCP servers: these files, and the manifests' `mcpServers`. */
const SERVER_FILES = [".mcp.json", "mcp.json"];
const MANIFESTS = [".claude-plugin/plugin.json", "plugin.json"];

/**
 * A `.mcp.json`-shaped value without `managed`, read both ways a CLI may read it: as the map of
 * servers itself, and as a wrapper `{ mcpServers: {…} }` (a server may be named `mcpServers`).
 * Not a JSON object: as it was.
 */
function withoutIn(value: unknown, managed: Set<string>): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const top = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([name]) => !managed.has(name)));
  const inner = top.mcpServers;
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) top.mcpServers = Object.fromEntries(Object.entries(inner).filter(([name]) => !managed.has(name)));
  return top;
}

/**
 * The plugin as a CLI loads it: its files, with every declaration of a server in `managed` left
 * out (`.mcp.json`, `mcp.json`, a manifest's inline `mcpServers` and the files it names). A file
 * that isn't JSON is kept as it is: no CLI reads a server from it either.
 */
export function withoutServers(files: Files, managed: string[]): Files {
  if (!managed.length) return files;
  const names = new Set(managed);
  const json = (f: { content: Buffer }): unknown => {
    try {
      return JSON.parse(f.content.toString("utf8"));
    } catch {
      return undefined;
    }
  };
  const targets = new Set(SERVER_FILES);
  const out = new Map(files.map((f) => [f.path, f.content]));
  for (const path of MANIFESTS) {
    const file = files.find((f) => f.path === path);
    const manifest = file && json(file);
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) continue;
    const declared = (manifest as Record<string, unknown>).mcpServers;
    // Files it names, as paths from the plugin's root (`./servers.json`).
    for (const item of [declared].flat()) if (typeof item === "string") targets.add(posix.normalize(item).replace(/^\.\//, ""));
    if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
      out.set(path, Buffer.from(JSON.stringify({ ...manifest, mcpServers: withoutIn(declared, names) }, null, 2)));
    } else if (Array.isArray(declared)) {
      out.set(path, Buffer.from(JSON.stringify({ ...manifest, mcpServers: declared.map((item) => (typeof item === "string" ? item : withoutIn(item, names))) }, null, 2)));
    }
  }
  for (const path of targets) {
    // From what is already filtered: a manifest may name itself as a server file.
    const content = out.get(path);
    const value = content && json({ content });
    if (value !== undefined) out.set(path, Buffer.from(JSON.stringify(withoutIn(value, names), null, 2)));
  }
  return [...out].map(([path, content]) => ({ path, content }));
}

async function readTree(dir: string): Promise<Files> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(entries.filter((e) => e.isFile()).map(async (e) => ({ path: relative(dir, join(e.parentPath, e.name)).split("\\").join("/"), content: await readFile(join(e.parentPath, e.name)) })));
}

/**
 * The folders a conversation's worker mounts: for a plugin with servers Dispand manages, a view
 * derived at each start from its stored files with those servers left out, written read-only
 * under `viewsDir` (the session's own, removed first); for one without, its stored folder.
 */
export async function nativePluginViews(viewsDir: string, folders: { pluginId: string; dir: string }[], refs: NativePluginRef[]): Promise<{ pluginId: string; dir: string }[]> {
  await unlock(viewsDir);
  await rm(viewsDir, { recursive: true, force: true });
  const out: { pluginId: string; dir: string }[] = [];
  for (const { pluginId, dir } of folders) {
    const managed = refs.find((r) => r.pluginId === pluginId)?.managedServers ?? [];
    if (!managed.length) {
      out.push({ pluginId, dir });
      continue;
    }
    out.push({ pluginId, dir: await writeReadOnly(viewsDir, join(viewsDir, pluginId), withoutServers(await readTree(dir), managed), `The native plugin ${pluginId}`) });
  }
  return out;
}
