import { PluginServer } from "@dispand/runner-protocol";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { pluginFiles, plugins, tools } from "../db/schema.ts";
import { english } from "../messages/index.ts";
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

type ToolTarget = { id: string; runnerId: string | null; runnerTool: string | null; pluginId: string | null; pluginComponent: string | null };

/**
 * What a runner tool is to its runner: the name of the runner's own server, or its plugin's
 * stdio server (`PluginServer`), or why it can't be reached (English, kept as `actionsError`).
 */
export async function runnerTarget(db: Db | Tx, row: ToolTarget): Promise<string | PluginServer | { error: string }> {
  if (row.runnerId === null) return { error: "Not on a runner yet" };
  if (row.runnerTool !== null) return row.runnerTool;
  // No server of the runner's own: a plugin's stdio server, whose link uninstalling the plugin cleared.
  if (row.pluginId === null || row.pluginComponent === null) return { error: english("tools.plugin.removed") };
  const [plugin] = await db.select({ name: plugins.name, digest: plugins.digest, components: plugins.components }).from(plugins).where(eq(plugins.id, row.pluginId));
  const entry = plugin?.components.mcpServers.find((s) => s.name === row.pluginComponent && s.type === "stdio")?.entry;
  const ref = PluginServer.safeParse({ tool: row.id, plugin: plugin?.name, digest: plugin?.digest, entry });
  return ref.success ? ref.data : { error: english("tools.plugin.noServer", { server: row.pluginComponent }) };
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
