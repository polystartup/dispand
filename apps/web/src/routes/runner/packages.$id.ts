import { createFileRoute } from "@tanstack/react-router";

async function handle({ request, params }: { request: Request; params: { id: string } }) {
  const [{ handlePackage }, { getApp }] = await Promise.all([import("../../server/packages.ts"), import("../../server/app.ts")]);
  return handlePackage(request, (await getApp()).db, params.id);
}

export const Route = createFileRoute("/runner/packages/$id")({
  server: { handlers: { GET: handle } },
});
