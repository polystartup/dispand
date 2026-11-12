import type { Db } from "../db/client.ts";
import type { ToolResult } from "../tools/mcp.ts";
import { recordAuditAfter } from "./record.ts";

/**
 * A Job's call of one of its agent's tools (`tool.call`), written after the call by its two
 * callers, the cloud session's and the runner session's: the tool and the action named, how it
 * ended, never the arguments or the result.
 */
export function recordToolCall(
  db: Db,
  job: { ownerId: string; runId: string; agentId?: string | null },
  tool: { id: string; name: string },
  action: string,
  outcome: { ok: true; result: Pick<ToolResult, "isError"> } | { ok: false } | "not-approved",
): Promise<void> {
  const result = outcome === "not-approved" ? "refused" : outcome.ok && !outcome.result.isError ? "ok" : "failed";
  const reason = outcome === "not-approved" ? "not-approved" : !outcome.ok ? "call-failed" : outcome.result.isError ? "tool-error" : undefined;
  return recordAuditAfter(db, {
    ownerId: job.ownerId,
    actor: { type: "job", runId: job.runId },
    ...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
    jobId: job.runId,
    action: "tool.call",
    resource: { type: "tool", id: tool.id },
    result,
    details: { toolId: tool.id, toolName: tool.name, action, ...(reason ? { reason } : {}) },
  });
}
