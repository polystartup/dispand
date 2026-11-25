import { PluginServer } from "@dispand/runner-protocol";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agentNativePlugins, agents, harnesses, pluginFiles, pluginNativeFiles, plugins, tools } from "../db/schema.ts";
import { stored } from "../messages/index.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";

// A standard plugin's stdio server as a runner tool (`plugins/servers.ts` adds it): Dispand keeps
// the plugin's files and sends the runner a `plugin` reference; the runner fetches the files, and
// starts the server only when its own record holds the digest it computes over them.

export type PluginFile = { path: string; content: Uint8Array };

const traces = tracer("plugins");
const counts = meter("plugins");

/** Replaces a plugin's kept files with `files` (none: it keeps none) and returns their digest, for `plugins.digest`. */
export async function storePluginFiles(tx: Tx, pluginId: string, files: PluginFile[] | undefined): Promise<string | null> {
  await tx.delete(pluginFiles).where(eq(pluginFiles.pluginId, pluginId));
  if (!files?.length) return null;
  await tx.insert(pluginFiles).values(files.map((f) => ({ pluginId, path: f.path, content: f.content })));
  return contentDigest(files);
}

/**
 * Whether this install or update moves the plugin's native revision: a person's own call (the
 * `manager` check passed on their role), or a Job's call that makes a proposal item a person
 * approved (`approvedBy`, whose role `manager` re-checks). A Job's own call never does, whatever
 * its person's role: the revision it leaves behind keeps running until a manager approves the new one.
 */
export function movesNativePin(context: { job?: unknown; approvedBy?: string }): boolean {
  return !context.job || !!context.approvedBy;
}

/**
 * Replaces the plugin's native files with these, and gives their content digest: the plugin's new
 * native revision (`plugins.native_digest`). None (a plugin too large for a runner): null.
 */
export async function storeNativeFiles(tx: Tx, pluginId: string, files: PluginFile[] | undefined): Promise<string | null> {
  await tx.delete(pluginNativeFiles).where(eq(pluginNativeFiles.pluginId, pluginId));
  if (!files?.length) return null;
  await tx.insert(pluginNativeFiles).values(files.map((f) => ({ pluginId, path: f.path, content: f.content })));
  return contentDigest(files);
}

type ToolTarget = { id: string; runnerId: string | null; runnerTool: string | null; pluginId: string | null; pluginComponent: string | null };

/**
 * What a runner tool is to its runner: the name of the runner's own server, or its plugin's
 * stdio server (`PluginServer`), or why it can't be reached (English, kept as `actionsError`).
 */
export async function runnerTarget(db: Db | Tx, row: ToolTarget): Promise<string | PluginServer | { error: string }> {
  if (row.runnerId === null) return { error: stored("tools.fail.notOnRunner") };
  if (row.runnerTool !== null) return row.runnerTool;
  // No server of the runner's own: a plugin's stdio server, whose link uninstalling the plugin cleared.
  if (row.pluginId === null || row.pluginComponent === null) return { error: stored("tools.plugin.removed") };
  const [plugin] = await db.select({ name: plugins.name, digest: plugins.digest, components: plugins.components }).from(plugins).where(eq(plugins.id, row.pluginId));
  const entry = plugin?.components.mcpServers.find((s) => s.name === row.pluginComponent && s.type === "stdio")?.entry;
  const ref = PluginServer.safeParse({ tool: row.id, plugin: plugin?.name, digest: plugin?.digest, entry });
  return ref.success ? ref.data : { error: stored("tools.plugin.noServer", { server: row.pluginComponent }) };
}

/**
 * `GET /runner/plugins/<tool id>`: the plugin's name, its server's launch entry and its files,
 * for a plugin runner tool on `runnerId` only; null for any other tool.
 */
export function pluginForRunner(db: Db, runnerId: string, toolId: string): Promise<{ name: string; entry: PluginServer["entry"]; files: { path: string; base64: string }[] } | null> {
  return traces.startActiveSpan("runner.plugin_files", { attributes: { "dispand.runner.id": runnerId, "dispand.tool.id": toolId } }, async (span) => {
    try {
      const [row] = await db.select().from(tools).where(and(eq(tools.id, toolId), eq(tools.runnerId, runnerId), eq(tools.kind, "runner")));
      const target = row ? await runnerTarget(db, row) : null;
      if (!row?.pluginId || target === null || typeof target === "string" || "error" in target) {
        span.setAttribute("dispand.result", "not-found");
        counts.counter("dispand.runner.plugin_files").add(1, { "dispand.result": "not-found" });
        return null;
      }
      const files = await db.select({ path: pluginFiles.path, content: pluginFiles.content }).from(pluginFiles).where(eq(pluginFiles.pluginId, row.pluginId));
      span.setAttributes({ "dispand.result": "sent", "dispand.files.count": files.length });
      counts.counter("dispand.runner.plugin_files").add(1, { "dispand.result": "sent" });
      return { name: target.plugin, entry: target.entry, files: files.map((f) => ({ path: f.path, base64: Buffer.from(f.content).toString("base64") })) };
    } catch (err) {
      recordError(span, "PluginFilesFailed");
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * `GET /runner/native-plugins/<plugin id>?digest=<digest>`: the plugin's files at that native
 * revision, for a runner one of whose agents (by its harness) holds a grant for it, in the
 * plugin's workspace, while that is still its pinned revision; null otherwise. Checked at each
 * request: a grant removed or a revision moved since the start is a refusal.
 */
export function nativePluginForRunner(db: Db, runnerId: string, pluginId: string, digest: string): Promise<{ files: { path: string; base64: string }[] } | null> {
  return traces.startActiveSpan("runner.native_plugin_files", { attributes: { "dispand.runner.id": runnerId, "dispand.plugin.id": pluginId } }, async (span) => {
    try {
      const [granted] = await db
        .select({ pluginId: plugins.id })
        .from(agentNativePlugins)
        .innerJoin(agents, eq(agents.id, agentNativePlugins.agentId))
        .innerJoin(harnesses, and(eq(harnesses.id, agents.harnessId), eq(harnesses.workspaceId, agents.workspaceId)))
        .innerJoin(plugins, and(eq(plugins.id, agentNativePlugins.pluginId), eq(plugins.workspaceId, agents.workspaceId)))
        .where(and(eq(agentNativePlugins.pluginId, pluginId), eq(harnesses.runnerId, runnerId), eq(plugins.nativeDigest, digest)))
        .limit(1);
      if (!granted) {
        span.setAttribute("dispand.result", "not-found");
        counts.counter("dispand.runner.plugin_files").add(1, { "dispand.result": "not-found" });
        return null;
      }
      const files = await db.select({ path: pluginNativeFiles.path, content: pluginNativeFiles.content }).from(pluginNativeFiles).where(eq(pluginNativeFiles.pluginId, pluginId));
      span.setAttributes({ "dispand.result": "sent", "dispand.files.count": files.length });
      counts.counter("dispand.runner.plugin_files").add(1, { "dispand.result": "sent" });
      return { files: files.map((f) => ({ path: f.path, base64: Buffer.from(f.content).toString("base64") })) };
    } catch (err) {
      recordError(span, "NativePluginFilesFailed");
      throw err;
    } finally {
      span.end();
    }
  });
}
