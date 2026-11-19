import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { organizationMembers, workspaces } from "../db/schema.ts";
import { message } from "../messages/index.ts";

/** Self-hosted creation has no workspace selector. Only one workspace can be implied. */
export async function initialWorkspace(tx: Tx, ownerId: string): Promise<string> {
  const rows = await tx.select({ id: workspaces.id, role: organizationMembers.role }).from(workspaces)
    .leftJoin(organizationMembers, and(eq(organizationMembers.organizationId, workspaces.organizationId), eq(organizationMembers.userId, ownerId)))
    .limit(2);
  if (rows.length !== 1) throw new ORPCError("CONFLICT", message("workspace.placementRequired"));
  if (rows[0]!.role !== "owner") throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  return rows[0]!.id;
}
