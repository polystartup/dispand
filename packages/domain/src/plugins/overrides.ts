import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { plugins } from "../db/schema.ts";
import { canonical } from "../platform/approvals.ts";

// A plugin's element keeps the plugin's values of its fields beside the ones in effect
// (`upstream`), and the fields its owner changed (`overridden`). Every write of such an element
// goes through here, so an update of the plugin only replaces what nobody changed.

export type ElementKind = "agent" | "tool";

/**
 * Each kind's fields: the plugin's (an owner's change is an override), local settings (a plugin
 * has no value for them, and no update touches them) and the system's. A test holds every column
 * to one of the three.
 */
export const ELEMENT_FIELDS = {
  agent: {
    overridable: ["name", "description", "systemPrompt", "bundles", "dataTables", "selfLearning", "skillPackageIds", "toolIds", "consults"],
    local: ["harnessId", "model", "cliRules"],
    system: ["id", "ownerId", "pluginId", "pluginComponent", "upstream", "overridden", "builtIn", "createdAt"],
  },
  tool: {
    overridable: ["name", "url", "transport"],
    local: ["urlSealed", "headersSealed", "disabled", "pollable", "auth", "oauthSealed", "oauthStatus", "oauthStateHash", "oauthClientId", "runnerId", "runnerTool"],
    system: ["id", "ownerId", "kind", "permissionRevision", "actions", "actionsError", "refreshedAt", "catalogId", "pluginId", "pluginComponent", "upstream", "overridden", "createdAt"],
  },
} as const satisfies Record<ElementKind, { overridable: readonly string[]; local: readonly string[]; system: readonly string[] }>;

export type Upstream = Record<string, unknown>;
/** What every plugin's element stores: null and empty for a local one. */
export type Overrides = { upstream: Upstream | null; overridden: string[] };

/** A list whose order says nothing (ids, bundles, consult entries), in one order. */
const unordered = (value: unknown): unknown => (Array.isArray(value) ? value.map((v) => canonical(v)).sort() : value);

/** Whether two values of a field are the same for its owner: lists compare as sets. */
export function sameValue(_kind: ElementKind, _field: string, a: unknown, b: unknown): boolean {
  return canonical(unordered(a)) === canonical(unordered(b));
}

/**
 * The overridden fields after a write of `written`: a field that now differs from the plugin's
 * value is listed, one written back to it leaves the list, one the write leaves out stays as it was.
 */
export function overriddenAfter(kind: ElementKind, element: Overrides, written: Record<string, unknown>): string[] {
  const { upstream } = element;
  if (upstream === null) return [];
  const overridden = new Set(element.overridden);
  for (const field of ELEMENT_FIELDS[kind].overridable) {
    if (!(field in written) || written[field] === undefined || !(field in upstream)) continue;
    if (sameValue(kind, field, written[field], upstream[field])) overridden.delete(field);
    else overridden.add(field);
  }
  return [...overridden];
}

export type Conflict = { field: string; old: unknown; mine: unknown; next: unknown };

/**
 * An update of the plugin, for one element: `set` holds the new values of the fields its owner
 * left alone, `conflicts` the overridden fields whose plugin value changed (the owner's value
 * stays in effect), and `upstream` what is stored underneath from now on.
 */
export function rebase(kind: ElementKind, element: Overrides, current: Record<string, unknown>, next: Upstream): { set: Record<string, unknown>; conflicts: Conflict[]; upstream: Upstream } {
  const old = element.upstream ?? {};
  const set: Record<string, unknown> = {};
  const conflicts: Conflict[] = [];
  for (const field of ELEMENT_FIELDS[kind].overridable) {
    if (!(field in next) || sameValue(kind, field, old[field], next[field])) continue;
    if (element.overridden.includes(field)) conflicts.push({ field, old: old[field], mine: current[field], next: next[field] });
    else set[field] = next[field];
  }
  return { set, conflicts, upstream: { ...old, ...next } };
}

/** A plugin's element goes with its plugin: its own delete is refused, with the plugin's name. */
export async function refuseOwnDelete(db: Db | Tx, pluginId: string | null): Promise<void> {
  if (pluginId === null) return;
  const [plugin] = await db.select({ name: plugins.name }).from(plugins).where(eq(plugins.id, pluginId));
  if (plugin) throw new ORPCError("FORBIDDEN", { message: `It is ${plugin.name}'s: uninstall the plugin to remove it` });
}

export { qualifiedName } from "./names.ts";
