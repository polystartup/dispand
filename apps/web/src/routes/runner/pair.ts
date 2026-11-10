import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const [{ handlePair }, { getApp }] = await Promise.all([import("../../server/pair.ts"), import("../../server/app.ts")]);
  return handlePair(request, (await getApp()).db);
}

export const Route = createFileRoute("/runner/pair")({
  server: { handlers: { POST: handle } },
});
