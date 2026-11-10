import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const [{ handleFileDownload }, { getApp }] = await Promise.all([import("../../server/files.ts"), import("../../server/app.ts")]);
  return handleFileDownload(request, await getApp());
}

export const Route = createFileRoute("/files/$id")({
  server: { handlers: { GET: handle } },
});
