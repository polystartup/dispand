import { createFileRoute } from "@tanstack/react-router";

async function handle() {
  const [{ handleHealth }, { getApp }] = await Promise.all([import("../../server/health.ts"), import("../../server/app.ts")]);
  return handleHealth(getApp);
}

export const Route = createFileRoute("/api/health")({
  server: { handlers: { GET: handle } },
});
