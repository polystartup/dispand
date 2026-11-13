import { JOB_TOOLS_SERVER } from "@dispand/runner-protocol";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { rememberAllowedAction } from "../agents/tool-ask.ts";
import type { Db } from "../db/client.ts";
import { runs } from "../db/schema.ts";
import { runnerServers, toolingOf } from "../engine/tooling.ts";

// How an agent's HTTP tools are named for a Job's CLI session (the tools endpoint), and what a
// name stands for, a runner tool's included. Apart from the endpoint so the engine can say, on a
// question, which tool and action a call is for.

/** A CLI names a tool `mcp__job_tools__<name>`, and a model's tool name holds at most 64 characters. */
const PREFIX = `mcp__${JOB_TOOLS_SERVER}__`;
const MAX_NAME = 64 - PREFIX.length;

export type Exposed = { name: string; toolId: string; tool: string; action: string; description: string; inputSchema: Record<string, unknown>; /** Whether a call needs the owner's approval. */ ask: boolean };

/**
 * The name an action is exposed under: readable words, then a mark made of the tool's id and
 * the action's name alone. So a name stands for one tool and one action for good: it never
 * depends on which other tools are listed, and an approval asked under it can't come to mean
 * another action (two that read alike, a refresh that reorders them, one taken back).
 */
export function exposedName(tool: { id: string; name: string }, action: string): string {
  const mark = createHash("sha256").update(`${tool.id}\n${action}`).digest("hex").slice(0, 16);
  const words =
    `${tool.name} ${action}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, MAX_NAME - mark.length - 1)
      .replace(/_+$/, "") || "tool";
  return `${words}_${mark}`;
}

/** The actions of the HTTP tools a Job's agent gives it now, each under its name. Should two names ever be equal, neither is offered. */
export async function exposedTools(db: Db, job: { runId: string; ownerId: string; agentId: string }): Promise<Exposed[]> {
  const [run] = await db
    .select({ ownerId: runs.ownerId, snapshot: runs.snapshot, remembered: runs.remembered })
    .from(runs)
    // A Job still going: one that ended is offered nothing, and an action that needs no approval doesn't outlive it.
    .where(and(eq(runs.id, job.runId), eq(runs.ownerId, job.ownerId), eq(runs.agentId, job.agentId), inArray(runs.status, ["running", "waiting"])));
  if (!run) return [];
  const { httpTools } = await toolingOf(db, run, job.agentId);
  const all = httpTools.flatMap((tool) =>
    tool.actions.map((action) => ({ name: exposedName(tool, action.name), toolId: tool.id, tool: tool.name, action: action.name, description: action.description, inputSchema: action.inputSchema, ask: !tool.unasked.includes(action.name) })),
  );
  const count = new Map<string, number>();
  for (const item of all) count.set(item.name, (count.get(item.name) ?? 0) + 1);
  return all.filter((item) => count.get(item.name) === 1);
}

/** The name a CLI asks the owner about for an exposed tool. */
export const askedName = (name: string) => `${PREFIX}${name}`;

/** What a permission question is about, when it is one of the Job's agent's tools; `toolId` only for a runner tool. */
export type About = { tool: string; action: string; description: string; toolId?: string };

/**
 * Which tool and action a permission question is about, when it is one of a Job's exposed
 * tools (the name alone is words cut short and a mark, so the owner is told in full) or an
 * action of a runner tool the agent chose, on the session's runner. A runner tool's name is its
 * session server name (`runnerServers`), which says nothing of the tool for good: the tool it
 * stands for now is kept on the question (`toolId`), and "always allow" acts on that one.
 */
export async function aboutExposed(db: Db, job: { runId: string; ownerId: string; agentId: string; runnerId?: string | null }, toolName: string): Promise<About | null> {
  if (toolName.startsWith(PREFIX)) {
    const item = (await exposedTools(db, job)).find((t) => askedName(t.name) === toolName);
    return item ? { tool: item.tool, action: item.action, description: item.description } : null;
  }
  if (!job.runnerId) return null;
  const found = (await runnerToolsOf(db, job, job.runnerId)).find((t) => toolName.startsWith(`mcp__${t.server}__`));
  const action = found?.actions.find((a) => toolName === `mcp__${found.server}__${a.name}`);
  return found && action ? { tool: found.name, action: action.name, description: action.description, toolId: found.id } : null;
}

/** The runner tools a Job still going gets on its runner, under their session server names. */
async function runnerToolsOf(db: Db, job: { runId: string; ownerId: string; agentId: string }, runnerId: string) {
  const [run] = await db
    .select({ ownerId: runs.ownerId, snapshot: runs.snapshot, remembered: runs.remembered })
    .from(runs)
    .where(and(eq(runs.id, job.runId), eq(runs.ownerId, job.ownerId), eq(runs.agentId, job.agentId), inArray(runs.status, ["running", "waiting"])));
  return run ? runnerServers(await toolingOf(db, run, job.agentId), runnerId) : [];
}

/** Whether a tool name is one of the Job's tools server's, whatever it stands for. */
export const isExposedName = (toolName: string) => toolName.startsWith(PREFIX);

/**
 * The owner's "always allow" to a CLI session's approval: the action the name stands for, on
 * the run's agent, stops asking. For a runner tool, the one the question was about (`about`),
 * if the Job's agent still has it. False when the name stands for no action the agent chose (one
 * that is gone, a tool that only comes with a skill, a run that ended): nothing was granted.
 */
export async function stopAsking(db: Db, runId: string, toolName: string, about: About | null): Promise<boolean> {
  const [run] = await db.select({ ownerId: runs.ownerId, agentId: runs.agentId, snapshot: runs.snapshot, status: runs.status }).from(runs).where(eq(runs.id, runId));
  if (!run?.agentId) return false;
  const job = { runId, ownerId: run.ownerId, agentId: run.agentId };
  if (isExposedName(toolName)) {
    const item = (await exposedTools(db, job)).find((t) => askedName(t.name) === toolName);
    return item ? rememberAllowedAction(db, run.ownerId, { agentId: run.agentId, toolId: item.toolId, action: item.action }) : false;
  }
  // A Job that ended grants nothing, as `exposedTools` gives it nothing.
  if (!about?.toolId || (run.status !== "running" && run.status !== "waiting")) return false;
  const tooling = await toolingOf(db, run, run.agentId);
  const tool = tooling.runnerTools.find((t) => t.id === about.toolId);
  if (!tool || !runnerServers(tooling, tool.runnerId).some((t) => t.id === tool.id && toolName === `mcp__${t.server}__${about.action}`)) return false;
  return tool.actions.some((a) => a.name === about.action) ? rememberAllowedAction(db, run.ownerId, { agentId: run.agentId, toolId: tool.id, action: about.action }) : false;
}

/** A delayed persistent answer may not undo a permission or target changed since it was given. */
export async function runnerGrantCurrent(db: Db, runId: string, toolName: string, about: About): Promise<boolean> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run?.agentId || !["running", "waiting"].includes(run.status)) return false;
  const tooling = await toolingOf(db, run, run.agentId);
  const tool = tooling.runnerTools.find((t) => t.id === about.toolId);
  return !!tool && tool.unasked.includes(about.action) && runnerServers(tooling, tool.runnerId).some((t) => t.id === tool.id && toolName === `mcp__${t.server}__${about.action}`);
}
