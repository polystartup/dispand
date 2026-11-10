import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ToolCaller } from "../cloud/runner.ts";
import type { Db } from "../db/client.ts";
import { runs, stepRuns } from "../db/schema.ts";
import { callPlatformTool, toolsOf, type JobIdentity, type PlatformApp } from "./call.ts";

const PREFIX = "platform:";

/** The Job a cloud session works for; none for a workflow run's session. */
async function jobOfSession(db: Db, sessionId: string): Promise<JobIdentity | null> {
  const [row] = await db
    .select({ runId: runs.id, ownerId: runs.ownerId, agentId: runs.agentId })
    .from(stepRuns)
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(and(eq(stepRuns.sessionId, sessionId), eq(runs.source, "agent")));
  return row?.agentId ? { runId: row.runId, ownerId: row.ownerId, agentId: row.agentId } : null;
}

/**
 * Dispand's own tools for cloud sessions: the tools the session's Job may use, called in
 * process through `callPlatformTool` (the authorization the Job endpoint uses too), without a
 * permission question. `app` is read at call time: the engine it holds is built after this.
 */
export function platformToolCaller(app: () => PlatformApp): ToolCaller {
  return {
    async specs(sessionId) {
      const { db } = app();
      const job = await jobOfSession(db, sessionId);
      if (!job) return [];
      return (await toolsOf(db, job)).map((tool) => ({
        key: `${PREFIX}${tool.name}`,
        label: tool.name,
        spec: { name: "", description: tool.description, inputSchema: z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown> },
        ask: false as const,
      }));
    },
    async call(sessionId, key, args) {
      const job = await jobOfSession(app().db, sessionId);
      if (!job || !key.startsWith(PREFIX)) return { text: "This tool is not available.", isError: true };
      const result = await callPlatformTool(app(), job, key.slice(PREFIX.length), args);
      return result.ok ? { text: JSON.stringify(result.output ?? null), isError: false } : { text: result.error, isError: true };
    },
  };
}
