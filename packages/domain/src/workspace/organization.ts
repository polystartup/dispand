import { ORPCError } from "@orpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record.ts";
import type { AuditAction, AuditDetails } from "../audit/model.ts";
import type { Db, Tx } from "../db/client.ts";
import { organizationMembers, session, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { withIdentity } from "../auth.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { message } from "../messages/index.ts";
import { base, orgOwner } from "../rpc/context.ts";
import { authorizeOrganization } from "./authorize.ts";
import { removeAssignments } from "./people.ts";

// The organization's owner runs these in the organization's scope (`orgOwner`): its people, their
// workspace roles and its ownership. Each write re-checks the ownership in its own transaction.

const owner = base.use(orgOwner);
const UserId = z.object({ userId: z.string().min(1) });
const Assignment = UserId.extend({ workspaceId: z.string().min(1) });
const missing = () => new ORPCError("NOT_FOUND", message("workspace.membershipNotFound"));

type Caller = { ownerId: string; access: { organizationId: string } };

/** Runs `work` in a transaction once the caller still owns the organization, read in it. */
function asOwner<T>(context: Caller & { db: Db }, work: (tx: Tx) => Promise<T>): Promise<T> {
  return context.db.transaction(async (tx) => {
    if (!(await authorizeOrganization(tx, context.ownerId, context.access.organizationId))) throw missing();
    return work(tx);
  });
}

function audited(tx: Tx, context: Caller, workspaceId: string, action: AuditAction, details: AuditDetails) {
  return recordAudit(tx, { workspaceId, ownerId: context.ownerId, actor: { type: "user", userId: context.ownerId }, action, resource: { type: "workspace", id: workspaceId }, details });
}

/** A change to the organization as a whole: one row in each of its workspaces, whose owner it changes. */
async function auditedEverywhere(tx: Tx, context: Caller, action: AuditAction, details: AuditDetails) {
  for (const { id } of await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.organizationId, context.access.organizationId))) {
    await audited(tx, context, id, action, details);
  }
}

/** The organization's workspaces and its people, each with their organization role and workspace roles. */
const directory = owner.handler(async ({ context }) => {
  const { organizationId } = context.access;
  const spaces = await context.db.select({ workspaceId: workspaces.id, name: workspaces.name }).from(workspaces)
    .where(eq(workspaces.organizationId, organizationId)).orderBy(asc(workspaces.name), asc(workspaces.id));
  const people = await context.db.select({ userId: user.id, name: user.name, email: user.email, role: organizationMembers.role })
    .from(organizationMembers).innerJoin(user, eq(user.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId)).orderBy(asc(user.name), asc(user.id));
  const assignments = await context.db.select({ userId: workspaceMembers.userId, workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaces.organizationId, organizationId)).orderBy(asc(workspaceMembers.workspaceId));
  return {
    workspaces: spaces,
    people: people.map((p) => ({ ...p, workspaces: assignments.filter((a) => a.userId === p.userId).map(({ workspaceId, role }) => ({ workspaceId, role })) })),
  };
});

/**
 * Gives a person of the organization a role in one of its workspaces, or changes it. Both are
 * checked live in the transaction: the workspace is the organization's, the person is in it.
 */
const assign = owner.input(Assignment.extend({ role: z.enum(["manager", "member"]) })).handler(({ context, input }) => asOwner(context, async (tx) => {
  const { organizationId } = context.access;
  const [placed] = await tx.select({ workspaceId: workspaces.id }).from(workspaces)
    .innerJoin(organizationMembers, and(eq(organizationMembers.organizationId, workspaces.organizationId), eq(organizationMembers.userId, input.userId)))
    .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.organizationId, organizationId)));
  if (!placed) throw missing();
  await tx.insert(workspaceMembers).values({ workspaceId: input.workspaceId, userId: input.userId, role: input.role })
    .onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { role: input.role } });
  await audited(tx, context, input.workspaceId, "workspace.memberAssigned", { userId: input.userId, role: input.role });
  return { assigned: true };
}));

/** Takes a person off one of the organization's workspaces, as `workspace.removePerson` does. */
const unassign = owner.input(Assignment).handler(({ context, input }) => asOwner(context, async (tx) => {
  const { organizationId } = context.access;
  const [placed] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.organizationId, organizationId)));
  if (!placed || !(await removeAssignments(tx, organizationId, [placed.id], input.userId)).length) throw missing();
  await audited(tx, context, placed.id, "workspace.memberRemoved", { userId: input.userId });
  return { removed: true };
}));

/**
 * Removes a person from the organization: the pending invitations to or from them in its
 * workspaces, their assignments there, then their membership. Never the owner, who leaves only
 * by a transfer.
 */
const removeMember = owner.input(UserId).handler(({ context, input }) => asOwner(context, async (tx) => {
  await removeFromOrganization(tx, context.access.organizationId, input.userId);
  await auditedEverywhere(tx, context, "workspace.organizationMemberRemoved", { userId: input.userId });
  return { removed: true };
}));

/** `removeMember`'s deletes: invitations, assignments, then the membership, or NOT_FOUND (rolling them back) for the owner or a non-member. */
async function removeFromOrganization(tx: Tx, organizationId: string, userId: string) {
  await removeAssignments(tx, organizationId, tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.organizationId, organizationId)), userId);
  const [removed] = await tx.delete(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.role, "member")))
    .returning({ userId: organizationMembers.userId });
  if (!removed) throw missing();
}

/**
 * Deletes a person of the organization: they are archived at once (they can't sign in, their
 * sessions end, every check counts them as gone) and removed from it as `removeMember` does; what
 * they made stays. Never the owner. A person who belongs to another organization too is refused
 * for now: archiving them would end their access there.
 */
const archiveMember = owner.input(UserId).handler(async ({ context, input }) => {
  const { organizationId } = context.access;
  // Their memberships in every organization, read under SYSTEM: this scope sees only its own.
  const memberships = await inScope(SYSTEM, () => context.db.select({ organizationId: organizationMembers.organizationId, role: organizationMembers.role })
    .from(organizationMembers).where(eq(organizationMembers.userId, input.userId)));
  if (!memberships.some((m) => m.organizationId === organizationId && m.role === "member")) throw missing();
  if (memberships.length > 1) throw new ORPCError("CONFLICT", message("workspace.otherOrganization"));
  return withIdentity(context, async (authTx) => {
    await authTx.update(user).set({ archivedAt: new Date(), archivedBy: organizationId }).where(and(eq(user.id, input.userId), isNull(user.archivedAt)));
    await authTx.delete(session).where(eq(session.userId, input.userId));
  }, async (tx) => {
    if (!(await authorizeOrganization(tx, context.ownerId, organizationId))) throw missing();
    await removeFromOrganization(tx, organizationId, input.userId);
    await auditedEverywhere(tx, context, "workspace.personArchived", { userId: input.userId });
    return { archived: true };
  }, "domainFirst");
});

/**
 * Hands the organization to another of its people: the caller is demoted, then they are promoted,
 * in one transaction, and each update must touch exactly one row, else nothing changes. The
 * unique owner index refuses a second owner, so of two competing transfers one commits.
 */
const transferOwnership = owner.input(UserId).handler(({ context, input }) => asOwner(context, async (tx) => {
  const { organizationId } = context.access;
  const member = (userId: string, role: "owner" | "member") => and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.role, role));
  const demoted = await tx.update(organizationMembers).set({ role: "member" }).where(member(context.ownerId, "owner")).returning({ userId: organizationMembers.userId });
  const promoted = await tx.update(organizationMembers).set({ role: "owner" }).where(member(input.userId, "member")).returning({ userId: organizationMembers.userId });
  if (demoted.length !== 1 || promoted.length !== 1) throw missing();
  await auditedEverywhere(tx, context, "workspace.ownershipTransferred", { userId: input.userId });
  return { transferred: true };
}));

export const organization = { directory, assign, unassign, removeMember, archiveMember, transferOwnership };
