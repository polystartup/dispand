import type { QueryClient } from "@tanstack/react-query";
import { invalidatePaths, PLUGIN_WORK } from "../../lib/query-client.ts";

/**
 * Reads again the plugin and what it is made of: its skills, tools and agents, and what its setup
 * makes (tables with their fields, and triggers). Rows, native installs and runners' inventories
 * aren't in it. For what changes a plugin without a mutation of its own (an uninstall); the
 * mutations do it themselves (`lib/query-client.ts`).
 */
export const refreshPluginWork = (queryClient: QueryClient) => invalidatePaths(queryClient, PLUGIN_WORK);
