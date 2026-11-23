import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { inScope } from "../db/scope.ts";
import { organizationMembers, workspaceMembers, workspaces } from "../db/schema.ts";

/** A person's role in a workspace: an organization owner is `owner` in each of its workspaces. */
export type Role = "owner" | "manager" | "member";
/** Who a call is made for and in which workspace. A Job's `role` is `member` at most. */
export type Access = { organizationId: string; workspaceId: string; userId: string | null; role: Role | null };

/** The request headers naming the workspace a page works in. */
export const ORGANIZATION_HEADER = "dispand-organization";
export const WORKSPACE_HEADER = "dispand-workspace";

/** The workspaces this person can open, with their organization role and workspace role. */
function openable(db: Db | Tx, userId: string) {
  return db.select({
    organizationId: workspaces.organizationId, workspaceId: workspaces.id, name: workspaces.name,
    organizationRole: organizationMembers.role, workspaceRole: workspaceMembers.role,
  }).from(workspaces)
    .innerJoin(organizationMembers, and(eq(organizationMembers.organizationId, workspaces.organizationId), eq(organizationMembers.userId, userId)))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)));
}

const roleOf = (row: { organizationRole: string; workspaceRole: string | null }): Role | null =>
  row.organizationRole === "owner" ? "owner" : (row.workspaceRole as Role | null);

/** The person's current role in the organization's workspace, or null: one query, never cached, so a removal applies on the next call. */
export async function authorize(db: Db | Tx, userId: string, organizationId: string, workspaceId: string): Promise<Role | null> {
  const [row] = await openable(db, userId).where(and(eq(workspaces.id, workspaceId), eq(workspaces.organizationId, organizationId)));
  return row ? roleOf(row) : null;
}

/**
 * The workspace a request names in its headers; with neither header, the only workspace the person
 * can open, so a page that sends none (one open during an upgrade) keeps working. It checks no
 * access: `authorize` does.
 */
export async function resolveWorkspace(db: Db | Tx, userId: string, headers: Headers): Promise<{ organizationId: string; workspaceId: string } | null> {
  const organizationId = headers.get(ORGANIZATION_HEADER);
  const workspaceId = headers.get(WORKSPACE_HEADER);
  if (organizationId !== null || workspaceId !== null) return organizationId && workspaceId ? { organizationId, workspaceId } : null;
  const rows = await mine(db, userId).limit(2);
  return rows.length === 1 ? { organizationId: rows[0]!.organizationId, workspaceId: rows[0]!.workspaceId } : null;
}

/** The workspaces this person can open, by organization then name. */
export function mine(db: Db | Tx, userId: string) {
  return openable(db, userId)
    .where(or(eq(organizationMembers.role, "owner"), isNotNull(workspaceMembers.userId)))
    .orderBy(asc(workspaces.organizationId), asc(workspaces.name), asc(workspaces.id));
}

/** `mine` as a page lists it. */
export async function listMine(db: Db | Tx, userId: string) {
  return (await mine(db, userId)).map((row) => ({ organizationId: row.organizationId, workspaceId: row.workspaceId, name: row.name, role: roleOf(row)! }));
}

/** Whether the person owns the organization, read live. */
export async function ownsOrganization(db: Db | Tx, userId: string, organizationId: string): Promise<boolean> {
  const [row] = await db.select({ role: organizationMembers.role }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId), eq(organizationMembers.role, "owner")));
  return row !== undefined;
}

/**
 * For an entry that only a row names the workspace of (a file, an OAuth callback): `placed` was
 * read under SYSTEM from that row. Runs `work` in `{ userId, ...placed }` once `authorize` (under
 * the person alone) admits them there; null when it doesn't, or when there is no such row.
 */
export async function asMember<T>(db: Db, userId: string, placed: { organizationId: string; workspaceId: string } | undefined, work: () => Promise<T>): Promise<T | null> {
  if (!placed) return null;
  const role = await inScope({ userId }, () => authorize(db, userId, placed.organizationId, placed.workspaceId));
  return role ? inScope({ userId, ...placed }, work) : null;
}
