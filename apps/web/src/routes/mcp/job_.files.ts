import { createFileRoute } from "@tanstack/react-router";

// The files endpoint: what a Job's runner tools return, sent by the runner's MCP proxy and kept
// as the Job's attachments. Authenticated by the Job's bearer token, never by a session.
async function handle({ request }: { request: Request }) {
  const [{ handleJobFiles }, { getApp }] = await Promise.all([import("@dispand/domain"), import("../../server/app.ts")]);
  return handleJobFiles(request, await getApp());
}

export const Route = createFileRoute("/mcp/job_/files")({ server: { handlers: { POST: handle } } });
