import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agentConsults, agents } from "../db/schema.ts";

// Consults: an agent asks another agent one question mid-Job. Who may consult whom is listed on
// the asking agent (`agent_consults`), each entry a grant. A question steers the agent that
// answers it and an answer steers the one that asked, so a pair stays on one side of
// `configure`: both agents have it, or neither has.

export type ConsultEntry = { agentId: string; ask: boolean };

/**
 * Why `askerId` may not consult `consultedId`, or null when the pair is allowed: never itself,
 * both the owner's, and both with `configure` or both without, as the agents are now. Checked
 * when an entry is made, and again at each consult.
 */
export async function pairProblem(db: Db | Tx, ownerId: string, askerId: string, consultedId: string): Promise<string | null> {
  if (askerId === consultedId) return "An agent can't consult itself";
  const rows = await db
    .select({ id: agents.id, name: agents.name, bundles: agents.bundles })
    .from(agents)
    .where(and(inArray(agents.id, [askerId, consultedId]), eq(agents.ownerId, ownerId)));
  const asker = rows.find((r) => r.id === askerId);
  const consulted = rows.find((r) => r.id === consultedId);
  if (!asker || !consulted) return "Agent not found";
  const configures = (a: { bundles: string[] }) => a.bundles.includes("configure");
  if (configures(asker) !== configures(consulted)) {
    const [has, hasNot] = configures(asker) ? [asker, consulted] : [consulted, asker];
    return `${has.name} changes the workspace and ${hasNot.name} doesn't: an agent that changes the workspace and one that doesn't never consult each other`;
  }
  return null;
}

/** The agents `agentId` may consult, in a stable order. */
export async function consultsOf(db: Db | Tx, agentId: string): Promise<ConsultEntry[]> {
  return db
    .select({ agentId: agentConsults.consultedId, ask: agentConsults.ask })
    .from(agentConsults)
    .where(eq(agentConsults.agentId, agentId))
    .orderBy(asc(agentConsults.consultedId));
}

/**
 * Replaces the agents `agentId` may consult. An entry it didn't have must pass `pairProblem`
 * (refused with the reason); one it keeps stays even if a bundle change broke the pair since:
 * it is shown inactive and refused at the call.
 */
export async function setConsults(tx: Tx, ownerId: string, agentId: string, entries: ConsultEntry[]): Promise<string | null> {
  const kept = new Set((await consultsOf(tx, agentId)).map((e) => e.agentId));
  for (const entry of entries) {
    if (kept.has(entry.agentId)) continue;
    const problem = await pairProblem(tx, ownerId, agentId, entry.agentId);
    if (problem) return problem;
  }
  await tx.delete(agentConsults).where(eq(agentConsults.agentId, agentId));
  if (entries.length) await tx.insert(agentConsults).values(entries.map((e) => ({ agentId, consultedId: e.agentId, ask: e.ask })));
  return null;
}
