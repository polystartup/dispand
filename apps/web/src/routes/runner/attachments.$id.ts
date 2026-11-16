import { createFileRoute } from "@tanstack/react-router";

// A chat attachment for a runner, by its runner token (`RUNNER_ATTACHMENTS_PATH`).
async function handle({ request, params }: { request: Request; params: { id: string } }) {
  const [{ handleRunnerAttachment }, { getApp }] = await Promise.all([import("@dispand/domain"), import("../../server/app.ts")]);
  return handleRunnerAttachment(request, await getApp(), params.id);
}

export const Route = createFileRoute("/runner/attachments/$id")({
  server: { handlers: { GET: handle } },
});
