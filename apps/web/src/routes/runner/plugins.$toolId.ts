import { createFileRoute } from "@tanstack/react-router";

async function handle({ request, params }: { request: Request; params: { toolId: string } }) {
  const [{ handlePlugin }, { getApp }] = await Promise.all([import("../../server/plugins.ts"), import("../../server/app.ts")]);
  return handlePlugin(request, (await getApp()).db, params.toolId);
}

export const Route = createFileRoute("/runner/plugins/$toolId")({
  server: { handlers: { GET: handle } },
});
