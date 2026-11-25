// A conversation's native plugins in the container image: the files of each plugin its agent was
// granted, fetched from Dispand by the digest its start names, checked against that digest, and
// kept read-only under `<state>/native-plugins/<digest>`. A worker mounts only its own set.
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { isNativePluginPath } from "@dispand/runner-protocol";
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
    // Its root `.mcp.json` too: the plugin's own server declarations, filtered by `withoutServers`.
    checkFiles(what, files, isNativePluginPath);
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
const MANIFESTS = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A manifest's `mcpServers` naming server files only (a path, or a list of them). */
const namesFiles = (v: unknown) => typeof v === "string" || (Array.isArray(v) && v.every((d) => typeof d === "string"));

/** A map of server name to its declaration (an object), without `managed`; anything else: null. */
function serverMap(value: unknown, managed: Set<string>): Record<string, unknown> | null {
  if (!isObject(value) || Object.values(value).some((v) => !isObject(v))) return null;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !managed.has(name)));
}

/**
 * A server file (`.mcp.json`'s shape) without `managed`, or null when its shape isn't one this
 * filter reads for sure, and the file is dropped: the wrapper `{ mcpServers: map }` (other keys
 * kept only when no CLI could read them as servers) or the map itself. A wrapper inside the
 * wrapper (`mcpServers.mcpServers`) is no guess either.
 */
function serverFile(value: unknown, managed: Set<string>): unknown {
  if (!isObject(value)) return null;
  // A managed server named `mcpServers` can't be told from the wrapper: no guess.
  if (managed.has("mcpServers") && "mcpServers" in value) return null;
  if (!("mcpServers" in value)) return serverMap(value, managed);
  const inner = value.mcpServers;
  if (isObject(inner) && "mcpServers" in inner) return null;
  if (Object.entries(value).some(([key, v]) => key !== "mcpServers" && isObject(v))) return null;
  const map = serverMap(inner, managed);
  return map && { ...value, mcpServers: map };
}

/**
 * The plugin as a CLI loads it: its files, with every declaration of a server in `managed` left
 * out (`.mcp.json`, `mcp.json`, a manifest's inline `mcpServers` and the files it names). Fails
 * closed: a declaration of a shape this filter doesn't read for sure (not JSON, an array, a
 * wrapper in a wrapper) is dropped whole, and the rest of the plugin kept, so a managed server
 * never reaches the CLI by a form the filter missed.
 */
export function withoutServers(files: Files, managed: string[]): Files {
  if (!managed.length) return files;
  const names = new Set(managed);
  const json = (content: Buffer): unknown => {
    try {
      // As Claude Code reads it: a byte-order mark ignored.
      return JSON.parse(content.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      return undefined;
    }
  };
  const targets = new Set(SERVER_FILES);
  const out = new Map(files.map((f) => [f.path, f.content]));
  for (const path of MANIFESTS) {
    const content = out.get(path);
    const manifest = content && json(content);
    if (!isObject(manifest) || !("mcpServers" in manifest)) continue;
    const declared = manifest.mcpServers;
    // Files it names, as paths from the plugin's root (`./servers.json`): filtered below.
    for (const item of [declared].flat()) if (typeof item === "string") targets.add(posix.normalize(item).replace(/^\.\//, ""));
    if (namesFiles(declared)) continue;
    const kept = serverFile(declared, names);
    const next: Record<string, unknown> = { ...manifest, mcpServers: kept };
    if (kept === null) delete next.mcpServers;
    out.set(path, Buffer.from(JSON.stringify(next, null, 2)));
  }
  for (const path of targets) {
    const content = out.get(path);
    if (!content) continue;
    const value = json(content);
    // A manifest naming itself was read above: its `mcpServers` names files, and declares none.
    // Any other file at a manifest's path (a bare server map) is filtered as a server file.
    if (MANIFESTS.includes(path) && isObject(value) && namesFiles(value.mcpServers)) continue;
    const kept = serverFile(value, names);
    if (kept === null) out.delete(path);
    else out.set(path, Buffer.from(JSON.stringify(kept, null, 2)));
  }
  return [...out].map(([path, content]) => ({ path, content }));
}

/** Where a plugin declares hooks: these files, and the manifests' `hooks`. */
const HOOK_FILES = ["hooks/hooks.json", "hooks.json"];
/** Hook events that can answer for a permission (both CLIs, any case): the broker alone decides. */
const DECIDING_HOOKS = new Set(["pretooluse", "permissionrequest"]);

/** An event map (event → list) without the deciding events, or null when its shape isn't one this filter reads for sure. */
function hookMap(value: unknown): Record<string, unknown> | null {
  if (!isObject(value) || Object.values(value).some((v) => !Array.isArray(v))) return null;
  return Object.fromEntries(Object.entries(value).filter(([event]) => !DECIDING_HOOKS.has(event.toLowerCase())));
}

/** A hooks file (`{ hooks: map }`, other keys kept only when not objects) without the deciding events, or null to drop it. */
function hookFile(value: unknown): unknown {
  if (!isObject(value) || !("hooks" in value)) return null;
  if (Object.entries(value).some(([key, v]) => key !== "hooks" && isObject(v))) return null;
  const map = hookMap(value.hooks);
  return map && { ...value, hooks: map };
}

/**
 * The plugin without any hook that can decide a permission (`PreToolUse`, `PermissionRequest`):
 * its other hooks run in the worker, but approving a CLI's action stays the permission broker's.
 * In `hooks/hooks.json`, a root `hooks.json`, a manifest's inline `hooks` and the files it names.
 * Fails closed like `withoutServers`: a declaration of a shape this filter doesn't read for sure is
 * dropped whole, the rest of the plugin kept.
 */
export function withoutDecidingHooks(files: Files): Files {
  const json = (content: Buffer): unknown => {
    try {
      return JSON.parse(content.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      return undefined;
    }
  };
  const targets = new Set(HOOK_FILES);
  const out = new Map(files.map((f) => [f.path, f.content]));
  for (const path of MANIFESTS) {
    const content = out.get(path);
    const manifest = content && json(content);
    if (!isObject(manifest) || !("hooks" in manifest)) continue;
    const declared = manifest.hooks;
    if (namesFiles(declared)) {
      for (const item of [declared].flat()) targets.add(posix.normalize(item as string).replace(/^\.\//, ""));
      continue;
    }
    // Inline: the file's form or the event map itself.
    const kept = isObject(declared) && "hooks" in declared ? hookFile(declared) : hookMap(declared);
    const next: Record<string, unknown> = { ...manifest, hooks: kept };
    if (kept === null) delete next.hooks;
    out.set(path, Buffer.from(JSON.stringify(next, null, 2)));
  }
  for (const path of targets) {
    const content = out.get(path);
    if (!content) continue;
    const value = json(content);
    // A manifest naming hooks files was read above.
    if (MANIFESTS.includes(path) && isObject(value) && namesFiles(value.hooks)) continue;
    const kept = hookFile(value);
    if (kept === null) out.delete(path);
    else out.set(path, Buffer.from(JSON.stringify(kept, null, 2)));
  }
  return [...out].map(([path, content]) => ({ path, content }));
}

async function readTree(dir: string): Promise<Files> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(entries.filter((e) => e.isFile()).map(async (e) => ({ path: relative(dir, join(e.parentPath, e.name)).split("\\").join("/"), content: await readFile(join(e.parentPath, e.name)) })));
}

/**
 * The folders a conversation's worker mounts: each plugin's view, derived at each start from its
 * stored files with the servers Dispand manages and the hooks that could decide a permission left
 * out, written read-only under `viewsDir` (the session's own, removed first).
 */
export async function nativePluginViews(viewsDir: string, folders: { pluginId: string; dir: string }[], refs: NativePluginRef[]): Promise<{ pluginId: string; dir: string }[]> {
  await unlock(viewsDir);
  await rm(viewsDir, { recursive: true, force: true });
  const out: { pluginId: string; dir: string }[] = [];
  for (const { pluginId, dir } of folders) {
    const managed = refs.find((r) => r.pluginId === pluginId)?.managedServers ?? [];
    const files = withoutDecidingHooks(withoutServers(await readTree(dir), managed));
    out.push({ pluginId, dir: await writeReadOnly(viewsDir, join(viewsDir, pluginId), files, `The native plugin ${pluginId}`) });
  }
  return out;
}

/** Where Codex finds a conversation's marketplace in its worker: its plugins' folder (`NATIVE_PLUGINS`) is its root. */
export const CODEX_MARKETPLACE = "/run/plugins/.claude-plugin/marketplace.json";

/**
 * For Codex, which installs plugins from a marketplace: one listing the conversation's plugins,
 * each under its manifest's name at `./<plugin id>`, written read-only as `<viewsDir>/.claude-plugin`
 * (mounted beside them). Its plugins' names, or a refusal when two share one or one has none Codex takes.
 */
export async function codexMarketplace(viewsDir: string, plugins: { pluginId: string; dir: string }[]): Promise<{ dir: string; names: string[] }> {
  const entries: { name: string; source: string }[] = [];
  for (const { pluginId, dir } of plugins) {
    // The manifest Codex reads (0.169): a root one declaring its `$schema` first, then its own,
    // then a Claude plugin's, then a root one without.
    const read = (path: string) => readFile(join(dir, path), "utf8").then((t) => { try { return JSON.parse(t.replace(/^\uFEFF/, "")) as { name?: unknown; $schema?: unknown }; } catch { return {}; } }, () => undefined);
    const root = await read("plugin.json");
    let manifest: { name?: unknown } = {};
    for (const found of [typeof root?.$schema === "string" ? root : undefined, await read(".codex-plugin/plugin.json"), await read(".claude-plugin/plugin.json"), root]) {
      if (found === undefined) continue;
      manifest = found;
      break;
    }
    // Without a manifest, a name made from its id: lowercase words, as Codex names plugins.
    const name = typeof manifest.name === "string" ? manifest.name : `dispand-${pluginId.toLowerCase().replace(/_/g, "-")}`;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new PluginRefused(`The native plugin ${pluginId}'s name can't be installed in Codex.`);
    if (entries.some((e) => e.name === name)) throw new PluginRefused(`Two native plugins of this conversation are both named ${name}: Codex installs only one plugin per name.`);
    entries.push({ name, source: `./${pluginId}` });
  }
  const content = Buffer.from(JSON.stringify({ name: "dispand", owner: { name: "Dispand" }, plugins: entries }));
  const dir = await writeReadOnly(viewsDir, join(viewsDir, ".claude-plugin"), [{ path: "marketplace.json", content }], "This conversation's plugin list");
  return { dir, names: entries.map((e) => e.name) };
}
