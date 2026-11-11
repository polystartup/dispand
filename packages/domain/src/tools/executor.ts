import { and, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { tools as toolsTable } from "../db/schema.ts";
import { logError } from "../log.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";

const traces = tracer("tools");
const counts = meter("tools");
import { SecretError, type SecretBox } from "../secrets.ts";
import type { ToolStep } from "../workflows/model.ts";
import type { ToolSchema } from "../workflows/tool-steps.ts";
import { coerceArguments, toolErrorText, toolOutputs, type ArgValue } from "./arguments.ts";
import { ToolError, type ToolConnector, type ToolResult } from "./mcp.ts";
import { connectionTarget } from "./procedures.ts";

type Row = typeof toolsTable.$inferSelect;

/**
 * The owner's tools among `ids`, as the workflow model checks Tool steps against them. Locked
 * `FOR SHARE`: inside a run's creation, a delete of one of them waits for the run (and then sees
 * it) or goes first (and the run sees the tool gone).
 */
export async function loadToolSchemas(db: Db | Tx, ownerId: string, ids: string[]): Promise<ToolSchema[]> {
  if (ids.length === 0) return [];
  return db
    .select({ id: toolsTable.id, name: toolsTable.name, kind: toolsTable.kind, actions: toolsTable.actions })
    .from(toolsTable)
    .where(and(eq(toolsTable.ownerId, ownerId), inArray(toolsTable.id, ids)))
    .for("share");
}

/**
 * The one way Dispand itself calls an installed tool's action: Tool steps through
 * `connectorToolExecutor`, cloud agents' tool calls through `mcpToolCaller`.
 * The tool's headers are opened from the secret box for the call only and go to its URL and
 * nowhere else; what comes back is redacted by the connector. Never throws: a failure is a short
 * reason made here (a `ToolError`'s), never the server's text.
 */
export class InstalledTools {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly connector: ToolConnector,
  ) {}

  /** The owner's tool, or null when it doesn't exist (or is another owner's). */
  async find(ownerId: string, toolId: string): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(toolsTable)
      .where(and(eq(toolsTable.id, toolId), eq(toolsTable.ownerId, ownerId)));
    return row ?? null;
  }

  /** Calls `action` of `tool` with `args` (the connector's deadline applies; `signal` cancels it). */
  async call(tool: Row, action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: true; result: ToolResult } | { ok: false; error: string }> {
    // In a span with the tool and the action, and how it ended; never the arguments or the result.
    return traces.startActiveSpan("tool.call", { attributes: { "dispand.tool.id": tool.id, "dispand.tool.action": action } }, async (span) => {
      const started = performance.now();
      const called = await this.callTool(tool, action, args, signal);
      const result = !called.ok ? "error" : called.result.isError ? "tool-error" : "ok";
      span.setAttribute("dispand.result", result);
      if (!called.ok) recordError(span, "ToolCallFailed");
      span.end();
      counts.counter("dispand.tool.calls").add(1, { "dispand.result": result });
      counts.histogram("dispand.tool.duration", { unit: "ms", description: "A call of a tool's action, from the server" }).record(performance.now() - started, { "dispand.result": result });
      return called;
    });
  }

  private async callTool(tool: Row, action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: true; result: ToolResult } | { ok: false; error: string }> {
    if (tool.kind !== "http") return { ok: false, error: `${tool.name} runs on a runner: only an agent can use it` };
    try {
      return { ok: true, result: await this.connector.callAction(connectionTarget(this.db, this.secrets, tool), action, args, signal) };
    } catch (error) {
      if (error instanceof ToolError) return { ok: false, error: error.message };
      if (error instanceof SecretError) return { ok: false, error: `${tool.name}'s headers couldn't be opened` };
      logError("tool call failed", error, { ref: tool.id });
      return { ok: false, error: `The call to ${tool.name} failed` };
    }
  }
}

/** Runs Tool steps. The engine hands it each ready step with its wired values (`toolValues`). */
export interface ToolExecutor {
  run(ownerId: string, step: ToolStep, values: Map<string, ArgValue>, signal: AbortSignal): Promise<{ ok: true; outputs: Record<string, string> } | { ok: false; error: string }>;
}

/** Where no connector is configured: every Tool step fails, nothing is called. */
export const noToolSteps: ToolExecutor = {
  run: async () => ({ ok: false, error: "Tool steps can't run here: no tool connector is configured" }),
};

/**
 * Tool steps over `tools`: the step's tool and action as they are now, the values coerced to the
 * action's parameter types (nothing is called when one doesn't fit), then one call. An `isError`
 * result fails the step with its first characters; any other gives `toolOutputs`.
 */
export function connectorToolExecutor(tools: InstalledTools): ToolExecutor {
  return {
    async run(ownerId, step, values, signal) {
      const tool = await tools.find(ownerId, step.toolId);
      if (!tool) return { ok: false, error: "The step's tool no longer exists" };
      const action = tool.actions.find((a) => a.name === step.action);
      if (!action) return { ok: false, error: `${tool.name} no longer has the action “${step.action}”` };
      const coerced = coerceArguments(action, values);
      if ("error" in coerced) return { ok: false, error: coerced.error };
      const called = await tools.call(tool, action.name, coerced.args, signal);
      if (!called.ok) return called;
      if (called.result.isError) return { ok: false, error: toolErrorText(called.result.text) };
      return { ok: true, outputs: toolOutputs(called.result) };
    },
  };
}
