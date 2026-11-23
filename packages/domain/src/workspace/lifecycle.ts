import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record.ts";
import type { Tx } from "../db/client.ts";
import { inScope } from "../db/scope.ts";
import { organizationMembers, organizations, workspaces } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { message } from "../messages/index.ts";
import { seedMarketplaces } from "../plugins/marketplace-procedures.ts";
import { base, manager, orgOwner } from "../rpc/context.ts";
import { StorableText } from "../text.ts";
import { authorizeOrganization } from "./authorize.ts";

/** An organization's or a workspace's name, as people type it. */
export const DisplayName = z.string().trim().min(1).pipe(StorableText(120));

/**
 * Writes an organization, its owner's membership and its first workspace, with the ids given (an
 * entry may have allocated them already). It touches no Better Auth table: the person exists.
 */
export async function bootstrapOrganization(tx: Tx, input: { userId: string; organizationId: string; workspaceId: string; name?: string; workspaceName?: string }): Promise<void> {
  await tx.insert(organizations).values({ id: input.organizationId, name: input.name });
  await tx.insert(organizationMembers).values({ organizationId: input.organizationId, userId: input.userId, role: "owner" });
  await tx.insert(workspaces).values({ id: input.workspaceId, organizationId: input.organizationId, name: input.workspaceName });
}

/**
 * Creates a workspace in the organization, for its owner: in the organization's scope, then its
 * built-in marketplaces in its own. The install's limit (`dispand_workspace_limit()`) may refuse it,
 * with its message.
 */
const create = base.use(orgOwner).input(z.object({ name: DisplayName })).handler(async ({ context, input }) => {
  const { organizationId } = context.access;
  const workspaceId = newId("ws");
  await context.db.transaction(async (tx) => {
    if (!(await authorizeOrganization(tx, context.ownerId, organizationId))) throw new ORPCError("NOT_FOUND", message("workspace.membershipNotFound"));
    await tx.insert(workspaces).values({ id: workspaceId, organizationId, name: input.name });
    await recordAudit(tx, { workspaceId, ownerId: context.ownerId, actor: { type: "user", userId: context.ownerId }, action: "workspace.created", resource: { type: "workspace", id: workspaceId } });
  });
  await inScope({ userId: context.ownerId, organizationId, workspaceId }, () => context.db.transaction((tx) => seedMarketplaces(tx, context.ownerId, workspaceId)));
  return { organizationId, workspaceId };
});

/** Renames the workspace the request names: its manager's or the organization owner's. */
const rename = base.use(manager).input(z.object({ name: DisplayName })).handler(async ({ context, input }) => {
  const { workspaceId } = context.access;
  await context.db.transaction(async (tx) => {
    await tx.update(workspaces).set({ name: input.name }).where(eq(workspaces.id, workspaceId));
    await recordAudit(tx, { workspaceId, ownerId: context.actorId, actor: { type: "user", userId: context.actorId }, action: "workspace.renamed", resource: { type: "workspace", id: workspaceId } });
  });
  return { name: input.name };
});

export const lifecycle = { create, rename };
