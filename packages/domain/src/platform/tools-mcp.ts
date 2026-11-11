import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { keepJobFiles } from "../data/files.ts";
import { logError } from "../log.ts";
import { InstalledTools } from "../tools/executor.ts";
import { takeApproval } from "./approvals.ts";
import { askedName, exposedTools } from "./exposed.ts";
import type { PlatformApp } from "./call.ts";
import { jobOf, jobOfRequest, RESTART_HINT } from "./mcp.ts";

// The tools endpoint (`/mcp/job/tools`): a Job's agent's tools reached by URL, for its CLI
// sessions. The call runs here, on the server, where the tool's sealed headers stay; the session
// only ever sees the action's name, description and schema. Every call must have been approved
// by the owner for those exact arguments: the session's CLI asks before an MCP tool call, the
// question and its answer are recorded here, and a call uses its approval up. Files a call
// returns are kept as the Job's attachments.

const VERSION = "1.0.0";
const GONE = "This tool is not available.";
const NEEDS_APPROVAL =
  "This call needs the owner's approval: the action asks before use. It is asked when the session's permission mode asks before using tools; it was not approved, or the arguments changed since. If you were not asked, don't retry: say that the call needs the owner's approval.";

const FILES_FAILED = "The call ran, but the files it returned couldn't be kept.";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

/** One handler per app: the SDK builds a server per request from the factory, which reads the request's Job. */
const handlers = new WeakMap<PlatformApp, ReturnType<typeof createMcpHandler>>();

function toolsHandler(app: PlatformApp) {
  let handler = handlers.get(app);
  if (!handler) {
    const installed = new InstalledTools(app.db, app.secrets, app.tools);
    handler = createMcpHandler(
      (ctx) => {
        // The low-level server: a tool's own JSON Schema is shown as it is and never compiled here
        // (it comes from a server the owner configured; the tool validates its own arguments).
        const server = new Server({ name: "dispand-tools", version: VERSION }, { capabilities: { tools: {} }, instructions: RESTART_HINT });
        const job = jobOf(ctx.authInfo);
        server.setRequestHandler("tools/list", async () => ({
          tools: (job ? await exposedTools(app.db, job) : []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as { type: "object" } })),
        }));
        server.setRequestHandler("tools/call", async (call) => {
          // As it is now: a tool taken back from the agent, or an action it no longer lists, isn't called (and no approval is used).
          const item = job ? (await exposedTools(app.db, job)).find((l) => l.name === call.params.name) : undefined;
          const tool = job && item ? await installed.find(job.ownerId, item.toolId) : null;
          if (!job || !item || !tool) return text(GONE, true);
          const args = call.params.arguments ?? {};
          // The name the session's CLI asked the owner about: this server's tool, which stands for this tool and action only.
          if (item.ask && !(await takeApproval(app.db, job, askedName(item.name), args))) return text(NEEDS_APPROVAL, true);
          // Cut when the request is: a session that ended doesn't leave its call running.
          const called = await installed.call(tool, item.action, args, ctx.requestInfo?.signal ?? new AbortController().signal);
          if (!called.ok) return text(called.error, true);
          // Files in the result are kept for the Job: the session gets their attachment ids, not their bytes.
          const result = await keepJobFiles(app.db, app.filesDir, job, called.result).catch((err: unknown) => {
            logError("tool files not kept", err, { ref: job.runId });
            return null;
          });
          return result ? text(result.text, result.isError) : text(FILES_FAILED, true);
        });
        return server;
      },
      { responseMode: "json", onerror: (err) => logError("tools endpoint failed", err) },
    );
    handlers.set(app, handler);
  }
  return handler;
}

/** Answers one request to the tools endpoint. */
export async function handleJobToolsMcp(request: Request, app: PlatformApp): Promise<Response> {
  const found = await jobOfRequest(request, app);
  if (found instanceof Response) return found;
  return toolsHandler(app).fetch(request, { authInfo: found.auth });
}
