import { createFileRoute } from "@tanstack/react-router";

// The Job endpoint: Dispand's own tools over MCP, for a Job's CLI sessions. Authenticated by the
// Job's bearer token, never by a session. Imports are deferred, as for the other server routes.
async function handle({ request }: { request: Request }) {
  const [{ handleJobMcp }, { getApp }] = await Promise.all([import("@dispand/domain"), import("../../server/app.ts")]);
  return handleJobMcp(request, await getApp());
}

export const Route = createFileRoute("/mcp/job")({ server: { handlers: { GET: handle, POST: handle, DELETE: handle } } });
