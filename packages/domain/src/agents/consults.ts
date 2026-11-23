import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agentConsults, agents } from "../db/schema.ts";
import { type Message, say } from "../messages/index.ts";

// Consults: an agent asks another agent one question mid-Job. Who may consult whom is listed on
// the asking agent (`agent_consults`), each entry a grant. A question steers the agent that
// answers it and an answer steers the one that asked, so a pair stays on one side of
// `configure`: both agents have it, or neither has.

/** Who an agent may ask: nobody, everyone the rules allow, or those picked. Reused for people. */
export type RoutingMode = "disabled" | "auto" | "whitelist";
export const ROUTING_MODES = ["disabled", "auto", "whitelist"] as const satisfies readonly RoutingMode[];

export type ConsultEntry = { agentId: string };

/** The consult mode a definition sets: its own, else whitelist when it lists agents to consult, as consults worked before modes. */
export function definedConsultMode(d: { consultMode?: RoutingMode; consults: unknown[] }): RoutingMode {
  return d.consultMode ?? (d.consults.length ? "whitelist" : "disabled");
}


/** At most this many agents in a Job's consult tool, as a whitelist holds. */
export const MAX_CONSULTS = 50;

/**
 * Why `askerId` may not consult `consultedId`, or null when the pair is allowed: never itself,
 * both in this workspace, and both with `configure` or both without, as the agents are now. Checked
 * when an entry is made, and again at each consult.
 */
export async function pairProblem(db: Db | Tx, workspaceId: string, askerId: string, consultedId: string): Promise<Message | null> {
  if (askerId === consultedId) return say("agent.consult.self");
  const rows = await db
    .select({ id: agents.id, name: agents.name, bundles: agents.bundles })
    .from(agents)
    .where(and(inArray(agents.id, [askerId, consultedId]), eq(agents.workspaceId, workspaceId)));
  const asker = rows.find((r) => r.id === askerId);
  const consulted = rows.find((r) => r.id === consultedId);
  if (!asker || !consulted) return say("agent.notFound");
  const configures = (a: { bundles: string[] }) => a.bundles.includes("configure");
  if (configures(asker) !== configures(consulted)) {
    const [has, hasNot] = configures(asker) ? [asker, consulted] : [consulted, asker];
    return say("agent.consult.sides", { changes: has.name, keeps: hasNot.name });
  }
  return null;
}

/** The agents `agentId` lists (its whitelist, kept whatever its mode), in a stable order. */
export async function consultsOf(db: Db | Tx, agentId: string): Promise<ConsultEntry[]> {
  return db
    .select({ agentId: agentConsults.consultedId })
    .from(agentConsults)
    .where(eq(agentConsults.agentId, agentId))
    .orderBy(asc(agentConsults.consultedId));
}

/**
 * Replaces the agents `agentId` may consult. An entry it didn't have must pass `pairProblem`
 * (refused with the reason); one it keeps stays even if a bundle change broke the pair since:
 * it is shown inactive and refused at the call.
 */
export async function setConsults(tx: Tx, workspaceId: string, agentId: string, entries: ConsultEntry[]): Promise<Message | null> {
  const kept = new Set((await consultsOf(tx, agentId)).map((e) => e.agentId));
  for (const entry of entries) {
    if (kept.has(entry.agentId)) continue;
    const problem = await pairProblem(tx, workspaceId, agentId, entry.agentId);
    if (problem) return problem;
  }
  await tx.delete(agentConsults).where(eq(agentConsults.agentId, agentId));
  if (entries.length) await tx.insert(agentConsults).values(entries.map((e) => ({ agentId, consultedId: e.agentId })));
  return null;
}

/**
 * The agents `agentId` may consult now, as its mode says: those listed (whitelist), every agent
 * `pairProblem` allows it (auto), or none (disabled). By name, at most `MAX_CONSULTS`; with `only`, that agent if it may.
 * `shortcut: name order is arbitrary above 50; rank by use when a workspace hits it.`
 */
export async function consultRights(db: Db | Tx, agentId: string, only?: string): Promise<{ id: string; name: string; description: string }[]> {
  const [asker] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!asker || asker.consultMode === "disabled") return [];
  const target = { id: agents.id, name: agents.name, description: agents.description };
  // pairProblem's rules as a query: in the workspace, on the asker's side of `configure`, never itself.
  const allowed = and(
    eq(agents.workspaceId, asker.workspaceId),
    ne(agents.id, asker.id),
    sql`(${agents.bundles} ? 'configure') = ${asker.bundles.includes("configure")}`,
    // One agent's right is checked whatever the cap: an agent created or renamed elsewhere never takes it back.
    only === undefined ? undefined : eq(agents.id, only),
  );
  const listed = asker.consultMode === "whitelist" ? inArray(agents.id, db.select({ id: agentConsults.consultedId }).from(agentConsults).where(eq(agentConsults.agentId, agentId))) : undefined;
  return db.select(target).from(agents).where(and(allowed, listed)).orderBy(asc(agents.name), asc(agents.id)).limit(MAX_CONSULTS);
}
