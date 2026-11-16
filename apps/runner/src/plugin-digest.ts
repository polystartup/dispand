import { createHash } from "node:crypto";
import type { z } from "zod";
import type { PluginEntry as Entry } from "./config.ts";

export type PluginEntry = z.infer<typeof Entry>;

/**
 * A plugin's content digest: `sha256:` and the hex SHA-256 of, for each file sorted by its
 * path's UTF-8 bytes, the path, a NUL, the length in decimal, a NUL, then the bytes. Computed by
 * the runner over the files it was given, never taken from the server.
 */
export function contentDigest(files: { path: string; content: Buffer }[]): string {
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
