import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Db, Tx } from "../db/client.ts";
import { agents, agentSkills, agentSkillToolPermissions, agentTools, skillPackages, tools } from "../db/schema.ts";

/** Server-owned binding of a reviewed grant; discovery, renames and credential headers do not retarget a tool. */
export function toolPermissionTarget(tool: { kind: string; url?: string | null; urlSealed?: string | null; transport?: string | null; runnerId?: string | null; runnerTool?: string | null; permissionRevision?: number }): string {
  return createHash("sha256").update(JSON.stringify([tool.kind, tool.url ?? null, tool.urlSealed ?? null, tool.transport ?? null, tool.runnerId ?? null, tool.runnerTool ?? null, tool.permissionRevision ?? 0])).digest("hex");
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
    .select({ id: agentSkills.packageId })
    .from(agentSkills)
    .innerJoin(agents, eq(agents.id, agentSkills.agentId))
    .innerJoin(skillPackages, eq(skillPackages.id, agentSkills.packageId))
    .where(and(eq(agentSkills.agentId, agentId), eq(agents.ownerId, ownerId), eq(skillPackages.ownerId, ownerId), sql`${skillPackages.requiredToolIds} @> ${JSON.stringify([toolId])}::jsonb`));
}

/** Owner changes may enable an action; remembering a pending approval must not re-enable it. */
async function writePermission(db: Db | Tx, ownerId: string, to: Change, remembering: boolean): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ actions: tools.actions, unasked: agentTools.unasked, denied: agentTools.denied, disabled: tools.disabled })
      .from(agentTools)
      .innerJoin(agents, eq(agents.id, agentTools.agentId))
      .innerJoin(tools, eq(tools.id, agentTools.toolId))
      .where(and(eq(agentTools.agentId, to.agentId), eq(agentTools.toolId, to.toolId), eq(agents.ownerId, ownerId), eq(tools.ownerId, ownerId), inArray(tools.kind, ["http", "runner"])))
      .for("update", { of: agentTools });
    if (!row) return writeSkillPermission(tx, ownerId, to, remembering);
    const lists = changed(row, to, remembering);
    if (!lists) return false;
    await tx.update(agentTools).set(lists).where(and(eq(agentTools.agentId, to.agentId), eq(agentTools.toolId, to.toolId)));
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
  const saved = (await tx.select().from(agentSkillToolPermissions).where(and(eq(agentSkillToolPermissions.agentId, to.agentId), eq(agentSkillToolPermissions.toolId, to.toolId), inArray(agentSkillToolPermissions.skillPackageId, packages.map((p) => p.id))))).filter((r) => r.target === target);
  const lists = changed({ actions: tool.actions, disabled: tool.disabled, unasked: [...new Set(saved.flatMap((r) => r.unasked))], denied: [...new Set(saved.flatMap((r) => r.denied))] }, to, remembering);
  if (!lists) return false;
  await tx
    .insert(agentSkillToolPermissions)
    .values(packages.map((p) => ({ agentId: to.agentId, skillPackageId: p.id, toolId: to.toolId, target, ...lists })))
    .onConflictDoUpdate({ target: [agentSkillToolPermissions.agentId, agentSkillToolPermissions.skillPackageId, agentSkillToolPermissions.toolId], set: { target, ...lists } });
  return true;
}

export function setPermission(db: Db | Tx, ownerId: string, to: Change): Promise<boolean> {
  return writePermission(db, ownerId, to, false);
}

/** The late Always answer is checked under the same row lock as the owner's Off change. */
export function rememberAllowedAction(db: Db | Tx, ownerId: string, to: Omit<Change, "permission">): Promise<boolean> {
  return writePermission(db, ownerId, { ...to, permission: "run" }, true);
}
