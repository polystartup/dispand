import { MAX_RESULT_BODY_BYTES } from "@dispand/runner-protocol";
import { z } from "zod";
import { keepJobFiles } from "../data/files.ts";
import { errorKind, logError } from "../log.ts";
import { inJobTrace, inSpan, tracer } from "../telemetry/index.ts";
import type { PlatformApp } from "./call.ts";
import { inScope } from "../db/scope.ts";
import { jobOfRequest } from "./mcp.ts";
import { organizationRefusal } from "../workspace/gate.ts";

// The files endpoint (`JOB_FILES_PATH`): the files a Job's runner tools return, sent by the
// runner's MCP proxy with the Job's token. The token is the Job: the files can only become that
// Job's attachments, at paths the server makes (`storeAttachment`), within the limits
// `keepJobFiles` checks. The reply's `text` takes the files' place in the tool's result.

const traces = tracer("platform");

const Body = z.object({ files: z.array(z.object({ name: z.string().max(1024), base64: z.base64() })).min(1).max(1000) });

/** The body as text, or null once it passes `max` bytes. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Answers one request to the files endpoint. */
export async function handleJobFiles(request: Request, app: PlatformApp): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const found = await jobOfRequest(request, app);
  if (found instanceof Response) return found;
  const { job } = found;
  // Before the body is read; as a refusal of this upload, not of the token (a 401 would send the client looking for a sign-in).
  const refused = organizationRefusal(app.db, job.scope.organizationId, "job_call");
  if (refused) return Response.json({ error: refused.message }, { status: 403, headers: { "cache-control": "no-store" } });
  return inScope(job.scope, () => inJobTrace(job, () =>
    inSpan(traces, "platform.job_files", { "dispand.job.id": job.runId }, errorKind, async (span) => {
      const raw = await readCapped(request, MAX_RESULT_BODY_BYTES);
      if (raw === null) return Response.json({ error: "Too large" }, { status: 413 });
      let body: z.infer<typeof Body>;
      try {
        body = Body.parse(JSON.parse(raw));
      } catch {
        return Response.json({ error: "Invalid files" }, { status: 400 });
      }
      span.setAttribute("dispand.files.count", body.files.length);
      const files = body.files.map((f) => ({ name: f.name, bytes: Buffer.from(f.base64, "base64") }));
      try {
        const kept = await keepJobFiles(app.db, app.filesDir, job, { text: "", isError: false, files }, "runner-tool");
        return Response.json({ text: kept.text }, { headers: { "cache-control": "no-store" } });
      } catch (err) {
        logError("runner tool files not kept", err, { ref: job.runId });
        return Response.json({ error: "Not kept" }, { status: 500 });
      }
    }),
  ));
}
