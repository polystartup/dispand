import { JOB_TOOLS_SERVER } from "@dispand/runner-protocol";
import { createHash } from "node:crypto";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runs } from "../db/schema.ts";
import { toolingOf } from "../engine/tooling.ts";
import { logError } from "../log.ts";
import { InstalledTools } from "../tools/executor.ts";
import { takeApproval } from "./approvals.ts";
import type { JobIdentity, PlatformApp } from "./call.ts";
import { jobOfRequest } from "./mcp.ts";

// The tools endpoint (`/mcp/job/tools`): a Job's agent's tools reached by URL, for its CLI
// sessions. The call runs here, on the server, where the tool's sealed headers stay; the session
// only ever sees the action's name, description and schema. Every call must have been approved
// by the owner for those exact arguments: the session's CLI asks before an MCP tool call, the
// question and its answer are recorded here, and a call uses its approval up.

const VERSION = "1.0.0";
const GONE = "This tool is not available.";
const NEEDS_APPROVAL =
  "This call needs the owner's approval. It is asked when the session's permission mode asks before using tools; it was not approved, or the arguments changed since.";

/** A CLI names a tool `mcp__job_tools__<name>`, and a model's tool name holds at most 64 characters. */
const MAX_NAME = 64 - `mcp__${JOB_TOOLS_SERVER}__`.length;

type Listed = { name: string; toolId: string; action: string; description: string; inputSchema: Record<string, unknown> };

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

/** The actions of the HTTP tools the Job's agent gives it now. */
async function listed(db: Db, job: JobIdentity): Promise<Listed[]> {
  const [run] = await db
    .select({ ownerId: runs.ownerId, snapshot: runs.snapshot })
    .from(runs)
    .where(and(eq(runs.id, job.runId), eq(runs.ownerId, job.ownerId), eq(runs.agentId, job.agentId)));
  if (!run) return [];
  const { httpTools } = await toolingOf(db, run, job.agentId);
  const all = httpTools.flatMap((tool) =>
    tool.actions.map((action) => ({ name: exposedName(tool, action.name), toolId: tool.id, action: action.name, description: action.description, inputSchema: action.inputSchema })),
  );
  // A name must stand for one action: should two ever share one, neither is offered.
  return all.filter((item) => all.filter((other) => other.name === item.name).length === 1);
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

/** Answers one request to the tools endpoint. */
export async function handleJobToolsMcp(request: Request, app: PlatformApp): Promise<Response> {
  const found = await jobOfRequest(request, app);
  if (found instanceof Response) return found;
  const { job, auth } = found;
  const installed = new InstalledTools(app.db, app.secrets, app.tools);
  const handler = createMcpHandler(
    () => {
      // The low-level server: a tool's own JSON Schema is shown as it is and never compiled here
      // (it comes from a server the owner configured; the tool validates its own arguments).
      const server = new Server({ name: "dispand-tools", version: VERSION }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", async () => ({
        tools: (await listed(app.db, job)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as { type: "object" } })),
      }));
      server.setRequestHandler("tools/call", async (call) => {
        // As it is now: a tool taken back from the agent, or an action it no longer lists, isn't called (and no approval is used).
        const item = (await listed(app.db, job)).find((l) => l.name === call.params.name);
        const tool = item ? await installed.find(job.ownerId, item.toolId) : null;
        if (!item || !tool) return text(GONE, true);
        const args = call.params.arguments ?? {};
        // The name the session's CLI asked the owner about: this server's tool, which stands for this tool and action only.
        if (!(await takeApproval(app.db, job, `mcp__${JOB_TOOLS_SERVER}__${item.name}`, args))) return text(NEEDS_APPROVAL, true);
        // Cut when the request is: a session that ended doesn't leave its call running.
        const called = await installed.call(tool, item.action, args, request.signal);
        return called.ok ? text(called.result.text, called.result.isError) : text(called.error, true);
      });
      return server;
    },
    { responseMode: "json", onerror: (err) => logError("tools endpoint failed", err, { ref: job.runId }) },
  );
  return handler.fetch(request, { authInfo: auth });
}
