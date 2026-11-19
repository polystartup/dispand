import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, exists, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record.ts";
import type { Db, Tx } from "../db/client.ts";
import { organizationMembers, user, workspaceInvitations, workspaceMembers, workspaces } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { message } from "../messages/index.ts";
import { lockForManager, managedWorkspaces, person, Scope } from "./people.ts";

const Token = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const missing = () => new ORPCError("NOT_FOUND", message("workspace.invitationNotFound"));
const live = () => gt(workspaceInvitations.expiresAt, sql`clock_timestamp()`);
const role = z.enum(["manager", "member"]);

function auditChange(tx: Tx, userId: string, workspaceId: string, action: "workspace.invited" | "workspace.invitationRevoked" | "workspace.invitationAccepted") {
  return recordAudit(tx, { ownerId: userId, actor: { type: "user", userId }, action, resource: { type: "workspace", id: workspaceId } });
}

export const invite = person.input(Scope.extend({ email: z.string().trim().max(254).pipe(z.email()).toLowerCase(), role })).handler(({ context, input }) =>
  context.db.transaction(async (tx) => {
    await lockForManager(tx, context.ownerId, input);
    const id = newId("inv");
    const token = randomBytes(32).toString("base64url");
    const fields = { id, inviterId: context.ownerId, role: input.role, tokenHash: hash(token), expiresAt: sql`clock_timestamp() + interval '7 days'` };
    const [row] = await tx.insert(workspaceInvitations).values({ ...fields, email: input.email, workspaceId: input.workspaceId })
      .onConflictDoUpdate({ target: [workspaceInvitations.workspaceId, workspaceInvitations.email], set: fields })
      .returning({ expiresAt: workspaceInvitations.expiresAt });
    await auditChange(tx, context.ownerId, input.workspaceId, "workspace.invited");
    return { id, token, expiresAt: row!.expiresAt };
  })
);

export const invitations = person.input(Scope).handler(async ({ context, input }) => {
  const allowed = managedWorkspaces(context.db, context.ownerId, input);
  if (!(await allowed).length) throw missing();
  return context.db.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, expiresAt: workspaceInvitations.expiresAt })
    .from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, input.workspaceId), exists(allowed), live()))
    .orderBy(asc(workspaceInvitations.email));
});

export const revokeInvitation = person.input(Scope.extend({ id: z.string().min(1) })).handler(({ context, input }) =>
  context.db.transaction(async (tx) => {
    await lockForManager(tx, context.ownerId, input);
    const [row] = await tx.delete(workspaceInvitations).where(and(eq(workspaceInvitations.id, input.id), eq(workspaceInvitations.workspaceId, input.workspaceId))).returning({ id: workspaceInvitations.id });
    if (!row) throw missing();
    await auditChange(tx, context.ownerId, input.workspaceId, "workspace.invitationRevoked");
    return { revoked: true };
  })
);

async function addressedTo(db: Db | Tx, userId: string, token: string) {
  const [row] = await db.select({
    id: workspaceInvitations.id, organizationId: workspaces.organizationId, workspaceId: workspaces.id,
    role: workspaceInvitations.role, expiresAt: workspaceInvitations.expiresAt, inviterId: workspaceInvitations.inviterId,
  }).from(workspaceInvitations).innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .innerJoin(user, and(eq(user.id, userId), eq(workspaceInvitations.email, user.email)))
    .where(and(eq(workspaceInvitations.tokenHash, hash(token)), live()));
  if (!row) throw missing();
  return row;
}

export const invitation = person.input(Token).handler(async ({ context, input }) => {
  const row = await addressedTo(context.db, context.ownerId, input.token);
  const [inviter] = await context.db.select({ inviterName: user.name }).from(user)
    .where(and(eq(user.id, row.inviterId), exists(managedWorkspaces(context.db, row.inviterId, row))));
  if (!inviter) throw missing();
  return { organizationId: row.organizationId, workspaceId: row.workspaceId, role: row.role, expiresAt: row.expiresAt, ...inviter };
});

export const acceptInvitation = person.input(Token).handler(({ context, input }) =>
  context.db.transaction(async (tx) => {
    const row = await addressedTo(tx, context.ownerId, input.token);
    await lockForManager(tx, row.inviterId, row);
    const [claimed] = await tx.delete(workspaceInvitations).where(and(eq(workspaceInvitations.id, row.id), live())).returning({ id: workspaceInvitations.id });
    if (!claimed) throw missing();
    await tx.insert(organizationMembers).values({ organizationId: row.organizationId, userId: context.ownerId, role: "member" }).onConflictDoNothing();
    await tx.insert(workspaceMembers).values({ workspaceId: row.workspaceId, userId: context.ownerId, role: row.role }).onConflictDoNothing();
    await auditChange(tx, context.ownerId, row.workspaceId, "workspace.invitationAccepted");
    return { organizationId: row.organizationId, workspaceId: row.workspaceId };
  })
);
