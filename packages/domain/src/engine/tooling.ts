import { createHash } from "node:crypto";
import { JOB_SERVER_NAME, JOB_TOOLS_SERVER } from "@dispand/runner-protocol";
import { and, eq, inArray } from "drizzle-orm";
import { skillsAndTools } from "../agents/skills-and-tools.ts";
import type { Db } from "../db/client.ts";
import { agents, agentTools, runs, stepRuns, tools, workflowVersions, type AgentSnapshot } from "../db/schema.ts";
import { nodesOf } from "../workflows/model.ts";

// What a session's agent gives it: its skill packages and its tools. For a Job, what its
// snapshot holds and the agent still has (rights shrink with the agent and never grow after
// the Job was created); for a workflow run, the agent's as they are.

type ToolRow = typeof tools.$inferSelect;

export type Tooling = {
  skills: { packageId: string; name: string }[];
  /**
   * Tools that run on a runner: `tool` is the name of the runner's own MCP server. `unasked`
   * names the actions that run without asking the owner, as the agent has them now.
   */
  runnerTools: { id: string; name: string; tool: string; runnerId: string; actions: ToolRow["actions"]; unasked: string[]; denied: string[] }[];
  /**
   * Tools reached by URL: called on the server only, where their sealed headers stay. `unasked`
   * names the actions that run without asking the owner, as the agent has them now.
   */
  httpTools: (ToolRow & { unasked: string[]; chosen: boolean })[];
  /** The agent they come from, when there is one. */
  agentId?: string;
  /** The Job the session is a session of; none for a workflow run's. */
  jobId?: string;
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
  const chosen = await db.select({ toolId: agentTools.toolId, unasked: agentTools.unasked, denied: agentTools.denied }).from(agentTools).where(eq(agentTools.agentId, agentId));
  return {
    skills,
    runnerTools: rows.flatMap((t) =>
      t.kind === "runner" && t.runnerId && t.runnerTool
        ? [{ id: t.id, name: t.name, tool: t.runnerTool, runnerId: t.runnerId, actions: t.actions.filter((a) => !chosen.find((c) => c.toolId === t.id)?.denied.includes(a.name)), unasked: chosen.find((c) => c.toolId === t.id)?.unasked ?? [], denied: chosen.find((c) => c.toolId === t.id)?.denied ?? [] }]
        : [],
    ),
    // `chosen`: the agent's own choice, which carries the unasked actions; a tool that only comes with a skill has none.
    httpTools: rows.filter((t) => t.kind === "http").map((t) => {
      const mine = chosen.find((c) => c.toolId === t.id);
      return { ...t, actions: t.actions.filter((a) => !mine?.denied.includes(a.name)), unasked: mine?.unasked ?? [], chosen: mine !== undefined };
    }),
    agentId,
  };
}

const RESERVED = new Set(["dispand", JOB_SERVER_NAME, JOB_TOOLS_SERVER]);

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

/**
 * The runner tools a CLI session on `runnerId` gets, each under its session server name: its
 * CLI names their actions `mcp__<server>__<action>`. The one rule for the start and for telling
 * which tool a question is about.
 */
/** A session binding survives renames and removals; retargeting creates a different binding. */
export function runnerServerName(tool: { id: string; runnerId: string; tool: string }): string {
  return `tool_${createHash("sha256").update(JSON.stringify([tool.id, tool.runnerId, tool.tool])).digest("hex").slice(0, 24)}`;
}

export function runnerServers(tooling: Pick<Tooling, "runnerTools">, runnerId: string): (Tooling["runnerTools"][number] & { server: string })[] {
  return tooling.runnerTools
    .filter((t) => t.runnerId === runnerId)
    .slice(0, 20)
    .map((t) => ({ ...t, server: runnerServerName(t) }));
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
  // A Job of a deleted agent has none of it.
  if (run.source === "agent" && !run.agentId) return NONE;
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
  if (!agentId) return NONE;
  const tooling = await toolingOf(db, run, agentId);
  return run.source === "agent" ? { ...tooling, jobId: run.id } : tooling;
}
