import { createHash } from "node:crypto";
import { nativeSourceKey, workspacePluginContent } from "@dispand/runner-protocol";

export function workspaceNativeKey(files: { path: string; base64: string }[]): string {
  return `workspace:${createHash("sha256").update(workspacePluginContent(files)).digest("hex")}`;
}

export function pluginNativeKey(plugin: { url: string | null; sha: string | null; entryName: string | null; nativeRoot: string | null }): string | undefined {
  const identity = plugin.nativeRoot === "." && plugin.url && plugin.sha && plugin.entryName ? nativeSourceKey(plugin.url, plugin.sha, plugin.entryName) : undefined;
  return identity ? createHash("sha256").update(identity).digest("hex") : undefined;
}
