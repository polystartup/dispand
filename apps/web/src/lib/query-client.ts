import { ORPCError } from "@orpc/client";
import { type DefaultError, MutationCache, type MutationKey, QueryClient, type QueryClientConfig } from "@tanstack/react-query";

/** What a plugin is made of, and what its setup and updates make: one list for every write that can change them. */
export const PLUGIN_WORK = ["plugins", "skills", "tools", "agents", "tables", "triggers"];

/**
 * The queries (`orpc.<namespace>.key()`, or one procedure's: `"skills.list"`) a mutation makes
 * stale, by procedure: once it succeeds, the page reads them again. A procedure not listed makes
 * its own namespace stale, so a new mutation can't leave its own lists behind; list it here only
 * when it changes more than that. A mutation that fails reads nothing here unless `staleOnFailure`
 * names it: another screen that needs a read after a refusal asks for it (a setup that stopped half way).
 */
const makesStale: Record<string, string[]> = {
  "plugins.install": PLUGIN_WORK,
  "plugins.setUp": PLUGIN_WORK,
  "plugins.update": PLUGIN_WORK,
  "plugins.resetOverride": PLUGIN_WORK,
  // The Inbox's Approval of the update goes with it.
  "plugins.resolveConflict": [...PLUGIN_WORK, "questions"],
  // A sync may change what a plugin entry holds, and every cached preview.
  "marketplaces.add": ["marketplaces", "plugins"],
  "marketplaces.sync": ["marketplaces", "plugins"],
  "marketplaces.remove": ["marketplaces", "plugins"],
  // An agent lists its tools and what each allows.
  "tools.create": ["tools", "agents"],
  "tools.update": ["tools", "agents"],
  "tools.delete": ["tools", "agents"],
  "tools.setActionEnabled": ["tools", "agents"],
  // A schema change: the table reads its fields, and rows hold the cells it changed.
  "fields.create": ["fields", "tables", "rows"],
  "fields.update": ["fields", "tables", "rows"],
  "fields.retype": ["fields", "tables", "rows"],
  "fields.reorder": ["fields", "tables", "rows"],
  "fields.delete": ["fields", "tables", "rows"],
  // A page holds its widgets, and a workflow's widgets go with it.
  "widgets.create": ["widgets", "pages"],
  "widgets.update": ["widgets", "pages"],
  "widgets.delete": ["widgets", "pages"],
  "workflows.create": ["workflows", "pages"],
  "workflows.setScheduleEnabled": ["workflows", "pages"],
  // People are read by the workspace and by the organization's directory.
  "workspace.removePerson": ["workspace", "organization"],
  "organization.assign": ["organization", "workspace"],
  "organization.unassign": ["organization", "workspace"],
  "organization.archiveMember": ["organization", "workspace"],
  "organization.restoreMember": ["organization", "workspace"],
  // The deleted one's own read would answer "not found" (and be retried) while its screen is still
  // open, so only the lists, and what went with it, are read again.
  "skills.delete": ["skills.list"],
  "pages.delete": ["pages.list"],
  "tables.delete": ["tables.list"],
  "workflows.delete": ["workflows.list", "pages"],
  // Read again by `Dashboard` once the last queued layout is saved: a read between two saves would move a widget back.
  "widgets.saveLayout": [],
};

/**
 * What to read again after a failure too: the mutation may have applied in part, or have found its list already out of
 * date. Only that list: a failed read of the namespace's access checks would replace the page, and the error with it.
 */
const staleOnFailure: Record<string, string[]> = {
  "runs.stop": ["runs.list"],
  "workspace.revokeInvitation": ["workspace.invitations"],
};

/** The queries to read again after the mutation with this key; oRPC's keys are `[[namespace, procedure], { type: "mutation" }]`. */
export function staleQueries(key: MutationKey | undefined): string[] {
  const path = key?.[0];
  if (!Array.isArray(path) || path.length < 2) return [];
  return makesStale[path.join(".")] ?? [String(path[0])];
}

/** A failed query is asked again up to three times, TanStack's default, unless the server refused it: a 4xx answers the same again. */
const retry = (failures: number, error: DefaultError) => failures < 3 && !(error instanceof ORPCError && error.status >= 400 && error.status < 500);

/** Reads again the queries under each of `paths` (`"tables"`, or `"skills.list"`). */
export const invalidatePaths = (client: QueryClient, paths: string[]) =>
  Promise.all(paths.map((path) => client.invalidateQueries({ queryKey: [path.split(".")] })));

/**
 * The page's query client: every mutation that succeeds reads again what it made stale (`makesStale`),
 * before its own callbacks run; one in `staleOnFailure` does so after a failure too, without waiting.
 */
export function createQueryClient(config: QueryClientConfig = {}): QueryClient {
  const client: QueryClient = new QueryClient({
    ...config,
    defaultOptions: { ...config.defaultOptions, queries: { retry, ...config.defaultOptions?.queries } },
    mutationCache: new MutationCache({
      // A dry run (a preview of a field's new type) changes nothing.
      onSuccess: (_data, variables, _context, mutation) =>
        (variables as { dryRun?: boolean } | undefined)?.dryRun ? undefined : invalidatePaths(client, staleQueries(mutation.options.mutationKey)),
      // Not awaited: what went wrong shows at once, however long the read takes.
      onError: (_error, _variables, _context, mutation) => {
        const [path] = mutation.options.mutationKey ?? [];
        if (Array.isArray(path)) void invalidatePaths(client, staleOnFailure[path.join(".")] ?? []);
      },
    }),
  });
  return client;
}
