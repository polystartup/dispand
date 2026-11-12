import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// A separate, stable control channel: no session protocol negotiation needed.
export const Route = createFileRoute("/runner/update")({
  server: { handlers: { POST: async ({ request }) => {
    const [{ getApp }, { findRunnerByToken }] = await Promise.all([import("../../server/app.ts"), import("@dispand/domain")]);
    const { db, hub } = await getApp();
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return new Response(null, { status: 401 });
    const runner = await findRunnerByToken(db, authorization.slice(7));
    if (!runner) return new Response(null, { status: 401 });
    const buildId = z.string().regex(/^[a-f0-9]{64}$/).safeParse(request.headers.get("dispand-runner-build"));
    if (!buildId.success) return new Response(null, { status: 400 });
    const update = hub.updates.poll(runner.id, buildId.data, request.headers.get("dispand-update-failed") === "1");
    return Response.json({ update }, { headers: { "cache-control": "no-store" } });
  } } },
});
