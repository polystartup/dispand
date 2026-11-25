// A conversation's native plugins in the container image: the files of each plugin its agent was
// granted, fetched from Dispand by the digest its start names, checked against that digest, and
// kept read-only under `<state>/native-plugins/<digest>`. A worker mounts only its own set.
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { isNativePluginPath } from "@dispand/runner-protocol";
import { z } from "zod";
import { checkFiles, PluginRefused, writeReadOnly } from "../plugin-servers.ts";
import { parse, stringify } from "yaml";
import { FRONTMATTER, readCapped, unlock } from "../skills.ts";
import { NATIVE_PLUGINS } from "./worker.ts";

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

/**
 * A manifest's file reference as a path from the plugin's root, resolved the way the CLIs do
 * (`./`, `${CLAUDE_PLUGIN_ROOT}/`, duplicate and trailing slashes), or null when it leaves the
 * plugin or names nothing.
 */
function reference(item: string): string | null {
  const path = posix.normalize(item.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, "")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return path && path !== "." && path !== ".." && !path.startsWith("../") && !posix.isAbsolute(path) ? path : null;
}

/**
 * The manifests with their references to `key`'s files (`mcpServers`, `hooks`) kept only where
 * they lead to a file the filters read, written as `./<that path>`: a reference to anything else is
 * dropped, so no CLI loads a declaration that wasn't filtered.
 */
function checkedReferences(out: Map<string, Buffer>, key: "mcpServers" | "hooks"): void {
  for (const path of MANIFESTS) {
    const content = out.get(path);
    let manifest: unknown;
    try {
      manifest = content && JSON.parse(content.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    if (!isObject(manifest) || !namesFiles(manifest[key])) continue;
    const kept = [manifest[key]].flat().flatMap((item) => {
      const found = reference(item as string);
      // Written as both CLIs require a reference: from the plugin's root, with `./`.
      return found && out.has(found) ? [`./${found}`] : [];
    });
    const next: Record<string, unknown> = { ...manifest, [key]: typeof manifest[key] === "string" ? kept[0] : kept };
    if (!kept.length) delete next[key];
    out.set(path, Buffer.from(JSON.stringify(next, null, 2)));
  }
}

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
    for (const item of [declared].flat()) if (typeof item === "string") { const found = reference(item); if (found) targets.add(found); }
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
  checkedReferences(out, "mcpServers");
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
      for (const item of [declared].flat()) { const found = reference(item as string); if (found) targets.add(found); }
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
  checkedReferences(out, "hooks");
  return [...out].map(([path, content]) => ({ path, content }));
}

/** The frontmatter keys that grant nothing: what a CLI needs to list a skill, command or agent and show it. */
const KEPT_KEYS = ["name", "description", "argument-hint"];
/** A manifest's keys that declare skills, commands or agents. */
const COMPONENT_KEYS = ["commands", "agents", "skills"];

/**
 * The plugin with every markdown file's frontmatter reduced to `KEPT_KEYS` (string values only),
 * its body as it is: a skill's, command's or agent's `allowed-tools`, `hooks`, `model` or any other
 * key never reaches a CLI, so none pre-approves a tool past the permission broker, wherever a
 * manifest puts the file. Fails closed: a file that opens a frontmatter this can't read is dropped.
 */
export function withoutGrantingFrontmatter(files: Files): Files {
  return files.flatMap((f) => {
    // A manifest's components only as paths, which this rule then reads: inline ones (with their
    // own `allowedTools` or frontmatter) are dropped. A manifest it can't read is left to the CLI.
    if (MANIFESTS.includes(f.path)) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(f.content.toString("utf8").replace(/^\uFEFF/, ""));
      } catch {
        return [f];
      }
      if (!isObject(manifest)) return [f];
      const next = { ...manifest };
      for (const key of COMPONENT_KEYS) if (key in next && !namesFiles(next[key])) delete next[key];
      return [{ path: f.path, content: Buffer.from(JSON.stringify(next, null, 2)) }];
    }
    if (!f.path.toLowerCase().endsWith(".md")) return [f];
    const text = f.content.toString("utf8").replace(/^\uFEFF/, "");
    if (!text.startsWith("---")) return [f];
    const match = FRONTMATTER.exec(text);
    let meta: unknown;
    try {
      meta = match ? parse(match[1]!) : undefined;
    } catch {
      return [];
    }
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return [];
    const kept = Object.fromEntries(KEPT_KEYS.flatMap((k) => (typeof (meta as Record<string, unknown>)[k] === "string" ? [[k, (meta as Record<string, string>)[k]!.replace(/\s+/g, " ").trim()]] : [])));
    return [{ path: f.path, content: Buffer.from(`---\n${stringify(kept, { lineWidth: 0 })}---\n${text.slice(match![0].length)}`) }];
  });
}

/** The variables Claude Code expands in a plugin's server and hook declarations, and Codex doesn't. */
const CLAUDE_VARIABLES = /\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}|\$(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)(?![A-Za-z0-9_])/g;

/**
 * For Codex (0.169 keeps them literal): the plugin with `${CLAUDE_PLUGIN_ROOT}` and
 * `${CLAUDE_PROJECT_DIR}` (and their `$NAME` forms) replaced, in every string of the files that
 * declare servers or hooks (`.mcp.json`, `mcp.json`, the hooks files, the manifests, and the files
 * they name), by the plugin's read-only mount and the session's working folder. Others stay literal.
 */
export function withClaudeVariables(files: Files, values: { CLAUDE_PLUGIN_ROOT: string; CLAUDE_PROJECT_DIR: string }): Files {
  const parsed = (content: Buffer): unknown => {
    try {
      return JSON.parse(content.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      return undefined;
    }
  };
  const targets = new Set([...SERVER_FILES, ...HOOK_FILES, ...MANIFESTS]);
  for (const path of MANIFESTS) {
    const manifest = files.find((f) => f.path === path);
    const value = manifest && parsed(manifest.content);
    if (!isObject(value)) continue;
    for (const key of ["mcpServers", "hooks"]) if (namesFiles(value[key])) for (const item of [value[key]].flat()) { const found = reference(item as string); if (found) targets.add(found); }
  }
  const expand = (value: unknown): unknown =>
    typeof value === "string" ? value.replace(CLAUDE_VARIABLES, (_, braced, bare) => values[(braced ?? bare) as keyof typeof values])
    : Array.isArray(value) ? value.map(expand)
    : isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]))
    : value;
  return files.map((f) => {
    const value = targets.has(f.path) ? parsed(f.content) : undefined;
    // Not JSON: left as it is (the filters before this one dropped what they couldn't read).
    if (value === undefined) return f;
    const next = expand(value);
    // A manifest's references to server or hook files stay as they were: the filters read those
    // files, and Codex must load the same ones.
    if (MANIFESTS.includes(f.path) && isObject(value) && isObject(next)) for (const key of ["mcpServers", "hooks"]) if (namesFiles(value[key])) next[key] = value[key];
    // Compact: no indentation can grow a nested file past the size it was checked at.
    return { path: f.path, content: Buffer.from(JSON.stringify(next)) };
  });
}

async function readTree(dir: string): Promise<Files> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(entries.filter((e) => e.isFile()).map(async (e) => ({ path: relative(dir, join(e.parentPath, e.name)).split("\\").join("/"), content: await readFile(join(e.parentPath, e.name)) })));
}

/**
 * The folders a conversation's worker mounts: each plugin's view, derived at each start from its
 * stored files with the servers Dispand manages, the hooks that could decide a permission and every
 * frontmatter key that could grant a tool left out, written read-only under `viewsDir` (the session's own, removed first).
 */
export async function nativePluginViews(viewsDir: string, folders: { pluginId: string; dir: string }[], refs: NativePluginRef[], codex?: { cwd: string }): Promise<{ pluginId: string; dir: string }[]> {
  await unlock(viewsDir);
  await rm(viewsDir, { recursive: true, force: true });
  const out: { pluginId: string; dir: string }[] = [];
  for (const { pluginId, dir } of folders) {
    const managed = refs.find((r) => r.pluginId === pluginId)?.managedServers ?? [];
    const kept = withoutGrantingFrontmatter(withoutDecidingHooks(withoutServers(await readTree(dir), managed)));
    // Codex runs it from the worker's mount of this view, where these paths lead.
    const files = codex ? withClaudeVariables(kept, { CLAUDE_PLUGIN_ROOT: `${NATIVE_PLUGINS}/${pluginId}`, CLAUDE_PROJECT_DIR: codex.cwd }) : kept;
    out.push({ pluginId, dir: await writeReadOnly(viewsDir, join(viewsDir, pluginId), files, `The native plugin ${pluginId}`) });
  }
  return out;
}

/** Where Codex finds a conversation's marketplace in its worker: its plugins' folder (`NATIVE_PLUGINS`) is its root. */
export const CODEX_MARKETPLACE = `${NATIVE_PLUGINS}/.claude-plugin/marketplace.json`;

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
