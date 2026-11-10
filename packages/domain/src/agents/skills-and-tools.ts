import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agentSkills, agentTools, skillPackages, tools as toolsTable } from "../db/schema.ts";
import { effectiveTools } from "./tools.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * An agent's skill packages and the tools it gets: explicit ones, and the ones its packages
 * require (locked). Apart from the procedures so the engine reads it too, for a Job's snapshot.
 */
export async function skillsAndTools(db: Db | Tx, agentId: string) {
  const pkgs = await db
    .select({ packageId: skillPackages.id, name: skillPackages.name, requiredToolIds: skillPackages.requiredToolIds })
    .from(agentSkills)
    .innerJoin(skillPackages, eq(skillPackages.id, agentSkills.packageId))
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(skillPackages.name));
  const explicit = await db.select({ toolId: agentTools.toolId }).from(agentTools).where(eq(agentTools.agentId, agentId));
  const effective = effectiveTools(
    explicit.map((t) => t.toolId),
    pkgs,
  );
  const toolRows = effective.length
    ? await db
        .select({ id: toolsTable.id, name: toolsTable.name, kind: toolsTable.kind })
        .from(toolsTable)
        .where(inArray(
          toolsTable.id,
          effective.map((t) => t.toolId),
        ))
    : [];
  const tools = effective
    .flatMap((t) => {
      const tool = toolRows.find((r) => r.id === t.toolId);
      return tool ? [{ ...t, name: tool.name, kind: tool.kind }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { skills: pkgs.map(({ packageId, name }) => ({ packageId, name })), tools };
}
