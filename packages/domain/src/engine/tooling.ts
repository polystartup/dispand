import { JOB_SERVER_NAME } from "@dispand/runner-protocol";
import { and, eq, inArray } from "drizzle-orm";
import { skillsAndTools } from "../agents/skills-and-tools.ts";
import type { Db } from "../db/client.ts";
import { agents, runs, stepRuns, tools, workflowVersions, type AgentSnapshot } from "../db/schema.ts";
import { nodesOf } from "../workflows/model.ts";

// What a session's agent gives it: its skill packages and its tools. For a Job, what its
// snapshot holds and the agent still has (rights shrink with the agent and never grow after
// the Job was created); for a workflow run, the agent's as they are.

type ToolRow = typeof tools.$inferSelect;

export type Tooling = {
  skills: { packageId: string; name: string }[];
  /** Tools that run on a runner: `tool` is the name of the runner's own MCP server. */
  runnerTools: { name: string; tool: string; runnerId: string }[];
  /** Tools reached by URL: called on the server only, where their sealed headers stay. */
  httpTools: ToolRow[];
};

/** What a runner accepts as a skill's name (the protocol's rule): others are left out, or it would refuse the start. */
const SKILL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export async function toolingOf(db: Db, run: { ownerId: string; snapshot: AgentSnapshot | null }, agentId: string): Promise<Tooling> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, run.ownerId)));
  if (!agent) return { skills: [], runnerTools: [], httpTools: [] };
  const now = await skillsAndTools(db, agentId);
  const snapshot = run.snapshot;
  const skills = now.skills.filter((s) => SKILL_NAME.test(s.name) && (!snapshot || snapshot.skills.some((k) => k.packageId === s.packageId)));
  const toolIds = now.tools.map((t) => t.toolId).filter((id) => !snapshot || snapshot.tools.some((t) => t.toolId === id));
  const rows = toolIds.length
    ? await db
        .select()
        .from(tools)
        .where(and(inArray(tools.id, toolIds), eq(tools.ownerId, run.ownerId)))
    : [];
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return {
    skills,
    runnerTools: rows.flatMap((t) => (t.kind === "runner" && t.runnerId && t.runnerTool ? [{ name: t.name, tool: t.runnerTool, runnerId: t.runnerId }] : [])),
    httpTools: rows.filter((t) => t.kind === "http"),
  };
}

const RESERVED = new Set(["dispand", JOB_SERVER_NAME]);

/**
 * A session server name for a tool, added to `taken`: lowercase words joined by single `_`
 * (what the protocol accepts: a CLI names tools `mcp__<server>__<tool>`), at most 64
 * characters, never a reserved name or one already taken (`_2`, `_3`… then).
 */
export function serverName(toolName: string, taken: Set<string>): string {
  const base =
    toolName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64)
      .replace(/_+$/, "") || "tool";
  let name = base;
  for (let i = 2; RESERVED.has(name) || taken.has(name); i++) {
    const suffix = `_${i}`;
    name = `${base.slice(0, 64 - suffix.length).replace(/_+$/, "")}${suffix}`;
  }
  taken.add(name);
  return name;
}

const NONE: Tooling = { skills: [], runnerTools: [], httpTools: [] };

/**
 * What the session `sessionId` gets from its agent: the Job's agent, or the agent of the
 * workflow run's node (from the version the run started on). Nothing for a session nobody
 * started.
 */
export async function sessionTooling(db: Db, sessionId: string): Promise<Tooling> {
  const [found] = await db
    .select({ nodeId: stepRuns.nodeId, run: runs })
    .from(stepRuns)
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(eq(stepRuns.sessionId, sessionId));
  if (!found) return NONE;
  const { run, nodeId } = found;
  let agentId = run.agentId ?? undefined;
  if (!agentId) {
    const def =
      run.def ??
      (run.workflowId
        ? (
            await db
              .select({ def: workflowVersions.def })
              .from(workflowVersions)
              .where(and(eq(workflowVersions.workflowId, run.workflowId), eq(workflowVersions.version, run.version)))
          )[0]?.def
        : undefined);
    agentId = def ? nodesOf(def).find((n) => n.id === nodeId)?.agentId || undefined : undefined;
  }
  return agentId ? toolingOf(db, run, agentId) : NONE;
}
