import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, agentSkills, agentTools, runs, skillPackages, workflows, workflowVersions } from "../db/schema.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The name of an agent that uses the skill package, if any. */
export async function agentUsingPackage(db: Db | Tx, packageId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ name: agents.name })
    .from(agentSkills)
    .innerJoin(agents, eq(agents.id, agentSkills.agentId))
    .where(eq(agentSkills.packageId, packageId))
    .limit(1);
  return row?.name;
}

/**
 * Why the tool can't go: an agent that has it explicitly, a skill package (of its owner) that
 * requires it, since every agent with that package gets it, or a Tool step of a workflow's current
 * version or of the version a run still going is on. Undefined when nothing holds it.
 */
export async function toolHolder(db: Db | Tx, ownerId: string, toolId: string): Promise<string | undefined> {
  const [agent] = await db
    .select({ name: agents.name })
    .from(agentTools)
    .innerJoin(agents, eq(agents.id, agentTools.agentId))
    .where(eq(agentTools.toolId, toolId))
    .limit(1);
  if (agent) return `The agent “${agent.name}” uses this tool`;
  const [pkg] = await db
    .select({ name: skillPackages.name })
    .from(skillPackages)
    .where(and(eq(skillPackages.ownerId, ownerId), sql`${skillPackages.requiredToolIds} @> ${JSON.stringify([toolId])}::jsonb`))
    .limit(1);
  if (pkg) return `The skill “${pkg.name}” requires this tool`;
  const usesTool = sql`${workflowVersions.def} -> 'steps' @> ${JSON.stringify([{ type: "tool", toolId }])}::jsonb`;
  const [workflow] = await db
    .select({ name: workflows.name })
    .from(workflows)
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.version, workflows.currentVersion)))
    .where(and(eq(workflows.ownerId, ownerId), usesTool))
    .limit(1);
  if (workflow) return `The workflow “${workflow.name}” uses this tool`;
  const [run] = await db
    .select({ name: workflows.name })
    .from(runs)
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, runs.workflowId), eq(workflowVersions.version, runs.version)))
    .innerJoin(workflows, eq(workflows.id, runs.workflowId))
    .where(and(eq(runs.ownerId, ownerId), inArray(runs.status, ["running", "waiting"]), usesTool))
    .limit(1);
  if (run) return `A run of the workflow “${run.name}” still uses this tool`;
  return undefined;
}
