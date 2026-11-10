import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

/**
 * The permission boundary every session runs inside, whatever the owner answers from
 * Dispand: file edits stay inside the session's working directory, minus any `.claude/` and
 * `.mcp.json` in it (they decide what later sessions run without asking) and whatever those, or
 * the CLI's user settings and hooks, link to. Everything else is denied
 * without asking: by a PreToolUse hook (the authority, every tool call in every permission
 * mode), again in `canUseTool`, and by settings. "Always allow" only adds to the session's own
 * rules. Bash is not a file tool: each command still asks the owner. The runner keeps its own
 * config and the CLI's user config out of every working directory (`config.ts`).
 */
const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

export const PROTECTED_DENIAL =
  "Dispand sessions may only edit files inside the session's working directory, outside its .claude/ and .mcp.json.";

/** The real path of `path`: symlinks followed, a final dangling one too; for a path that doesn't exist, its nearest existing parent's real path plus the rest. */
export function realOf(path: string, hops = 0): string {
  try {
    return realpathSync(path);
  } catch {
    // A dangling symlink: where it points is what a write would create.
    try {
      if (hops < 40) return realOf(resolve(dirname(path), readlinkSync(path)), hops + 1);
    } catch {
      // Not a symlink: it doesn't exist yet.
    }
    const parent = dirname(path);
    return parent === path ? path : join(realOf(parent, hops), path.slice(parent.length));
  }
}

export const inside = (path: string, tree: string) => path === tree || path.startsWith(tree.endsWith(sep) ? tree : tree + sep);

/** Past this many entries walked in protected trees, every edit is denied rather than half-checked. */
const MAX_WALK = 1000;
/** Past this many directories searched for `.claude` and `.mcp.json` in the working tree, every edit is denied. */
const MAX_SEARCH = 10_000;
/** Searched for nothing: dependencies and git internals hold no config of the project's own. */
const UNSEARCHED = new Set(["node_modules", ".git"]);

/** A path with a `.claude` segment, or a `.mcp.json`: a project's Claude Code config. */
export const isConfigPath = (path: string) => path.split(sep).includes(".claude") || basename(path) === ".mcp.json";

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Every `.claude` and `.mcp.json` in the working tree (never through a symlinked directory), or null past the search budget. */
function configsIn(realCwd: string): string[] | null {
  const found: string[] = [];
  const dirs = [realCwd];
  for (let searched = 0; dirs.length > 0; searched++) {
    if (searched >= MAX_SEARCH) return null;
    const dir = dirs.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name === ".claude" || entry.name === ".mcp.json") found.push(path);
      else if (entry.isDirectory() && !UNSEARCHED.has(entry.name)) dirs.push(path);
    }
  }
  return found;
}

/** The CLI's user config the agent must not reach through links: its settings files, hooks and `.claude.json`. */
function userConfigRoots(home: string, env: NodeJS.ProcessEnv): string[] {
  const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return [
    ...list(dir)
      .filter((name) => /^settings[^/]*\.json$/.test(name))
      .map((name) => join(dir, name)),
    join(dir, "hooks"),
    join(dir, ".claude.json"),
    join(home, ".claude.json"),
  ];
}

/**
 * The real locations of the protected roots and the transitive closure of the symlinks inside
 * them (every link's real target, walked in turn; each real directory once). Null when that is
 * more than `limit` entries to walk.
 */
function protectedLocations(roots: string[], limit = MAX_WALK): string[] | null {
  const locations: string[] = [];
  const visited = new Set<string>();
  let seen = 0;
  const walk = (path: string): boolean => {
    if (++seen > limit) return false;
    let entry;
    try {
      entry = lstatSync(path);
    } catch {
      return true;
    }
    if (entry.isSymbolicLink()) {
      const target = realOf(path);
      locations.push(target);
      return walk(target);
    }
    if (!entry.isDirectory() || visited.has(path)) return true;
    visited.add(path);
    for (const name of list(path)) if (!walk(join(path, name))) return false;
    return true;
  };
  for (const root of roots) {
    const real = realOf(root);
    locations.push(real);
    if (!walk(real)) return null;
  }
  return locations;
}

/**
 * File tools that read: each reads only inside the session folder, or the CLI user config dir's
 * `plugins/cache`, `plugins/marketplaces` and `skills/` (skills read their own supporting files
 * there; no credentials, settings, hooks or plugin state live there). An allowlist: anything else is denied.
 */
/**
 * Every file tool the boundary decides, and the input fields that name what it touches (from the
 * CLI's tool schemas): one resolver turns them into real paths for reads and edits alike.
 * LSP isn't here: it can follow imports anywhere, so it always asks the owner.
 */
export const TOOL_SHAPES: Record<string, { kind: "edit" | "read"; path: string; pattern?: string; pathOptional?: boolean }> = {
  Edit: { kind: "edit", path: "file_path" },
  Write: { kind: "edit", path: "file_path" },
  MultiEdit: { kind: "edit", path: "file_path" },
  NotebookEdit: { kind: "edit", path: "notebook_path" },
  Read: { kind: "read", path: "file_path" },
  NotebookRead: { kind: "read", path: "notebook_path" },
  Grep: { kind: "read", path: "path", pattern: "glob", pathOptional: true },
  Glob: { kind: "read", path: "path", pattern: "pattern", pathOptional: true },
};
/** Tools that read files but whose reach the runner can't bound: always the owner's call. */
const ASK_READ_TOOLS = new Set(["LSP"]);

export const READ_DENIAL =
  "Dispand sessions read files only inside the session folder (and the CLI's plugins/cache, plugins/marketplaces and skills/).";
export const READ_ASK =
  "Dispand can't tell which files this would touch (a path that is not plain, or braces or .. in a pattern): the owner decides.";

/**
 * Whether the CLI would take `p` exactly as written, so the runner decides on the same path:
 * no leading or trailing whitespace (the CLI trims), no control character, `~` only as `~` or
 * `~/…`, and already normalized (no `.`, `..` or empty segments). Anything else goes to the owner.
 */
export function canonical(p: string, home: string): boolean {
  if (p !== p.trim() || [...p].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return false;
  if (p.startsWith("~") && p !== "~" && !p.startsWith("~/")) return false;
  const expanded = p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p;
  return expanded !== "." && normalize(expanded) === expanded;
}

/** A glob's fixed leading part (before any wildcard), or null if the runner can't follow it (braces, `..` past a wildcard). */
function staticPrefix(pattern: string): string | null {
  if (pattern.includes("{")) return null;
  const parts = pattern.split("/");
  const first = parts.findIndex((p) => /[*?[]/.test(p));
  if (first === -1) return pattern;
  if (parts.slice(first).includes("..")) return null;
  return parts.slice(0, first).join("/") || (pattern.startsWith("/") ? "/" : ".");
}

/**
 * The CLI's current directory, which relative paths are against: the hook's `cwd`; null when it
 * isn't known (canUseTool), so relative paths are asked; omitted, the session folder (tests, and
 * callers that know the CLI hasn't moved).
 */
type Current = string | null | undefined;

export type PermissionBoundary = {
  /** Settings for the session's highest user-controlled layer: defence in depth behind the hook. */
  settings(allowBypass: boolean): {
    permissions: { deny: string[]; blockWritesOutsideWorkingDirectories: true; disableBypassPermissionsMode?: "disable" };
  };
  /** Whether a tool call is a file edit the boundary refuses, whoever approves it. */
  deniedEdit(toolName: string, toolInput: Record<string, unknown>, current?: Current): boolean;
  /** For a file-editing tool: "deny" (outside the folder or into its config), "ask" for an input that isn't plain, "allow" otherwise; "n/a" for any other tool. */
  editDecision(toolName: string, toolInput: Record<string, unknown>, current?: Current): "allow" | "deny" | "ask" | "n/a";
  /**
   * For a file-reading tool: "allow" if every path it would read is inside the session folder or
   * the CLI's plugin code and skills/, "deny" otherwise, "ask" if the runner can't tell; "n/a" for
   * any other tool.
   */
  readDecision(toolName: string, toolInput: Record<string, unknown>, current?: Current): "allow" | "deny" | "ask" | "n/a";
  /** The SDK's suggestions for "always allow", limited to this session and to what can't widen the boundary. */
  sessionUpdates(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[];
};

/**
 * The boundary for a session in `cwd`, decided at each call from real paths, so symlinks made
 * during the session count. `home` and `env` locate the CLI's user config (`CLAUDE_CONFIG_DIR`).
 */
export function permissionBoundary(
  cwd: string,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  /** More trees reads may reach: the session's own skill packages (`skills.ts`), never editable. */
  readRoots: string[] = [],
): PermissionBoundary {
  const userConfig = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  // `~` and `~/…` as the CLI expands them; `~user` isn't followed (it stays outside).
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
  /**
   * The one resolver for reads and edits: the real paths a tool call would touch (its path field,
   * the cwd when an optional one is missing, a glob's fixed prefix), "ask" when its input isn't
   * plain (a missing or non-string path, a path that isn't canonical, a glob the runner can't
   * follow), "n/a" for a tool the boundary doesn't decide.
   */
  const targetsOf = (
    toolName: string,
    input: Record<string, unknown>,
    current: string | null | undefined,
  ): { kind: "edit" | "read"; paths: string[] } | "ask" | "n/a" => {
    const shape = TOOL_SHAPES[toolName];
    if (!shape) return "n/a";
    const path = input[shape.path];
    const pattern = shape.pattern ? input[shape.pattern] : undefined;
    if (path === undefined ? !shape.pathOptional : typeof path !== "string") return "ask";
    if (pattern !== undefined && typeof pattern !== "string") return "ask";
    if ([path, pattern].some((p) => typeof p === "string" && !canonical(p, home))) return "ask";
    const given = expand((path as string | undefined) ?? ".");
    // Relative paths are the CLI's: against its current directory (it may have `cd`'d), which must
    // be plain and inside the session folder; unknown (null), only absolute paths are decided.
    let from = cwd;
    if (!isAbsolute(given)) {
      if (current === null) return "ask";
      if (current !== undefined) {
        if (!isAbsolute(current) || !canonical(current, home) || !inside(realOf(current), realOf(cwd))) return "ask";
        from = current;
      }
    }
    const base = resolve(from, given);
    const paths = [base];
    if (typeof pattern === "string") {
      const prefix = staticPrefix(expand(pattern));
      if (prefix === null) return "ask";
      paths.push(resolve(base, prefix));
    }
    return { kind: shape.kind, paths: paths.map((p) => realOf(p)) };
  };
  return {
    settings: (allowBypass) => {
      const real = realOf(cwd);
      return {
        permissions: {
          // `//` starts an absolute path in a rule.
          deny: FILE_TOOLS.flatMap((t) => [`${t}(/${real}/.claude/**)`, `${t}(/${real}/.mcp.json)`]),
          blockWritesOutsideWorkingDirectories: true,
          ...(allowBypass ? {} : { disableBypassPermissionsMode: "disable" as const }),
        },
      };
    },
    deniedEdit(toolName, toolInput, current) {
      return this.editDecision(toolName, toolInput, current) === "deny";
    },
    editDecision(toolName, toolInput, current) {
      const t = targetsOf(toolName, toolInput, current);
      if (t === "n/a" || (t !== "ask" && t.kind !== "edit")) return "n/a";
      if (t === "ask") return "ask";
      const real = t.paths[0]!;
      const realCwd = realOf(cwd);
      if (!inside(real, realCwd)) return "deny";
      // A `.claude` or `.mcp.json` at any depth: a later session started there would load it.
      if (isConfigPath(relative(realCwd, real))) return "deny";
      const configs = configsIn(realCwd);
      const locations = configs && protectedLocations([join(realCwd, ".claude"), join(realCwd, ".mcp.json"), ...configs, ...userConfigRoots(home, env)]);
      return locations === null || locations.some((location) => inside(real, location)) ? "deny" : "allow";
    },
    readDecision(toolName, toolInput, current) {
      if (ASK_READ_TOOLS.has(toolName)) return "ask";
      const t = targetsOf(toolName, toolInput, current);
      if (t === "n/a" || (t !== "ask" && t.kind !== "read")) return "n/a";
      if (t === "ask") return "ask";
      // Plugins' code (cache, marketplaces), never their own state (data, store) or lists.
      const allowed = [cwd, join(userConfig, "plugins", "cache"), join(userConfig, "plugins", "marketplaces"), join(userConfig, "skills"), ...readRoots].map((p) =>
        realOf(p),
      );
      return t.paths.every((real) => allowed.some((root) => inside(real, root))) ? "allow" : "deny";
    },
    sessionUpdates: (suggestions = []) =>
      suggestions.flatMap((u): PermissionUpdate[] => {
        // Removing or replacing rules could lift a deny rule, more directories would widen the
        // boundary, and bypass or auto would stop asking the owner.
        if (u.type === "removeRules" || u.type === "replaceRules" || u.type === "addDirectories" || u.type === "removeDirectories") return [];
        if (u.type === "setMode" && !["default", "acceptEdits", "plan"].includes(u.mode)) return [];
        return [{ ...u, destination: "session" }];
      }),
  };
}

/**
 * What a Codex session may neither read nor write: each of `secrets` (`machineConfigPaths`) as
 * given, its real path, and wherever a symlink inside it leads (followed transitively). Walked
 * whole, once per session: a CLI's home grows with its history, and a cap would refuse sessions.
 */
export function codexDenied(secrets: string[]): string[] {
  return [...new Set([...secrets, ...protectedLocations(secrets, Infinity)!])];
}

/**
 * The part of `denied` (`codexDenied`) Codex's sandbox is asked to hide. The sandbox mounts an
 * empty read-only folder or file over each entry, and fails the whole session on one it can't
 * mount, so the list is cut to what it can and needs to hide:
 * - an entry inside another entry is left out: the outer one hides it already, and nothing can
 *   be mounted inside a folder that was just made read-only (a link inside Codex's home that
 *   points back into it);
 * - only folders, regular files and paths that don't exist are kept: a socket or a device holds
 *   no config and no credential, and Codex keeps its own sockets in a folder it hides itself;
 * - the Codex executable is left out (a running Codex links to itself from its home): it isn't a
 *   secret, and the sandbox must be able to run it.
 * File changes are still checked against the whole list (`codexDeniedEdit`).
 */
export function sandboxDenied(denied: string[], codexPath: string): string[] {
  const executable = realOf(codexPath);
  const real = new Map(denied.map((path) => [path, realOf(path)]));
  const mountable = (path: string) => {
    try {
      const entry = lstatSync(real.get(path)!);
      return entry.isDirectory() || entry.isFile();
    } catch {
      // Doesn't exist (yet): hidden by name.
      return true;
    }
  };
  const kept = denied.filter((path) => real.get(path) !== executable && mountable(path));
  return kept.filter((path) => !kept.some((other) => other !== path && real.get(other) !== real.get(path) && inside(real.get(path)!, real.get(other)!)));
}

/** What a Codex session's folder holds that decides how later Codex sessions there behave: its config, skills and instructions. */
const CODEX_CONFIG = new Set([".codex", ".agents", "AGENTS.md", "AGENTS.override.md"]);

/**
 * Whether a Codex file change to `path` (absolute, or against `cwd`) is refused, whoever approves
 * it: its real path is outside the session folder, inside a `.codex`, `.agents`, `AGENTS.md` or
 * `AGENTS.override.md` at any depth of it, or inside one of `denied` (`codexDenied`).
 */
export function codexDeniedEdit(cwd: string, path: string, denied: string[]): boolean {
  const real = realOf(resolve(cwd, path));
  const realCwd = realOf(cwd);
  if (!inside(real, realCwd)) return true;
  if (relative(realCwd, real).split(sep).some((segment) => CODEX_CONFIG.has(segment))) return true;
  return denied.some((location) => inside(real, realOf(location)));
}
