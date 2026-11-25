import { posix } from "node:path";
import { contentDigest } from "@dispand/runner-protocol/digest";
import type { PluginFile } from "./runner-servers.ts";

// What a plugin's native revision runs, for the screens a manager approves it on: its hooks and its
// stdio servers, read from the declarations the runner's filter reads (`apps/runner/src/sandbox/
// native-plugins.ts`: the same files and shapes), and the plugin's files they point at.

/** One thing on the screen: a hook's command, a server's launch, a file it runs, or a declaration that can't be read. */
export type NativeEntry = { key: string; kind: "hook" | "server" | "file" | "unreadable" | "declaration" | "instructions"; label: string; text: string | null };

const SERVER_FILES = [".mcp.json", "mcp.json"];
const HOOK_FILES = ["hooks/hooks.json", "hooks.json"];
const MANIFESTS = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"];
/** Hook events the runner leaves out of every copy (the broker alone decides permissions): they never run. */
const DECIDING_HOOKS = new Set(["pretooluse", "permissionrequest"]);

const MAX_SHOWN_TEXT = 20_000;

/** A file as a screen shows it: its text, cut, or its size when it isn't text; null when there is none. */
export function shownFile(content: Uint8Array | undefined): string | null {
  if (content === undefined) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    // Cut, and said so: the screen's token covers the whole file all the same.
    return text.length > MAX_SHOWN_TEXT ? `${text.slice(0, MAX_SHOWN_TEXT)}\n… (${text.length - MAX_SHOWN_TEXT} more characters)` : text;
  } catch {
    return `(${content.length} bytes, not text)`;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const namesFiles = (v: unknown) => typeof v === "string" || (Array.isArray(v) && v.every((d) => typeof d === "string"));

/** A path from the plugin's root, as the CLIs resolve a reference to one; null outside it. */
function reference(item: string): string | null {
  const path = posix.normalize(item.replace(/^["']|["']$/g, "").replace(/^\$\{?CLAUDE_PLUGIN_ROOT\}?\//, "")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return path && path !== "." && path !== ".." && !path.startsWith("../") && !posix.isAbsolute(path) ? path : null;
}

function json(content: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(content).replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

/**
 * What the revision `files` runs natively: each hook command (by event and matcher), each server's
 * launch (its command and arguments, its environment's names only, never their values) and the
 * plugin's files those name. A declaration file of a shape the runner doesn't read is listed as
 * unreadable (the runner drops it). In a stable order, so two revisions compare entry by entry.
 */
export function nativeCode(files: PluginFile[] | undefined): NativeEntry[] {
  return readNative(files).entries;
}

/** The entries, and every declaration file read (never shown raw: their values may hold credentials). */
function readNative(files: PluginFile[] | undefined): { entries: NativeEntry[]; declarations: Set<string> } {
  if (!files?.length) return { entries: [], declarations: new Set() };
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const out: NativeEntry[] = [];
  const named = new Set<string>();
  const nameFiles = (...strings: unknown[]) => {
    for (const s of strings) if (typeof s === "string") for (const word of s.split(/\s+/)) { const p = reference(word); if (p && byPath.has(p)) named.add(p); }
  };
  const serverMap = (where: string, map: unknown) => {
    if (!isObject(map) || Object.values(map).some((s) => !isObject(s))) return false;
    for (const [name, s] of Object.entries(map as Record<string, Record<string, unknown>>)) {
      // Only a stdio server runs in the worker; one reached by URL is on the screen's servers already.
      if (typeof s.command !== "string") continue;
      const args = Array.isArray(s.args) ? s.args.map(String) : [];
      const launch = [s.command, ...args].join(" ");
      const env = isObject(s.env) ? Object.keys(s.env).sort() : [];
      out.push({ key: `server:${where}:${name}`, kind: "server", label: name, text: [launch, ...(typeof s.cwd === "string" ? [`cwd: ${s.cwd}`] : []), ...(env.length ? [`env: ${env.join(", ")}`] : [])].join("\n") });
      nameFiles(s.command, ...args, s.cwd);
    }
    return true;
  };
  const serverFile = (where: string, value: unknown) => (isObject(value) && "mcpServers" in value ? serverMap(where, value.mcpServers) : serverMap(where, value));
  const hookMap = (where: string, map: unknown) => {
    if (!isObject(map) || Object.values(map).some((v) => !Array.isArray(v))) return false;
    for (const [event, groups] of Object.entries(map)) {
      if (DECIDING_HOOKS.has(event.toLowerCase())) continue;
      (groups as unknown[]).forEach((group, i) => {
        const matcher = isObject(group) && typeof group.matcher === "string" && group.matcher ? ` (${group.matcher})` : "";
        const hooks = isObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
        hooks.forEach((h, j) => {
          if (!isObject(h) || typeof h.command !== "string") return;
          out.push({ key: `hook:${where}:${event}:${i}:${j}`, kind: "hook", label: `${event}${matcher}`, text: h.command });
          nameFiles(h.command);
        });
      });
    }
    return true;
  };
  const hookFile = (where: string, value: unknown) => (isObject(value) && "hooks" in value ? hookMap(where, value.hooks) : false);
  const unreadable = (path: string) => out.push({ key: `unreadable:${path}`, kind: "unreadable", label: path, text: null });
  const serverTargets = new Set(SERVER_FILES);
  const hookTargets = new Set(HOOK_FILES);
  for (const path of MANIFESTS) {
    const content = byPath.get(path);
    const manifest = content && json(content);
    if (!isObject(manifest)) continue;
    for (const [key, targets, read] of [["mcpServers", serverTargets, serverFile], ["hooks", hookTargets, (w: string, v: unknown) => (isObject(v) && "hooks" in v ? hookFile(w, v) : hookMap(w, v))]] as const) {
      if (!(key in manifest)) continue;
      const declared = manifest[key];
      if (namesFiles(declared)) for (const item of [declared].flat() as string[]) { const found = reference(item); if (found) targets.add(found); }
      else if (!read(path, declared)) unreadable(`${path} (${key})`);
    }
  }
  for (const [targets, read, key] of [[serverTargets, serverFile, "mcpServers"], [hookTargets, hookFile, "hooks"]] as const) {
    for (const path of targets) {
      const content = byPath.get(path);
      if (!content) continue;
      const value = json(content);
      if (MANIFESTS.includes(path) && isObject(value) && namesFiles(value[key])) continue;
      if (!read(path, value)) unreadable(path);
    }
  }
  const declarations = new Set([...serverTargets, ...hookTargets, ...MANIFESTS].filter((p) => byPath.has(p)));
  for (const path of [...named].sort()) if (!declarations.has(path)) out.push({ key: `file:${path}`, kind: "file", label: path, text: shownFile(byPath.get(path)) });
  return { entries: out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), declarations };
}

/**
 * A native revision against the pinned one (`before`), as a screen shows it: what each runs, and,
 * when there is a pinned one, every other file that differs (a server may import any of them).
 * `changed` compares the whole revisions (their digests), `digest` is the new one's: the token covers it.
 */
/** Skills', commands' and agents' markdown: its text is on the screen's other sections already. */
const isMarkdown = (path: string) => path.toLowerCase().endsWith(".md");

export function nativeReview(before: PluginFile[] | undefined, after: PluginFile[] | undefined) {
  const digest = (f: PluginFile[] | undefined) => (f?.length ? contentDigest(f) : null);
  const { entries: was, declarations: wasDeclared } = readNative(before);
  const { entries: now, declarations } = readNative(after);
  // Markdown no hook or server names: listed by path only (its text is on the screen's other sections).
  const runs = new Set([...was, ...now].filter((e) => e.kind === "file").map((e) => e.label).concat([...wasDeclared, ...declarations]));
  const instructions = (path: string) => isMarkdown(path) && !runs.has(path);
  if (before?.length) {
    const a = new Map(before.map((f) => [f.path, f.content]));
    const b = new Map((after ?? []).map((f) => [f.path, f.content]));
    const same = (x?: Uint8Array, y?: Uint8Array) => !!x && !!y && Buffer.from(x).equals(Buffer.from(y));
    for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      if (same(a.get(path), b.get(path))) continue;
      if (instructions(path)) {
        if (a.has(path)) was.push({ key: `instructions:${path}`, kind: "instructions", label: path, text: "before" });
        if (b.has(path)) now.push({ key: `instructions:${path}`, kind: "instructions", label: path, text: "after" });
        continue;
      }
      // A declaration that changed: said so, never with its raw text (its values may be credentials).
      if (declarations.has(path) || wasDeclared.has(path)) {
        if (a.has(path)) was.push({ key: `declaration:${path}`, kind: "declaration", label: path, text: "before" });
        if (b.has(path)) now.push({ key: `declaration:${path}`, kind: "declaration", label: path, text: "after" });
        continue;
      }
      if (now.some((e) => e.key === `file:${path}`) || was.some((e) => e.key === `file:${path}`)) continue;
      if (a.has(path)) was.push({ key: `file:${path}`, kind: "file", label: path, text: shownFile(a.get(path)) });
      if (b.has(path)) now.push({ key: `file:${path}`, kind: "file", label: path, text: shownFile(b.get(path)) });
    }
  }
  // Any change to the revision counts, whatever its files are named: nothing is carved out.
  return { before: was, after: now, changed: digest(before) !== digest(after), digest: digest(after) };
}
