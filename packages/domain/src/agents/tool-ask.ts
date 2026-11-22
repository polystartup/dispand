import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Db, Tx } from "../db/client.ts";
import { agents, agentSkills, agentSkillToolPermissions, agentTools, plugins, skillPackages, tools, workspaceSettings } from "../db/schema.ts";
import type { ToolAction } from "../tools/mcp.ts";

type TargetOf = { kind: string; url?: string | null; urlSealed?: string | null; transport?: string | null; runnerId?: string | null; runnerTool?: string | null; permissionRevision?: number; actions?: ToolAction[] };
/** What strict permissions also bind a choice to, beside the tool's listed actions. */
type Versions = { agentRevision: number; pluginCommit: string | null; skillFingerprint: string | null };

/**
 * Server-owned binding of a reviewed grant; discovery, renames and credential headers do not retarget a tool.
 * With `versions` (strict permissions), it also covers the listed actions' names and schemas and those versions.
 */
export function toolPermissionTarget(tool: TargetOf, versions?: Versions): string {
  const base = [tool.kind, tool.url ?? null, tool.urlSealed ?? null, tool.transport ?? null, tool.runnerId ?? null, tool.runnerTool ?? null, tool.permissionRevision ?? 0];
  const listed = versions && (tool.actions ?? []).map((a) => [a.name, a.inputSchema ?? null, a.outputSchema ?? null]).sort(([a], [b]) => String(a).localeCompare(String(b)));
  return createHash("sha256").update(JSON.stringify(versions ? [...base, listed, versions.pluginCommit, versions.skillFingerprint, versions.agentRevision] : base)).digest("hex");
}

export async function strictPermissionsOf(db: Db | Tx, workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ strict: workspaceSettings.strictPermissions }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
  return row?.strict ?? false;
}

/** The revision a proposal's frozen lists are bound to: the agent changes with their approval, the tool must not. */
export const FROZEN_REVISION = -1;

/** A tool's strict target for one agent (and the skill package a choice came with), or null when its last listing failed. */
export type StrictTargets = (tool: TargetOf & { pluginId: string | null; actionsError: string | null }, packageId?: string) => string | null;

/**
 * Under strict permissions, what the agent's choices are bound to; null without strict permissions.
 * `revision`: the agent configuration a Job runs (its snapshot's), when not the current one.
 */
export async function strictTargets(db: Db | Tx, workspaceId: string, ownerId: string, agentId: string, toolRows: { pluginId: string | null }[], packageIds: string[], revision?: number): Promise<StrictTargets | null> {
  if (!(await strictPermissionsOf(db, workspaceId))) return null;
  const [agent] = revision === undefined ? await db.select({ revision: agents.revision }).from(agents).where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId))) : [{ revision }];
  const pluginIds = [...new Set(toolRows.flatMap((t) => (t.pluginId ? [t.pluginId] : [])))];
  const commits = new Map(pluginIds.length ? (await db.select({ id: plugins.id, sha: plugins.sha }).from(plugins).where(and(inArray(plugins.id, pluginIds), eq(plugins.ownerId, ownerId)))).map((p) => [p.id, p.sha]) : []);
  const fingerprints = new Map(packageIds.length ? (await db.select({ id: skillPackages.id, fingerprint: skillPackages.fingerprint }).from(skillPackages).where(and(inArray(skillPackages.id, packageIds), eq(skillPackages.ownerId, ownerId)))).map((p) => [p.id, p.fingerprint]) : []);
  return (tool, packageId) =>
    tool.actionsError !== null || !agent ? null : toolPermissionTarget(tool, { agentRevision: agent.revision, pluginCommit: (tool.pluginId && commits.get(tool.pluginId)) ?? null, skillFingerprint: (packageId && fingerprints.get(packageId)) ?? null });
}

/**
 * The one rule for a stored choice's grants: without strict permissions they hold; with them,
 * only for the strict target they were written for. A stale choice asks again; its Off stays.
 */
export function heldUnasked(strict: StrictTargets | null, row: { unasked: string[]; strictTarget: string | null }, tool: Parameters<StrictTargets>[0], packageId?: string): string[] {
  if (!strict) return row.unasked;
  const current = strict(tool, packageId);
  return current !== null && current === row.strictTarget ? row.unasked : [];
}

export const Permission = z.enum(["run", "ask", "off"]);
export type Permission = z.infer<typeof Permission>;
type Change = { agentId: string; toolId: string; action: string; permission: Permission };

type Lists = { actions: { name: string }[]; unasked: string[]; denied: string[]; disabled: string[] };

/** The two lists after `to`, or null when it may not be written. */
function changed(row: Lists | undefined, to: Change, remembering: boolean): { unasked: string[]; denied: string[] } | null {
  if (!row?.actions.some((a) => a.name === to.action) || row.disabled.includes(to.action) || (remembering && row.denied.includes(to.action))) return null;
  // Forget stale positive grants, but keep Off until it is explicitly changed.
  const names = [...new Set([...row.actions.map((a) => a.name), ...row.unasked.filter((name) => row.disabled.includes(name))])];
  const unasked = names.filter((name) => name === to.action ? to.permission === "run" : row.unasked.includes(name));
  const denied = row.denied.filter((name) => name !== to.action);
  if (to.permission === "off") denied.push(to.action);
  return { unasked, denied };
}

/** The agent's skill packages that require the tool: what gives it a tool it didn't choose. */
export function packagesRequiring(db: Db | Tx, ownerId: string, agentId: string, toolId: string) {
  return db
    .select({ id: agentSkills.packageId, workspaceId: agents.workspaceId })
    .from(agentSkills)
    .innerJoin(agents, eq(agents.id, agentSkills.agentId))
    .innerJoin(skillPackages, eq(skillPackages.id, agentSkills.packageId))
    .where(and(eq(agentSkills.agentId, agentId), eq(agents.ownerId, ownerId), eq(skillPackages.ownerId, ownerId), sql`${skillPackages.requiredToolIds} @> ${JSON.stringify([toolId])}::jsonb`));
}

/** Owner changes may enable an action; remembering a pending approval must not re-enable it. */
async function writePermission(db: Db | Tx, ownerId: string, to: Change, remembering: boolean): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ tool: tools, workspaceId: agents.workspaceId, unasked: agentTools.unasked, denied: agentTools.denied, strictTarget: agentTools.strictTarget })
      .from(agentTools)
      .innerJoin(agents, eq(agents.id, agentTools.agentId))
      .innerJoin(tools, eq(tools.id, agentTools.toolId))
      .where(and(eq(agentTools.agentId, to.agentId), eq(agentTools.toolId, to.toolId), eq(agents.ownerId, ownerId), eq(tools.ownerId, ownerId), inArray(tools.kind, ["http", "runner"])))
      .for("update", { of: agentTools });
    if (!found) return writeSkillPermission(tx, ownerId, to, remembering);
    const { tool } = found;
    const strict = await strictTargets(tx, found.workspaceId, ownerId, to.agentId, [tool], []);
    // A stale choice's grants don't ride along with this one.
    const lists = changed({ actions: tool.actions, disabled: tool.disabled, denied: found.denied, unasked: heldUnasked(strict, found, tool) }, to, remembering);
    if (!lists) return false;
    await tx.update(agentTools).set({ ...lists, strictTarget: strict?.(tool) ?? null }).where(and(eq(agentTools.agentId, to.agentId), eq(agentTools.toolId, to.toolId)));
    return true;
  });
}

/**
 * A tool the agent gets only with skill packages: one row per such package, bound to the tool's
 * current target. A row written for another target holds nothing: the tool asks again.
 */
async function writeSkillPermission(tx: Tx, ownerId: string, to: Change, remembering: boolean): Promise<boolean> {
  // Locked like `agent_tools` above: a setup save dropping the package, or a package save dropping the tool, waits.
  const packages = await packagesRequiring(tx, ownerId, to.agentId, to.toolId).for("update", { of: [agentSkills, skillPackages] });
  if (!packages.length) return false;
  const [tool] = await tx.select().from(tools).where(and(eq(tools.id, to.toolId), eq(tools.ownerId, ownerId), inArray(tools.kind, ["http", "runner"])));
  if (!tool) return false;
  const target = toolPermissionTarget(tool);
  const ids = packages.map((p) => p.id);
  const strict = await strictTargets(tx, packages[0]!.workspaceId, ownerId, to.agentId, [tool], ids);
  const saved = (await tx.select().from(agentSkillToolPermissions).where(and(eq(agentSkillToolPermissions.agentId, to.agentId), eq(agentSkillToolPermissions.toolId, to.toolId), inArray(agentSkillToolPermissions.skillPackageId, ids)))).filter((r) => r.target === target);
  const lists = changed({ actions: tool.actions, disabled: tool.disabled, unasked: [...new Set(saved.flatMap((r) => heldUnasked(strict, r, tool, r.skillPackageId)))], denied: [...new Set(saved.flatMap((r) => r.denied))] }, to, remembering);
  if (!lists) return false;
  // Each package's row is bound to its own skill fingerprint under strict permissions.
  await tx
    .insert(agentSkillToolPermissions)
    .values(ids.map((id) => ({ agentId: to.agentId, skillPackageId: id, toolId: to.toolId, target, ...lists, strictTarget: strict?.(tool, id) ?? null })))
    .onConflictDoUpdate({ target: [agentSkillToolPermissions.agentId, agentSkillToolPermissions.skillPackageId, agentSkillToolPermissions.toolId], set: { target, ...lists, strictTarget: sql`excluded.strict_target` } });
  return true;
}

export function setPermission(db: Db | Tx, ownerId: string, to: Change): Promise<boolean> {
  return writePermission(db, ownerId, to, false);
}

/** The late Always answer is checked under the same row lock as the owner's Off change. */
export function rememberAllowedAction(db: Db | Tx, ownerId: string, to: Omit<Change, "permission">): Promise<boolean> {
  return writePermission(db, ownerId, { ...to, permission: "run" }, true);
}
