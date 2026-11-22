import { ORPCError } from "@orpc/server";
import { message } from "../messages/index.ts";
import { and, eq, exists, inArray, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db, Tx } from "../db/client.ts";
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
  return and(inArray(runs.workspaceId, accessibleWorkspaces(context)), context.job ? eq(runs.ownerId, context.ownerId) : or(eq(runs.source, "agent"), eq(runs.ownerId, context.ownerId)));
}

type LegacyScope = Omit<RunReader, "db"> & { db: Db | Tx };

/** Owner-keyed operations are safe only for the current owner of a single-workspace installation. */
async function legacyWorkspace({ db, ownerId, job }: LegacyScope): Promise<{ organizationId: string; workspaceId: string } | undefined> {
  const placed = job ? exists(db.select({ id: runs.id }).from(runs).where(and(
    eq(runs.id, job.runId), eq(runs.ownerId, ownerId), eq(runs.workspaceId, workspaces.id),
  ))) : sql<boolean>`true`;
  const rows = await db.select({ organizationId: workspaces.organizationId, workspaceId: workspaces.id, role: organizationMembers.role, placed }).from(workspaces)
    .leftJoin(organizationMembers, and(eq(organizationMembers.organizationId, workspaces.organizationId), eq(organizationMembers.userId, ownerId)))
    .limit(2);
  const [first] = rows;
  return rows.length === 1 && first?.role === "owner" && first.placed ? { organizationId: first.organizationId, workspaceId: first.workspaceId } : undefined;
}

export async function hasLegacyWorkspaceAccess(context: LegacyScope): Promise<boolean> {
  return (await legacyWorkspace(context)) !== undefined;
}

/** The single workspace and its organization, for its owner; FORBIDDEN otherwise. */
export async function requireLegacyScope(context: LegacyScope): Promise<{ organizationId: string; workspaceId: string }> {
  const scope = await legacyWorkspace(context);
  if (!scope) throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  return scope;
}

export async function requireLegacyWorkspace(context: LegacyScope): Promise<string> {
  return (await requireLegacyScope(context)).workspaceId;
}
