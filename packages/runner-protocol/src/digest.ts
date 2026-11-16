// Node only (`node:crypto`): imported as `@dispand/runner-protocol/digest`, never from the index the web bundle reads.
import { createHash } from "node:crypto";

/** A plugin's stdio launch entry, as its `mcp.json` gives it (the standard's fields). */
export type PluginEntry = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };

/**
 * A plugin's content digest: `sha256:` and the hex SHA-256 of, for each file sorted by its
 * path's UTF-8 bytes, the path, a NUL, the length in decimal, a NUL, then the bytes. The runner
 * computes it over the files it was given, never taking the server's word; Dispand computes it
 * over the files it stores, to show the owner what to allow.
 */
export function contentDigest(files: { path: string; content: Uint8Array }[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const file of sorted) {
    hash.update(file.path).update("\0").update(String(file.content.length)).update("\0").update(file.content);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** The entry as one string: keys sorted, `args` in order, `env` keys sorted, absent parts as their defaults (`cwd` is `./`). */
export function canonicalEntry(entry: PluginEntry): string {
  const env = Object.fromEntries(Object.entries(entry.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ args: entry.args ?? [], command: entry.command, cwd: entry.cwd ?? "./", env });
}
