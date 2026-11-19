import { ORPCError } from "@orpc/server";
import { and, asc, eq, exists, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record.ts";
import type { Db, Tx } from "../db/client.ts";
import { organizationMembers, organizations, user, workspaceInvitations, workspaceMembers, workspaces } from "../db/schema.ts";
import { message } from "../messages/index.ts";
import { base, signedIn } from "../rpc/context.ts";

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

export async function lockForManager(tx: Tx, actorId: string, scope: z.infer<typeof Scope>) {
  // Membership removal locks the same row. Read the manager's authority again after acquiring it.
  const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces)
    .where(and(eq(workspaces.id, scope.workspaceId), eq(workspaces.organizationId, scope.organizationId), exists(managedWorkspaces(tx, actorId, scope)))).for("update");
  if (!workspace || !(await managedWorkspaces(tx, actorId, scope)).length) throw missing();
  return workspace;
}

export const managed = person.handler(({ context }) => managedWorkspaces(context.db, context.ownerId).orderBy(asc(workspaces.organizationId), asc(workspaces.id)));

export const people = person.input(Scope).handler(async ({ context, input }) => {
  const db = context.db;
  const rows = await db.select({
    userId: user.id, name: user.name, email: user.email,
    organizationRole: organizationMembers.role, workspaceRole: workspaceMembers.role,
  })
    .from(organizationMembers).innerJoin(user, eq(organizationMembers.userId, user.id))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, user.id)))
    .where(and(
      exists(managedWorkspaces(db, context.ownerId, input)),
      eq(organizationMembers.organizationId, input.organizationId),
      or(eq(organizationMembers.role, "owner"), isNotNull(workspaceMembers.userId)),
    ))
    .orderBy(asc(user.name), asc(user.id));
  if (!rows.length) throw missing(); // An authorized caller is always in the directory.
  return rows.map(({ organizationRole, workspaceRole, ...person }) => ({ ...person, role: organizationRole === "owner" ? organizationRole : workspaceRole! }));
});

export const removePerson = person.input(Scope.extend({ userId: z.string().min(1) })).handler(({ context, input }) =>
  context.db.transaction(async (tx) => {
    const workspace = await lockForManager(tx, context.ownerId, input);
    const ordinaryMembers = tx.select({ id: organizationMembers.userId }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, input.organizationId), eq(organizationMembers.role, "member")));
    const [removed] = await tx.delete(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, workspace.id),
      eq(workspaceMembers.userId, input.userId),
      inArray(workspaceMembers.userId, ordinaryMembers),
    )).returning({ userId: workspaceMembers.userId });
    if (!removed) throw missing();
    // Old invitations cannot restore a removed assignment or resurrect a removed manager's grants.
    const address = tx.select({ email: user.email }).from(user).where(eq(user.id, removed.userId));
    await tx.delete(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, workspace.id),
      or(eq(workspaceInvitations.inviterId, removed.userId), inArray(workspaceInvitations.email, address))));
    await recordAudit(tx, {
      ownerId: context.ownerId, actor: { type: "user", userId: context.ownerId }, action: "workspace.memberRemoved",
      resource: { type: "workspace", id: workspace.id }, details: { userId: removed.userId },
    });
    return { removed: true };
  }),
);
