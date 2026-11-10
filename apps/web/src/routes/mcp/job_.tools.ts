import { createFileRoute } from "@tanstack/react-router";

// The tools endpoint: a Job's agent's tools reached by URL, for its CLI sessions, each call
// approved by the owner. Authenticated by the Job's bearer token, never by a session.
async function handle({ request }: { request: Request }) {
  const [{ handleJobToolsMcp }, { getApp }] = await Promise.all([import("@dispand/domain"), import("../../server/app.ts")]);
  return handleJobToolsMcp(request, await getApp());
}

export const Route = createFileRoute("/mcp/job_/tools")({ server: { handlers: { GET: handle, POST: handle, DELETE: handle } } });
