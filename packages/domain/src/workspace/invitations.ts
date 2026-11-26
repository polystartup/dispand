import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, exists, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record.ts";
import { withIdentity } from "../auth.ts";
import type { Db, Tx } from "../db/client.ts";
import { account, organizationMembers, organizations, user, workspaceInvitations, workspaceMembers, workspaces } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { message } from "../messages/index.ts";
import { asManager, managedWorkspaces, person, requireManager, Scope } from "./people.ts";

import { base, type InitialContext } from "../rpc/context.ts";
import { authorize } from "./authorize.ts";
import { refuseOrganization } from "./gate.ts";

const Email = z.string().trim().max(254).toLowerCase().pipe(z.email());
const Token = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const missing = () => new ORPCError("NOT_FOUND", message("workspace.invitationNotFound"));
const live = () => gt(workspaceInvitations.expiresAt, sql`clock_timestamp()`);
const role = z.enum(["manager", "member"]);

function auditChange(tx: Tx, userId: string, workspaceId: string, action: "workspace.invited" | "workspace.invitationRevoked" | "workspace.invitationAccepted") {
  return recordAudit(tx, { workspaceId, ownerId: userId, actor: { type: "user", userId }, action, resource: { type: "workspace", id: workspaceId } });
}

export const invite = person.input(Scope.extend({ email: Email, role })).handler(({ context, input }) => asManager(context.db, context.ownerId, input, () =>
  context.db.transaction(async (tx) => {
    await requireManager(tx, context.ownerId, input);
    const id = newId("inv");
    const token = randomBytes(32).toString("base64url");
    const fields = { id, inviterId: context.ownerId, role: input.role, tokenHash: hash(token), expiresAt: sql`clock_timestamp() + interval '7 days'` };
    const [row] = await tx.insert(workspaceInvitations).values({ ...fields, email: input.email, workspaceId: input.workspaceId })
      .onConflictDoUpdate({ target: [workspaceInvitations.workspaceId, workspaceInvitations.email], set: fields })
      .returning({ expiresAt: workspaceInvitations.expiresAt });
    await auditChange(tx, context.ownerId, input.workspaceId, "workspace.invited");
    return { id, token, expiresAt: row!.expiresAt };
  }))
);

export const invitations = person.input(Scope).handler(({ context, input }) => asManager(context.db, context.ownerId, input, () =>
  context.db.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, expiresAt: workspaceInvitations.expiresAt })
    .from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, input.workspaceId), live()))
    .orderBy(asc(workspaceInvitations.email)).then((rows) => rows)
));

export const revokeInvitation = person.input(Scope.extend({ id: z.string().min(1) })).handler(({ context, input }) => asManager(context.db, context.ownerId, input, () =>
  context.db.transaction(async (tx) => {
    await requireManager(tx, context.ownerId, input);
    const [row] = await tx.delete(workspaceInvitations).where(and(eq(workspaceInvitations.id, input.id), eq(workspaceInvitations.workspaceId, input.workspaceId))).returning({ id: workspaceInvitations.id });
    if (!row) throw missing();
    await auditChange(tx, context.ownerId, input.workspaceId, "workspace.invitationRevoked");
    return { revoked: true };
  }))
);

/** The workspace a token's invitation is for, read under SYSTEM: the token is all there is. What follows runs in it. */
async function placeOf(db: Db, token: string) {
  const [placed] = await inScope(SYSTEM, () => db.select({ organizationId: workspaces.organizationId, workspaceId: workspaces.id }).from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId)).where(eq(workspaceInvitations.tokenHash, hash(token))));
  if (!placed) throw missing();
  return placed;
}

/**
 * An invitation found live and for this person (and vouched for, for a new account): its
 * organization, if the install refuses it, answers its refusal. Joining one is a write into it.
 * Never before: an expired token, or one for someone else, still answers NOT_FOUND.
 */
function refusedFor(context: Pick<InitialContext, "db">, row: Invitation) {
  refuseOrganization(context.db, row.organizationId);
  return row;
}

async function findInvitation(db: Db | Tx, token: string, address: SQL) {
  const [row] = await db.select({
    id: workspaceInvitations.id, organizationId: workspaces.organizationId, workspaceId: workspaces.id,
    organizationName: organizations.name, workspaceName: workspaces.name,
    role: workspaceInvitations.role, expiresAt: workspaceInvitations.expiresAt, inviterId: workspaceInvitations.inviterId,
  }).from(workspaceInvitations).innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
    .where(and(eq(workspaceInvitations.tokenHash, hash(token)), address, live()));
  if (!row) throw missing();
  return row;
}

/** The invitation the token names, addressed to this person; none for an archived person (check at use: an archive may race an acceptance). */
function addressedTo(db: Db | Tx, userId: string, token: string) {
  return findInvitation(db, token, inArray(workspaceInvitations.email, db.select({ email: user.email }).from(user).where(and(eq(user.id, userId), isNull(user.archivedAt)))));
}

async function summary(db: Db, row: Invitation) {
  const [inviter] = await db.select({ inviterName: user.name }).from(user)
    .where(and(eq(user.id, row.inviterId), exists(managedWorkspaces(db, row.inviterId, row))));
  if (!inviter) throw missing();
  return { organizationId: row.organizationId, workspaceId: row.workspaceId, organizationName: row.organizationName, workspaceName: row.workspaceName, role: row.role, expiresAt: row.expiresAt, ...inviter };
}

export const invitation = person.input(Token).handler(async ({ context, input }) =>
  inScope({ userId: context.ownerId, ...(await placeOf(context.db, input.token)) }, async () =>
    summary(context.db, refusedFor(context, await addressedTo(context.db, context.ownerId, input.token))))
);

/** A new user can review the owner's trusted handoff before choosing a password. */
export const registrationPreview = base.input(Token.extend({ email: Email })).handler(async ({ context, input }) => {
  if (context.job) throw missing();
  return inScope(await placeOf(context.db, input.token), async () => {
    const row = await findInvitation(context.db, input.token, eq(workspaceInvitations.email, input.email));
    await vouched(context.db, context, row);
    refusedFor(context, row);
    // No account yet: identities live on authDb, and db may see only the workspace's people.
    const [taken] = await context.authDb.select({ id: user.id }).from(user).where(eq(user.email, input.email));
    if (taken) throw missing();
    return summary(context.db, row);
  });
});

type Invitation = Awaited<ReturnType<typeof findInvitation>>;

async function grant(tx: Tx, row: Invitation, userId: string) {
  const [claimed] = await tx.delete(workspaceInvitations).where(and(eq(workspaceInvitations.id, row.id), live())).returning({ id: workspaceInvitations.id });
  if (!claimed) throw missing();
  await tx.insert(organizationMembers).values({ organizationId: row.organizationId, userId, role: "member" }).onConflictDoNothing();
  await tx.insert(workspaceMembers).values({ workspaceId: row.workspaceId, userId, role: row.role }).onConflictDoNothing();
  await auditChange(tx, userId, row.workspaceId, "workspace.invitationAccepted");
  return { organizationId: row.organizationId, workspaceId: row.workspaceId };
}

export const acceptInvitation = person.input(Token).handler(async ({ context, input }) =>
  inScope({ userId: context.ownerId, ...(await placeOf(context.db, input.token)) }, () => context.db.transaction(async (tx) => {
    const row = await addressedTo(tx, context.ownerId, input.token);
    await requireManager(tx, row.inviterId, row);
    return grant(tx, refusedFor(context, row), context.ownerId);
  }))
);

/**
 * A new account is enrolled only on a server that creates its own people (`setup` on), and only
 * from an invitation of the organization's owner, checked when used: a manager or a server whose
 * people come from another flow grants access to existing accounts alone.
 */
async function vouched(db: Db | Tx, context: Pick<InitialContext, "setup">, row: Invitation) {
  if (context.setup === false || (await authorize(db, row.inviterId, row.organizationId, row.workspaceId)) !== "owner") throw missing();
}

/** A new account through an invitation's direct handoff, vouched for by its inviter. */
export const registerInvitation = base.input(Token.extend({
  email: Email, name: z.string().trim().min(1).max(200).refine((name) => !name.includes("\0")), password: z.string().min(8).max(128),
})).handler(async ({ context, input }) => {
  if (context.job) throw missing();
  const placed = await placeOf(context.db, input.token);
  const row = await inScope(placed, () => findInvitation(context.db, input.token, eq(workspaceInvitations.email, input.email)));
  // Before any identity or password hash: on a separate authDb the identity commits on its own.
  await inScope(placed, () => vouched(context.db, context, row));
  refusedFor(context, row);
  const userId = newId("user");
  // As the new person in the invitation's workspace, from the identity on.
  return inScope({ userId, ...placed }, () => withIdentity(context, async (tx) => {
    const [created] = await tx.insert(user).values({ id: userId, email: input.email, name: input.name })
      .onConflictDoNothing({ target: user.email }).returning({ id: user.id });
    if (!created) throw missing();
    const password = await (await context.auth.$context).password.hash(input.password);
    await tx.insert(account).values({ id: newId("acct"), userId, accountId: userId, providerId: "credential", password });
  }, async (tx) => {
    await vouched(tx, context, row);
    return grant(tx, row, userId);
  }));
});
