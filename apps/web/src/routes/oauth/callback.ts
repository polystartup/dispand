import { createFileRoute } from "@tanstack/react-router";

// Where an OAuth tool's authorization server sends the owner back: the owner's session finishes
// the flow it started (`handleToolOAuthCallback`). No span records it (`telemetry-requests.mjs`).
async function handle({ request }: { request: Request }) {
  const [{ handleToolOAuthCallback }, { getApp }] = await Promise.all([import("@dispand/domain"), import("../../server/app.ts")]);
  return handleToolOAuthCallback(request, await getApp());
}

export const Route = createFileRoute("/oauth/callback")({ server: { handlers: { GET: handle } } });
