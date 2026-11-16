import { ORPCError } from "@orpc/server";
import { PluginServer } from "@dispand/runner-protocol";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { plugins as pluginsTable, runners, tools as toolsTable } from "../db/schema.ts";
import { newId } from "../ids.ts";
import type { InitialContext } from "../rpc/context.ts";
import { recordCreated } from "../platform/proposals.ts";
import { authed, base } from "../rpc/context.ts";
import { TRANSPORTS } from "../tools/mcp.ts";
import { createTool, Name, nameTaken, refreshRunnerActions, toolView, Url } from "../tools/procedures.ts";
import { toolName } from "./components.ts";
import type { PluginComponents } from "./read-plugin.ts";
import { message } from "../messages/index.ts";

const owner = base.use(authed);

/**
 * The input of `plugins.addServer`, and of a setup's `plugins_add_server` item: for an HTTP
 * server, the URL and transport the owner reviewed; for a stdio server, the runner it runs on and
 * the digest of the plugin's files the owner reviewed.
 */
export const AddServerInput = z.union([
  z.strictObject({ pluginId: z.string().max(64), server: Name, url: Url, transport: z.enum(TRANSPORTS) }),
  z.strictObject({ pluginId: z.string().max(64), server: Name, runnerId: z.string().max(100), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }),
]);

/**
 * Adds one of a plugin's HTTP servers as a tool, with no credentials: the owner enters its
 * headers, or signs in, on the tool's page, as for any tool added by URL. It is listed in the
 * plugin's `created` and is the owner's: uninstalling the plugin keeps it.
 */
export const addServer = owner.input(AddServerInput).handler(async ({ input, context }) => {
  const [plugin] = await context.db
    .select({ name: pluginsTable.name, components: pluginsTable.components, digest: pluginsTable.digest })
    .from(pluginsTable)
    .where(and(eq(pluginsTable.id, input.pluginId), eq(pluginsTable.ownerId, context.ownerId)));
  if (!plugin) throw new ORPCError("NOT_FOUND", message("plugins.notFound"));
  const server = plugin.components.mcpServers.find((s) => s.name === input.server);
  if (!server) throw new ORPCError("BAD_REQUEST", message("plugins.server.notFound", { name: input.server }));
  if ("runnerId" in input) return addRunnerServer(context, input, plugin, server);
  if (server.type !== "http") throw new ORPCError("BAD_REQUEST", message("plugins.server.onRunner", { name: server.name }));
  if (server.settings.length) throw new ORPCError("BAD_REQUEST", message("plugins.server.needsSetting", { name: server.name }));
  // Stored before servers were added from a setup.
  if (!server.transport) throw new ORPCError("BAD_REQUEST", message("plugins.server.updateToAdd", { name: server.name }));
  if (server.url !== input.url || server.transport !== input.transport) throw new ORPCError("CONFLICT", message("plugins.server.changed", { name: server.name }));
  const tool = await createTool(context, { name: toolName(server.name), url: server.url, transport: server.transport, headers: {}, plugin: { id: input.pluginId, component: server.name } });
  await recordCreated(context.db, input.pluginId, "tool", tool.id, `server:${server.name}`);
  return tool;
});

type Plugin = { name: string; components: PluginComponents; digest: string | null };

/**
 * Adds a standard plugin's stdio server as a runner tool on one of the owner's runners. It runs
 * nothing yet: the runner starts it only once its own record allows the plugin's digest and
 * entry (`dispand-runner allow-plugin`, shown on the tool's page).
 */
async function addRunnerServer(context: InitialContext & { ownerId: string }, input: Extract<z.infer<typeof AddServerInput>, { runnerId: string }>, plugin: Plugin, server: PluginComponents["mcpServers"][number]) {
  if (server.type !== "stdio") throw new ORPCError("CONFLICT", message("plugins.server.changed", { name: server.name }));
  if (!server.entry || !plugin.digest) throw new ORPCError("BAD_REQUEST", message("plugins.server.noFiles", { name: server.name }));
  if (!PluginServer.shape.entry.safeParse(server.entry).success) throw new ORPCError("BAD_REQUEST", message("plugins.server.entryTooLarge", { name: server.name }));
  // A runner allows only the standard's names; the tool's page writes it into a command to copy.
  if (!PluginServer.shape.plugin.safeParse(plugin.name).success) throw new ORPCError("BAD_REQUEST", message("plugins.server.badName", { name: server.name }));
  if (plugin.digest !== input.digest) throw new ORPCError("CONFLICT", message("plugins.server.changed", { name: server.name }));
  const [runner] = await context.db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.id, input.runnerId), eq(runners.ownerId, context.ownerId), isNull(runners.revokedAt)));
  if (!runner) throw new ORPCError("NOT_FOUND", message("tools.runnerNotFound"));
  const name = toolName(server.name);
  const [row] = await context.db
    .insert(toolsTable)
    .values({ id: newId("tool"), ownerId: context.ownerId, name, kind: "runner", runnerId: runner.id, pluginId: input.pluginId, pluginComponent: server.name, upstream: { name } })
    .returning()
    .catch((e: unknown) => nameTaken(e, name));
  await recordCreated(context.db, input.pluginId, "tool", row!.id, `server:${server.name}`);
  return toolView(context.db, await refreshRunnerActions(context.db, context.hub, row!));
}
