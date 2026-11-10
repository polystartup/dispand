import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode, requireBearerAuth, type AuthInfo } from "@modelcontextprotocol/server";
import { logError } from "../log.ts";
import { callPlatformTool, toolsOf, type JobIdentity, type PlatformApp } from "./call.ts";
import { jobOfToken } from "./token.ts";

// The Job endpoint (`/mcp/job`): Dispand's own tools over MCP, for a Job's CLI sessions. One
// endpoint for every Job, stateless: what is per Job is the bearer token, which names the Job
// whose rights every call is checked against (`callPlatformTool`, as for cloud sessions).

const VERSION = "1.0.0";
/** What the SDK's bearer check needs of a token's lifetime; the Job itself is checked on every request. */
const TOKEN_TTL_S = 3600;

export const jobOf = (auth: AuthInfo | undefined) => (auth?.extra as { job?: JobIdentity } | undefined)?.job;

/**
 * The Job a request is made for, from its bearer token (a Job still going), with the SDK's auth
 * info to hand to the handler; or the 401 to answer with.
 */
export async function jobOfRequest(request: Request, app: PlatformApp): Promise<{ job: JobIdentity; auth: AuthInfo } | Response> {
  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token) {
        const job = await jobOfToken(app.db, token);
        if (!job) throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token");
        return { token, clientId: job.runId, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_S, extra: { job } };
      },
    },
  });
  const auth = await gate(request);
  if (auth instanceof Response) return auth;
  return { job: jobOf(auth)!, auth };
}

/** One handler per app: the SDK builds a server per request from the factory, which reads the request's Job. */
const handlers = new WeakMap<PlatformApp, ReturnType<typeof createMcpHandler>>();

function jobHandler(app: PlatformApp) {
  let handler = handlers.get(app);
  if (!handler) {
    handler = createMcpHandler(
      async (ctx) => {
        const server = new McpServer({ name: "dispand", version: VERSION }, { capabilities: { tools: {} } });
        const job = jobOf(ctx.authInfo);
        if (!job) return server;
        for (const tool of await toolsOf(app.db, job)) {
          // The schema is the procedure's own Zod input; the SDK's overloads can't follow a schema known only at run time.
          const register = server.registerTool.bind(server) as (name: string, config: { description: string; inputSchema: unknown }, cb: (input: unknown) => Promise<unknown>) => unknown;
          register(tool.name, { description: tool.description, inputSchema: tool.input }, async (input) => {
            const result = await callPlatformTool(app, job, tool.name, input);
            return result.ok
              ? { content: [{ type: "text" as const, text: JSON.stringify(result.output ?? null) }] }
              : { content: [{ type: "text" as const, text: result.error }], isError: true };
          });
        }
        return server;
      },
      { responseMode: "json", onerror: (err) => logError("job endpoint failed", err) },
    );
    handlers.set(app, handler);
  }
  return handler;
}

/** Answers one request to the Job endpoint. */
export async function handleJobMcp(request: Request, app: PlatformApp): Promise<Response> {
  const found = await jobOfRequest(request, app);
  if (found instanceof Response) return found;
  return jobHandler(app).fetch(request, { authInfo: found.auth });
}
