import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agentEscalations, agents, organizationMembers, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { type Message, say } from "../messages/index.ts";
import type { RoutingMode } from "./consults.ts";

// Escalations: an agent asks a person a question outside a chat. Who it may ask is its
// `escalate_mode`: nobody, every member with a profile (auto), or those a person picked
// (`agent_escalations`). Only members count, read live: the people `authorize` admits to the
// agent's workspace, its organization's owner included.

/** At most this many people in a Job's ask tool, as a whitelist holds. */
export const MAX_ESCALATIONS = 50;

/** The escalation mode a definition sets: its own, else disabled. A plugin never names people. */
export function definedEscalateMode(d: { escalateMode?: RoutingMode }): RoutingMode {
  return d.escalateMode ?? "disabled";
}

export type Person = { id: string; name: string; description: string | null };

/** Whether a user is a member of the workspace now, as `authorize` admits them: in its workspace members, or its organization's owner. */
const memberOf = (workspaceId: string) =>
  sql<boolean>`exists (select 1 from ${workspaces} w join ${organizationMembers} om on om.organization_id = w.organization_id and om.user_id = ${user.id}
    left join ${workspaceMembers} wm on wm.workspace_id = w.id and wm.user_id = ${user.id}
    where w.id = ${workspaceId} and (om.role = 'owner' or wm.user_id is not null))`;

/** The workspace's members now, by name: who an escalation may reach. */
export async function members(db: Db | Tx, workspaceId: string): Promise<Person[]> {
  return db
    .select({ id: user.id, name: user.name, description: user.description })
    .from(user)
    .where(memberOf(workspaceId))
    .orderBy(asc(user.name), asc(user.id));
}

/** The people `agentId` lists (its whitelist, kept whatever its mode), each with whether they are a member now. */
export async function escalationsOf(db: Db | Tx, agentId: string): Promise<{ userId: string; name: string; member: boolean; profile: boolean }[]> {
  const [agent] = await db.select({ workspaceId: agents.workspaceId }).from(agents).where(eq(agents.id, agentId));
  if (!agent) return [];
  return db
    .select({
      userId: agentEscalations.userId,
      name: user.name,
      member: memberOf(agent.workspaceId),
      profile: sql<boolean>`coalesce(${user.description}, '') <> ''`,
    })
    .from(agentEscalations)
    .innerJoin(user, eq(user.id, agentEscalations.userId))
    .where(eq(agentEscalations.agentId, agentId))
    .orderBy(asc(user.name), asc(user.id));
}

/**
 * Replaces the people `agentId` may ask. A person it didn't list must be a member now (refused
 * otherwise); one it keeps stays even after leaving: shown so, and skipped.
 */
export async function setEscalations(tx: Tx, workspaceId: string, agentId: string, userIds: string[]): Promise<Message | null> {
  const had = new Set((await tx.select({ id: agentEscalations.userId }).from(agentEscalations).where(eq(agentEscalations.agentId, agentId))).map((r) => r.id));
  const added = userIds.filter((id) => !had.has(id));
  if (added.length) {
    const found = await tx.select({ id: user.id }).from(user).where(and(inArray(user.id, added), memberOf(workspaceId)));
    if (found.length !== new Set(added).size) return say("agent.escalation.notMember");
  }
  await tx.delete(agentEscalations).where(eq(agentEscalations.agentId, agentId));
  if (userIds.length) await tx.insert(agentEscalations).values(userIds.map((userId) => ({ agentId, userId })));
  return null;
}

/**
 * The people `agentId` may ask now, as its mode says: those listed who are members (whitelist),
 * every member with a profile (auto), or none (disabled). By name, at most `MAX_ESCALATIONS`;
 * with `only`, that person if they may be asked.
 * `shortcut: name order is arbitrary above 50; rank by fit or use when a workspace hits it.`
 */
export async function escalationRights(db: Db | Tx, agentId: string, only?: string): Promise<Person[]> {
  const [agent] = await db.select({ workspaceId: agents.workspaceId, mode: agents.escalateMode }).from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.mode === "disabled") return [];
  const picked =
    agent.mode === "whitelist"
      ? inArray(user.id, db.select({ id: agentEscalations.userId }).from(agentEscalations).where(eq(agentEscalations.agentId, agentId)))
      : and(isNotNull(user.description), ne(user.description, ""));
  return db
    .select({ id: user.id, name: user.name, description: user.description })
    .from(user)
    .where(and(memberOf(agent.workspaceId), picked, only === undefined ? undefined : eq(user.id, only)))
    .orderBy(asc(user.name), asc(user.id))
    .limit(MAX_ESCALATIONS);
}
