import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { organizationMembers, runs, workspaceMembers, workspaces } from "../db/schema.ts";
import type { InitialContext } from "../rpc/context.ts";

export type RunReader = Pick<InitialContext, "db" | "job"> & { ownerId: string };

/** The workspaces this person can open with their current organization and workspace memberships. */
export function accessibleWorkspaces({ db, ownerId: userId, job }: RunReader) {
  if (job) {
    const caller = alias(runs, "caller_run");
    return db.select({ id: caller.workspaceId }).from(caller).where(and(eq(caller.id, job.runId), eq(caller.ownerId, userId)));
  }
  return db.select({ id: workspaces.id }).from(workspaces)
    .innerJoin(organizationMembers, and(eq(organizationMembers.organizationId, workspaces.organizationId), eq(organizationMembers.userId, userId)))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
    .where(or(eq(organizationMembers.role, "owner"), isNotNull(workspaceMembers.userId)));
}

/** A Job tool keeps its existing owner's rights within its own workspace. It never inherits a person's workspace grants. */
export function readableRun(context: RunReader) {
  return and(inArray(runs.workspaceId, accessibleWorkspaces(context)), context.job ? eq(runs.ownerId, context.ownerId) : undefined);
}
