import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const { getApp } = await import("../../server/app.ts");
  const { auth } = await getApp();
  return auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
