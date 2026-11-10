import { JOB_TOOLS_SERVER } from "@dispand/runner-protocol";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { and, eq } from "drizzle-orm";
import { toolNames } from "../cloud/tool-names.ts";
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

type Listed = { name: string; toolId: string; action: string; description: string; inputSchema: Record<string, unknown> };

/** The actions of the HTTP tools the Job's agent gives it now, each under a name of its own. */
async function listed(db: Db, job: JobIdentity): Promise<Listed[]> {
  const [run] = await db
    .select({ ownerId: runs.ownerId, snapshot: runs.snapshot })
    .from(runs)
    .where(and(eq(runs.id, job.runId), eq(runs.ownerId, job.ownerId), eq(runs.agentId, job.agentId)));
  if (!run) return [];
  const { httpTools } = await toolingOf(db, run, job.agentId);
  const actions = httpTools.flatMap((tool) => tool.actions.map((action) => ({ key: `${tool.id}:${action.name}`, label: `${tool.name} ${action.name}`, tool, action })));
  const names = toolNames(actions.map(({ key, label }) => ({ key, label })));
  return actions.map(({ key, tool, action }) => ({ name: names.toName(key), toolId: tool.id, action: action.name, description: action.description, inputSchema: action.inputSchema }));
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

/** Answers one request to the tools endpoint. */
export async function handleJobToolsMcp(request: Request, app: PlatformApp): Promise<Response> {
  const found = await jobOfRequest(request, app);
  if (found instanceof Response) return found;
  const { job, auth } = found;
  const installed = new InstalledTools(app.db, app.secrets, app.tools);
  const handler = createMcpHandler(
    async () => {
      const server = new McpServer({ name: "dispand-tools", version: VERSION }, { capabilities: { tools: {} } });
      for (const item of await listed(app.db, job)) {
        // The schema is the tool's own JSON Schema, known only at run time.
        const register = server.registerTool.bind(server) as (name: string, config: { description: string; inputSchema: unknown }, cb: (input: unknown) => Promise<unknown>) => unknown;
        register(item.name, { description: item.description, inputSchema: fromJsonSchema(item.inputSchema as never) }, async (input) => {
          // As it is now: a tool taken back from the agent, or an action it no longer lists, isn't called (and no approval is used).
          const now = (await listed(app.db, job)).find((l) => l.name === item.name && l.toolId === item.toolId && l.action === item.action);
          const tool = now ? await installed.find(job.ownerId, now.toolId) : null;
          if (!now || !tool) return text(GONE, true);
          const args = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
          // The name the session's CLI asked the owner about: this server's tool.
          if (!(await takeApproval(app.db, job, `mcp__${JOB_TOOLS_SERVER}__${item.name}`, args))) return text(NEEDS_APPROVAL, true);
          const called = await installed.call(tool, now.action, args, new AbortController().signal);
          return called.ok ? text(called.result.text, called.result.isError) : text(called.error, true);
        });
      }
      return server;
    },
    { responseMode: "json", onerror: (err) => logError("tools endpoint failed", err, { ref: job.runId }) },
  );
  return handler.fetch(request, { authInfo: auth });
}
