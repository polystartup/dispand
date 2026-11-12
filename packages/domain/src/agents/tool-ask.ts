import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Db } from "../db/client.ts";
import { agents, agentTools, tools } from "../db/schema.ts";

/** Server-owned binding of a reviewed grant; discovery, renames and credential headers do not retarget a tool. */
export function toolPermissionTarget(tool: { kind: string; url?: string | null; urlSealed?: string | null; transport?: string | null; runnerId?: string | null; runnerTool?: string | null; permissionRevision?: number }): string {
  return createHash("sha256").update(JSON.stringify([tool.kind, tool.url ?? null, tool.urlSealed ?? null, tool.transport ?? null, tool.runnerId ?? null, tool.runnerTool ?? null, tool.permissionRevision ?? 0])).digest("hex");
}

export const Permission = z.enum(["run", "ask", "off"]);
export type Permission = z.infer<typeof Permission>;
type Change = { agentId: string; toolId: string; action: string; permission: Permission };

/** Owner changes may enable an action; remembering a pending approval must not re-enable it. */
async function writePermission(db: Db, ownerId: string, to: Change, remembering: boolean): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ actions: tools.actions, unasked: agentTools.unasked, denied: agentTools.denied })
      .from(agentTools)
      .innerJoin(agents, eq(agents.id, agentTools.agentId))
      .innerJoin(tools, eq(tools.id, agentTools.toolId))
      .where(and(eq(agentTools.agentId, to.agentId), eq(agentTools.toolId, to.toolId), eq(agents.ownerId, ownerId), eq(tools.ownerId, ownerId), inArray(tools.kind, ["http", "runner"])))
      .for("update", { of: agentTools });
    if (!row?.actions.some((a) => a.name === to.action) || (remembering && row.denied.includes(to.action))) return false;
    // Forget actions the tool no longer lists: if they return, they ask.
    const names = row.actions.map((a) => a.name);
    const unasked = names.filter((name) => name === to.action ? to.permission === "run" : row.unasked.includes(name));
    const denied = names.filter((name) => name === to.action ? to.permission === "off" : row.denied.includes(name));
    await tx.update(agentTools).set({ unasked, denied }).where(and(eq(agentTools.agentId, to.agentId), eq(agentTools.toolId, to.toolId)));
    return true;
  });
}

export function setPermission(db: Db, ownerId: string, to: Change): Promise<boolean> {
  return writePermission(db, ownerId, to, false);
}

/** The late Always answer is checked under the same row lock as the owner's Off change. */
export function rememberAllowedAction(db: Db, ownerId: string, to: Omit<Change, "permission">): Promise<boolean> {
  return writePermission(db, ownerId, { ...to, permission: "run" }, true);
}
