import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ToolCaller } from "../cloud/runner.ts";
import { recordToolSpec, withRecordResult } from "../cloud/record-result.ts";
import type { RowDetails } from "../data/rows.ts";
import type { RecordResult } from "../messages/record-result.ts";
import type { Db } from "../db/client.ts";
import { runs, stepRuns } from "../db/schema.ts";
import { callPlatformTool, toolsOf, type JobIdentity, type PlatformApp } from "./call.ts";

const PREFIX = "platform:";

/** Only the already-authorized, filtered rows_get output is a display source. */
function recordOf(row: RowDetails): RecordResult {
  return {
    kind: "record", tableId: row.tableId, rowId: row.id,
    fields: row.fields.filter((field) => Object.hasOwn(row.values, field.id)).map((field) => {
      let value = row.values[field.id] ?? null;
      if (field.type === "single-select") value = field.choiceLabel ?? null;
      else if (field.type === "reference") value = typeof value === "string" ? row.references[value]?.label ?? null : null;
      else if (field.type === "attachment") value = Array.isArray(value) ? value.flatMap((id) => row.attachments[id] ? [row.attachments[id]!.name] : []) : null;
      return { id: field.id, name: field.name, type: field.type, value };
    }),
  };
}

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
      return (await toolsOf(db, job)).map((tool) => {
        const spec = {
          key: `${PREFIX}${tool.name}`,
          label: tool.name,
          spec: { name: "", description: tool.description, inputSchema: z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown> },
          ask: false as const,
        };
        return tool.name === "rows_get" ? recordToolSpec(spec) : spec;
      });
    },
    async call(sessionId, key, args) {
      const job = await jobOfSession(app().db, sessionId);
      if (!job || !key.startsWith(PREFIX)) return { text: "This tool is not available.", isError: true };
      const result = await callPlatformTool(app(), job, key.slice(PREFIX.length), args);
      if (!result.ok) return { text: result.error, isError: true };
      const outcome = { text: JSON.stringify(result.output ?? null), isError: false };
      return key === `${PREFIX}rows_get` ? withRecordResult(outcome, recordOf(result.output as RowDetails)) : outcome;
    },
  };
}
