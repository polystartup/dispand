import { z } from "zod";
import { isSafeRelativePath } from "./paths.ts";
import { id, short, string } from "./bounds.ts";

export const PluginHarness = z.enum(["claude-code", "codex"]);
export const PluginName = id().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
// Never accept a runner-local path, credentials or git transport options from the server.
export const PluginSource = string(2048).url().refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
});
/** Stable source identity; a logical/display name alone never proves a matching install. */
export function nativeSourceKey(source: string, sourceRef: string, plugin: string, sourcePath = "."): string | undefined {
  if ((sourcePath !== "." && !isSafeRelativePath(sourcePath)) || !PluginSource.safeParse(source).success) return undefined;
  return JSON.stringify([source.replace(/\/$/, "").replace(/\.git$/, ""), sourceRef, plugin, ...(sourcePath === "." ? [] : [sourcePath])]);
}
export const WorkspacePluginFiles = z.array(z.object({ path: string(255), base64: string(2_796_204).base64() })).min(1).max(500)
  .refine((files) => files.reduce((sum, file) => sum + file.base64.length * 3 / 4 - (file.base64.endsWith("==") ? 2 : file.base64.endsWith("=") ? 1 : 0), 0) <= 8_388_608, "workspace package exceeds 8 MiB");
/** The digest input is independent of database/file iteration order. */
export function workspacePluginContent(files: { path: string; base64: string }[]): string {
  return JSON.stringify(files.map(({ path, base64 }) => [path, base64]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
}
const targets = z.array(PluginHarness).min(1).max(2).refine((v) => new Set(v).size === v.length, "duplicate target");
const mutation = { name: PluginName, targets, dryRun: z.boolean(), revision: id().min(1).optional() };
export const PluginOperation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("discover"), source: PluginSource, sourceRef: id().min(1).optional() }),
  z.object({ action: z.literal("add"), ...mutation, source: PluginSource, sourceRef: id().min(1).optional(), plugin: PluginName, sourcePath: string(255).refine((p) => p === "." || isSafeRelativePath(p)).optional() }),
  // Paths are package-relative files, never a server-selected local source directory.
  z.object({ action: z.literal("add-workspace"), ...mutation, files: WorkspacePluginFiles }),
  z.object({ action: z.literal("remove"), ...mutation }),
]).refine((v) => v.action !== "add" || v.sourcePath === undefined || /^[a-f0-9]{40}$/.test(v.sourceRef ?? ""), "folder selection requires an immutable commit")
  .refine((v) => !("dryRun" in v) || v.dryRun || v.revision !== undefined, "apply requires a preview revision");
export type PluginOperation = z.infer<typeof PluginOperation>;

export const PluginReport = z.object({
  targets: z.array(z.object({ harness: PluginHarness, available: z.boolean(), add: z.boolean(), remove: z.boolean() })).max(2).optional(),
  candidates: z.array(z.object({ name: PluginName, targets: z.array(PluginHarness).max(2), blocked: z.boolean() })).max(200).optional(),
  packages: z.array(z.object({ name: PluginName, namespace: PluginName.optional(), sourceKey: string(128).optional(), harness: PluginHarness, installed: z.boolean(), enabled: z.boolean().nullable(), pending: z.boolean() })).max(500).optional(),
  revision: id().min(1).optional(),
  blocked: z.boolean().optional(),
  changes: z.array(z.object({ name: PluginName, harness: PluginHarness.optional(), action: id().regex(/^[a-z_-]{1,40}$/) })).max(500).optional(),
  results: z.array(z.object({ name: PluginName, harness: PluginHarness.optional(), status: id().regex(/^[a-z_-]{1,40}$/) })).max(500).optional(),
  error: short().optional(),
});
export type PluginReport = z.infer<typeof PluginReport>;
