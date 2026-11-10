import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const [{ handleRpc }, { getApp }] = await Promise.all([import("../../server/rpc.ts"), import("../../server/app.ts")]);
  return handleRpc(request, await getApp());
}

export const Route = createFileRoute("/api/rpc/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
