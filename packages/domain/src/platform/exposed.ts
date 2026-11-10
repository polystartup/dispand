import { JOB_TOOLS_SERVER } from "@dispand/runner-protocol";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { setAsk } from "../agents/tool-ask.ts";
import type { Db } from "../db/client.ts";
import { runs } from "../db/schema.ts";
import { toolingOf } from "../engine/tooling.ts";

// How an agent's HTTP tools are named for a Job's CLI session (the tools endpoint), and what a
// name stands for. Apart from the endpoint so the engine can say, on a question, which tool and
// action a call is for.

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
    .select({ ownerId: runs.ownerId, snapshot: runs.snapshot })
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

/**
 * Which tool and action a permission question is about, when it is one of a Job's exposed
 * tools: the name alone is words cut short and a mark, so the owner is told in full.
 */
export async function aboutExposed(db: Db, job: { runId: string; ownerId: string; agentId: string }, toolName: string): Promise<{ tool: string; action: string; description: string } | null> {
  if (!toolName.startsWith(PREFIX)) return null;
  const item = (await exposedTools(db, job)).find((t) => askedName(t.name) === toolName);
  return item ? { tool: item.tool, action: item.action, description: item.description } : null;
}

/** Whether a tool name is one of the Job's tools server's, whatever it stands for. */
export const isExposedName = (toolName: string) => toolName.startsWith(PREFIX);

/**
 * The owner's "always allow" to a CLI session's approval: the action the name stands for, on
 * the run's agent, stops asking. False when the name stands for no action the agent chose (one
 * that is gone, a tool that only comes with a skill, a run that ended): nothing was granted.
 */
export async function stopAsking(db: Db, runId: string, toolName: string): Promise<boolean> {
  if (!isExposedName(toolName)) return false;
  const [run] = await db.select({ ownerId: runs.ownerId, agentId: runs.agentId }).from(runs).where(eq(runs.id, runId));
  if (!run?.agentId) return false;
  const item = (await exposedTools(db, { runId, ownerId: run.ownerId, agentId: run.agentId })).find((t) => askedName(t.name) === toolName);
  return item ? setAsk(db, run.ownerId, { agentId: run.agentId, toolId: item.toolId, action: item.action, ask: false }) : false;
}
