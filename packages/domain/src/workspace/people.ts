import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record.ts";
import type { Db, Tx } from "../db/client.ts";
import { organizationMembers, organizations, user, workspaceInvitations, workspaceMembers, workspaces } from "../db/schema.ts";
import { message } from "../messages/index.ts";
import { base, signedIn } from "../rpc/context.ts";
import { inScope } from "../db/scope.ts";
import { authorize, listMine } from "./authorize.ts";

export const person = base.use(signedIn).use(async ({ context, next }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  return next();
});
export const Scope = z.object({ organizationId: z.string().min(1), workspaceId: z.string().min(1) });
const missing = () => new ORPCError("NOT_FOUND", message("workspace.membershipNotFound"));

export function managedWorkspaces(db: Db | Tx, userId: string, scope?: z.infer<typeof Scope>) {
  return db.select({ workspaceId: workspaces.id, workspaceName: workspaces.name, organizationId: organizations.id, organizationName: organizations.name })
    .from(workspaces)
    .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
    .innerJoin(organizationMembers, and(eq(organizationMembers.organizationId, workspaces.organizationId), eq(organizationMembers.userId, userId)))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
    .where(and(
      scope && eq(workspaces.id, scope.workspaceId),
      scope && eq(workspaces.organizationId, scope.organizationId),
      or(eq(organizationMembers.role, "owner"), eq(workspaceMembers.role, "manager")),
    ));
}

/** Whether the person manages the workspace now (its manager or the organization's owner), read live with no lock: a write checks it again in its own transaction. */
export async function requireManager(db: Db | Tx, actorId: string, scope: z.infer<typeof Scope>) {
  const role = await authorize(db, actorId, scope.organizationId, scope.workspaceId);
  if (role !== "owner" && role !== "manager") throw missing();
  return { id: scope.workspaceId };
}

/**
 * A directory procedure: the caller's role is checked under the person alone, then `work` runs in
 * the workspace's scope, where it reads and writes the workspace's people, invitations and runners.
 */
export async function asManager<T>(db: Db, actorId: string, scope: z.infer<typeof Scope>, work: () => Promise<T>): Promise<T> {
  await inScope({ userId: actorId }, () => requireManager(db, actorId, scope));
  return inScope({ userId: actorId, organizationId: scope.organizationId, workspaceId: scope.workspaceId }, work);
}

/** The workspaces the person can open, with their role in each: what a page lists to choose from. */
export const mine = person.handler(({ context }) => listMine(context.db, context.ownerId));

export const managed = person.handler(({ context }) => managedWorkspaces(context.db, context.ownerId).orderBy(asc(workspaces.organizationId), asc(workspaces.id)));

export const people = person.input(Scope).handler(({ context, input }) => asManager(context.db, context.ownerId, input, async () => {
  const db = context.db;
  const rows = await db.select({
    userId: user.id, name: user.name, email: user.email,
    organizationRole: organizationMembers.role, workspaceRole: workspaceMembers.role,
  })
    .from(organizationMembers).innerJoin(user, eq(organizationMembers.userId, user.id))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, user.id)))
    .where(and(
      eq(organizationMembers.organizationId, input.organizationId),
      or(eq(organizationMembers.role, "owner"), isNotNull(workspaceMembers.userId)),
    ))
    .orderBy(asc(user.name), asc(user.id));
  if (!rows.length) throw missing(); // An authorized caller is always in the directory.
  return rows.map(({ organizationRole, workspaceRole, ...person }) => ({ ...person, role: organizationRole === "owner" ? organizationRole : workspaceRole! }));
}));

export const removePerson = person.input(Scope.extend({ userId: z.string().min(1) })).handler(({ context, input }) => asManager(context.db, context.ownerId, input, () =>
  context.db.transaction(async (tx) => {
    const workspace = await requireManager(tx, context.ownerId, input);
    // Old invitations can't restore a removed assignment or resurrect a removed manager's grants.
    // Deleted first: once the assignment is gone, the person's address may no longer be readable in this workspace.
    const address = tx.select({ email: user.email }).from(user).where(eq(user.id, input.userId));
    await tx.delete(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, workspace.id),
      or(eq(workspaceInvitations.inviterId, input.userId), inArray(workspaceInvitations.email, address))));
    const ordinaryMembers = tx.select({ id: organizationMembers.userId }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, input.organizationId), eq(organizationMembers.role, "member")));
    const [removed] = await tx.delete(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, workspace.id),
      eq(workspaceMembers.userId, input.userId),
      inArray(workspaceMembers.userId, ordinaryMembers),
    )).returning({ userId: workspaceMembers.userId });
    // Thrown, so the invitations deleted above come back.
    if (!removed) throw missing();
    await recordAudit(tx, {
      workspaceId: workspace.id, ownerId: context.ownerId, actor: { type: "user", userId: context.ownerId }, action: "workspace.memberRemoved",
      resource: { type: "workspace", id: workspace.id }, details: { userId: removed.userId },
    });
    return { removed: true };
  })),
);
