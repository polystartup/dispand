import { sql } from "drizzle-orm";
import { agents, runs } from "../db/schema.ts";

// A Job outlives its agent (`Engine.deleteAgents`): it keeps the name the agent had when it was
// deleted (`runs.agent_name`), and shows it marked. One form everywhere a Job names its agent.

/** How a Job names its deleted agent: "Order drafter (Deleted)". */
export function deletedAgent(name: string): string {
  return `${name} (Deleted)`;
}

/** A Job's agent's name: as the agent is now, or, once deleted, as its Job kept it, marked. Null for a workflow run. */
export function jobAgentName(now: string | null | undefined, kept: string | null): string | null {
  return now ?? (kept === null ? null : deletedAgent(kept));
}

/** `jobAgentName` in SQL, for a select from `runs` left-joined to `agents` on its agent. */
export const jobAgentNameSql = sql<string | null>`coalesce(${agents.name}, ${runs.agentName} || ' (Deleted)')`;
