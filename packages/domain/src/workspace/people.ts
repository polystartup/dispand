import { ORPCError } from "@orpc/server";
import { and, asc, eq, exists, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record.ts";
import type { Db, Tx } from "../db/client.ts";
import { organizationMembers, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { message } from "../messages/index.ts";
import { base, signedIn } from "../rpc/context.ts";

const person = base.use(signedIn).use(async ({ context, next }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  return next();
});
const Scope = z.object({ organizationId: z.string().min(1), workspaceId: z.string().min(1) });
const missing = () => new ORPCError("NOT_FOUND", message("workspace.membershipNotFound"));

function managedWorkspaces(db: Db | Tx, userId: string, scope?: z.infer<typeof Scope>) {
  return db.select({ workspaceId: workspaces.id, organizationId: workspaces.organizationId })
    .from(workspaces)
    .innerJoin(organizationMembers, and(eq(organizationMembers.organizationId, workspaces.organizationId), eq(organizationMembers.userId, userId)))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
    .where(and(
      scope && eq(workspaces.id, scope.workspaceId),
      scope && eq(workspaces.organizationId, scope.organizationId),
      or(eq(organizationMembers.role, "owner"), eq(workspaceMembers.role, "manager")),
    ));
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
    // Serialize two managers removing one another, then recheck permission with the lock held.
    const allowed = managedWorkspaces(tx, context.ownerId, input);
    const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), exists(allowed))).for("update");
    if (!workspace) throw missing();
    const ordinaryMembers = tx.select({ id: organizationMembers.userId }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, input.organizationId), eq(organizationMembers.role, "member")));
    const [removed] = await tx.delete(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, workspace.id),
      eq(workspaceMembers.userId, input.userId),
      exists(allowed),
      inArray(workspaceMembers.userId, ordinaryMembers),
    )).returning({ userId: workspaceMembers.userId });
    if (!removed) throw missing();
    await recordAudit(tx, {
      ownerId: context.ownerId, actor: { type: "user", userId: context.ownerId }, action: "workspace.memberRemoved",
      resource: { type: "workspace", id: workspace.id }, details: { userId: removed.userId },
    });
    return { removed: true };
  }),
);
