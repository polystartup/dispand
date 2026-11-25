import { createFileRoute } from "@tanstack/react-router";

async function handle({ request, params }: { request: Request; params: { pluginId: string } }) {
  const [{ handleNativePlugin }, { getApp }] = await Promise.all([import("../../server/plugins.ts"), import("../../server/app.ts")]);
  return handleNativePlugin(request, (await getApp()).db, params.pluginId);
}

export const Route = createFileRoute("/runner/native-plugins/$pluginId")({
  server: { handlers: { GET: handle } },
});
