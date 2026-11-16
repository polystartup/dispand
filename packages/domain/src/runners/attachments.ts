import { attachmentForRunner } from "../data/files.ts";
import type { Db } from "../db/client.ts";
import { errorKind, logError } from "../log.ts";
import { inSpan, tracer } from "../telemetry/index.ts";
import { findRunnerByToken } from "./pairing.ts";

// `GET RUNNER_ATTACHMENTS_PATH/<id>`: a chat attachment the runner copies into a session's run
// folder before the message that names it reaches the CLI. Only for a live runner's token, and
// only a file of a Job with a session on that runner (`attachmentForRunner`): 404 for any other.

const traces = tracer("runners");

/** Answers one request for a chat attachment. */
export async function handleRunnerAttachment(request: Request, app: { db: Db; filesDir: string }, id: string): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const runner = token && token.length <= 256 ? await findRunnerByToken(app.db, token) : null;
  if (!runner) return Response.json({ error: "Unknown runner" }, { status: 401 });
  return inSpan(traces, "runner.attachment", { "dispand.runner.id": runner.id }, errorKind, async () => {
    try {
      const file = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? await attachmentForRunner(app.db, app.filesDir, runner.id, id) : null;
      if (!file) return Response.json({ error: "Not found" }, { status: 404 });
      return new Response(file.body, { headers: { "content-type": "application/octet-stream", "content-length": String(file.size), "cache-control": "no-store" } });
    } catch (err) {
      logError("runner attachment not served", err, { ref: id });
      return Response.json({ error: "Not served" }, { status: 500 });
    }
  });
}
