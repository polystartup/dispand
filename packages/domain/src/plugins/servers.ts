import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { plugins as pluginsTable } from "../db/schema.ts";
import { recordCreated } from "../platform/proposals.ts";
import { authed, base } from "../rpc/context.ts";
import { TRANSPORTS } from "../tools/mcp.ts";
import { createTool, Name, Url } from "../tools/procedures.ts";
import { toolName } from "./components.ts";

const owner = base.use(authed);

/** The input of `plugins.addServer`, and of a setup's `plugins_add_server` item: the URL and transport are what the owner reviewed. */
export const AddServerInput = z.strictObject({
  pluginId: z.string().max(64),
  server: Name,
  url: Url,
  transport: z.enum(TRANSPORTS),
});

/**
 * Adds one of a plugin's HTTP servers as a tool, with no credentials: the owner enters its
 * headers, or signs in, on the tool's page, as for any tool added by URL. It is listed in the
 * plugin's `created` and is the owner's: uninstalling the plugin keeps it.
 */
export const addServer = owner.input(AddServerInput).handler(async ({ input, context }) => {
  const [plugin] = await context.db
    .select({ name: pluginsTable.name, components: pluginsTable.components })
    .from(pluginsTable)
    .where(and(eq(pluginsTable.id, input.pluginId), eq(pluginsTable.ownerId, context.ownerId)));
  if (!plugin) throw new ORPCError("NOT_FOUND", { message: "Plugin not found" });
  const server = plugin.components.mcpServers.find((s) => s.name === input.server);
  if (!server) throw new ORPCError("BAD_REQUEST", { message: `The plugin has no MCP server “${input.server}”` });
  if (server.type !== "http") throw new ORPCError("BAD_REQUEST", { message: `${server.name} runs on a runner: add it from the plugin's page` });
  if (server.settings.length) throw new ORPCError("BAD_REQUEST", { message: `${server.name}'s URL needs a setting: add it from the plugin's page` });
  // Stored before servers were added from a setup.
  if (!server.transport) throw new ORPCError("BAD_REQUEST", { message: `Update the plugin to add ${server.name}` });
  if (server.url !== input.url || server.transport !== input.transport) throw new ORPCError("CONFLICT", { message: `${server.name} changed since you reviewed it: look at it again` });
  const name = await toolName(context.db, context.ownerId, server.name, plugin.name);
  const tool = await createTool(context, { name, url: server.url, transport: server.transport, headers: {}, plugin: { id: input.pluginId, component: server.name } });
  await recordCreated(context.db, input.pluginId, "tool", tool.id, `server:${server.name}`);
  return tool;
});
