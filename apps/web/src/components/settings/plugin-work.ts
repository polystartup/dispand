import type { QueryClient } from "@tanstack/react-query";
import { orpc } from "../../lib/api.ts";

/**
 * Reads again the plugin and what it is made of: its skills, tools and agents, and what its setup
 * makes (tables with their fields, and triggers). Rows, native installs and runners' inventories
 * aren't in it. One list for the plugin sheets' writes, so they can't drift apart.
 */
export const refreshPluginWork = (queryClient: QueryClient) =>
  Promise.all(
    [orpc.plugins, orpc.skills, orpc.tools, orpc.agents, orpc.tables, orpc.triggers].map((procedures) =>
      queryClient.invalidateQueries({ queryKey: procedures.key() }),
    ),
  );
