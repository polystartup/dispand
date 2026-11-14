import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What an update's screen shows of what changed: the plugin's own words for its new version, when
// it has a changelog that names it. Plain text: the screen never renders it as markup.

/** A changelog read at most: past this, it isn't read. */
const MAX_CHANGELOG = 256 * 1024;
/** A section shown at most. */
const MAX_SECTION = 10_000;

const bare = (version: string) => version.trim().replace(/^v/i, "");

/** A heading's level (1 to 6) and text, or null for a line that isn't one. */
function heading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  return m ? { level: m[1]!.length, text: m[2]! } : null;
}

/** Whether a heading names this version: as a whole word, a leading v or brackets around it allowed. */
function names(text: string, version: string): boolean {
  const escaped = bare(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s\\[(])v?${escaped}($|[\\s\\]),:])`, "i").test(text);
}

/** The changelog's section for `version`: its heading and the lines up to the next heading of the same level or above, cut to what a screen shows. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const h = heading(line);
    return h !== null && names(h.text, version);
  });
  if (start < 0) return null;
  const level = heading(lines[start]!)!.level;
  let end = lines.findIndex((line, i) => {
    const h = i > start ? heading(line) : null;
    return h !== null && h.level <= level;
  });
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join("\n").trim().slice(0, MAX_SECTION);
}

/** A plugin's `CHANGELOG.md` at its root, as a regular file of a readable size; null otherwise. */
export function readChangelog(root: string): string | null {
  const path = join(root, "CHANGELOG.md");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_CHANGELOG) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    return null;
  }
}
