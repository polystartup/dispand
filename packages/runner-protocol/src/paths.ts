/** Longest path a skill package may hold, in characters. */
export const MAX_PATH_LENGTH = 255;
/** Deepest path a skill package may hold, in segments. */
export const MAX_PATH_SEGMENTS = 10;

/**
 * Segments the runner's permission boundary treats as the CLI's project config (`apps/runner/src/boundary.ts`
 * `isConfigPath`): a file under one decides what later sessions run. Compared without case, since
 * macOS file systems ignore it.
 */
const CONFIG_SEGMENTS = new Set([".claude", ".mcp.json"]);

/**
 * Whether `p` is a path a skill package may hold, the one rule for the server (import, storage)
 * and the runner (writing it under its session folder): POSIX and relative (no leading `/`, no
 * `\`), every segment non-empty and neither `.` nor `..`, no control character (NUL included) or
 * lone surrogate, no `.claude` or `.mcp.json` segment, at most 255 characters and 10 segments.
 */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > MAX_PATH_LENGTH || !p.isWellFormed()) return false;
  if (p.includes("\\") || [...p].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return false;
  const segments = p.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) return false;
  return segments.every((s) => s !== "" && s !== "." && s !== ".." && !CONFIG_SEGMENTS.has(s.toLowerCase()));
}

/**
 * Whether `p` is a path a plugin's native revision may hold: a safe relative path
 * (`isSafeRelativePath`), or the plugin root's own `.mcp.json`, where a Claude plugin declares its
 * servers. A native revision is only ever mounted read-only as the plugin's own folder, never in a
 * workspace, so that file is the plugin's and no project's. Anywhere else, the rule stays.
 */
export function isNativePluginPath(p: string): boolean {
  return p === ".mcp.json" || isSafeRelativePath(p);
}

/** Longest path a memory entry may have, in characters. */
export const MAX_MEMORY_PATH_LENGTH = 120;

/** File names a CLI loads as instructions from any folder it reads: never a memory entry's. Compared without case. */
const INSTRUCTION_FILES = new Set(["claude.md", "agents.md", "agents.override.md"]);

/**
 * Whether `p` is a path a memory entry may have, the one rule for the server (every write) and
 * the runner (writing the entry under its session folder): a safe relative path
 * (`isSafeRelativePath`) of at most 120 characters, ending in `.md`, with no segment a CLI loads
 * as instructions (`CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md`, in any case), and not
 * `MEMORY.md`, the name of a scope's index among the runner's files (in any case too).
 */
export function isMemoryPath(p: string): boolean {
  if (p.length > MAX_MEMORY_PATH_LENGTH || !isSafeRelativePath(p) || !p.endsWith(".md")) return false;
  if (p.toLowerCase() === "memory.md") return false;
  return p.split("/").every((s) => !INSTRUCTION_FILES.has(s.toLowerCase()));
}

/** Where a session's chat attachments go, relative to its run folder. */
export const ATTACHMENTS_DIR = ".dispand/attachments";

/** Segments a CLI reads as configuration or instructions wherever they sit: never one of an attachment's path. */
const CONTROL_SEGMENTS = new Set([...CONFIG_SEGMENTS, ...INSTRUCTION_FILES, ".codex"]);

/**
 * Where a chat attachment goes in the run folder: `.dispand/attachments/<attachment id>/file<.ext>`,
 * every part made by Dispand. The original name gives only its extension (letters and digits, at
 * most 16), so no name a person or an agent chose reaches the file system.
 */
export function attachmentPath(attachmentId: string, name: string): string {
  const ext = /\.([A-Za-z0-9]{1,16})$/.exec(name)?.[1]?.toLowerCase();
  return `${ATTACHMENTS_DIR}/${attachmentId}/file${ext ? `.${ext}` : ""}`;
}

/**
 * Whether `p` is a path a chat attachment may have, the one rule for the server (before it names
 * one to a runner) and the runner (before it writes one): `.dispand/attachments/<id>/<name>` with
 * plain segments (`isSafeRelativePath`), and no segment a CLI reads as configuration or
 * instructions (`.claude`, `.codex`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md`,
 * in any case), as the memory path rule refuses.
 */
export function isAttachmentPath(p: string): boolean {
  if (!isSafeRelativePath(p) || !/^\.dispand\/attachments\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9]{1,16})?$/.test(p)) return false;
  return p.split("/").every((s) => !CONTROL_SEGMENTS.has(s.toLowerCase()));
}
