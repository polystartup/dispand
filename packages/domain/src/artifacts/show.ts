import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { ID } from "@dispand/runner-protocol";
import { artifacts, messages, stepRuns } from "../db/schema.ts";
import { messageView } from "../engine/views.ts";
import { newId } from "../ids.ts";
import type { ArtifactRef } from "../messages/record-result.ts";
import type { JobIdentity, PlatformApp, ToolResult } from "../platform/call.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";

// `artifact_show`: a Job shows generated HTML or SVG in its chat. The code is stored in
// `artifacts`; the chat gets a tool message whose result is a reference to it, published as the
// engine's own events are, so an open chat shows it at once. Only this tool writes such a
// reference: an MCP or native tool's result shaped like one stays plain text.

const traces = tracer("artifacts");
const counts = meter("artifacts");

export const ShowInput = z.object({
  title: z.string().min(1).max(120),
  format: z.enum(["html", "svg"]),
  // The full code: a revision sends it whole again.
  code: z.string().min(1).max(200_000),
  replaces: z.string().min(1).max(ID).optional(),
});
type Show = z.infer<typeof ShowInput>;

export const SHOW_DESCRIPTION =
  "Shows an interactive HTML page or an SVG image in the chat, as a card the owner can run. Give the whole code, self-contained: inline CSS, inline JavaScript and SVG only. It runs in a sandboxed frame with no network: no fetch or other requests, no external scripts, stylesheets, fonts or images (no CDN), no forms, no storage or cookies. Draw charts with inline SVG or a canvas. To change an artifact, send its whole new code with replaces set to the earlier artifact's id.";

/** Its Audit row's details: the format and the size in bytes, never the code or the title. */
export const showDetails = (input: unknown) => {
  const { format, code } = input as Show;
  return { format, bytes: Buffer.byteLength(code) };
};

export function showArtifact(app: PlatformApp, job: JobIdentity, input: Show): Promise<ToolResult> {
  const { format, bytes } = showDetails(input);
  return traces.startActiveSpan("artifacts.show", { attributes: { "dispand.job.id": job.runId, "dispand.artifact.format": format, "dispand.artifact.bytes": bytes } }, async (span): Promise<ToolResult> => {
    try {
      const made = await app.db.transaction(async (tx) => {
        if (input.replaces !== undefined) {
          const [earlier] = await tx.select({ id: artifacts.id }).from(artifacts).where(and(eq(artifacts.id, input.replaces), eq(artifacts.runId, job.runId)));
          if (!earlier) return null;
        }
        // The Job's step: the one whose session calls.
        const [step] = await tx.select({ id: stepRuns.id }).from(stepRuns).where(and(eq(stepRuns.runId, job.runId), isNotNull(stepRuns.sessionId))).limit(1);
        const artifactId = newId("art");
        const result: ArtifactRef = { kind: "artifact", artifactId, title: input.title, format, size: bytes };
        const [message] = await tx.insert(messages).values({ id: newId("msg"), ownerId: job.ownerId, runId: job.runId, stepRunId: step!.id, role: "tool", text: "artifact_show", result }).returning();
        await tx.insert(artifacts).values({ id: artifactId, runId: job.runId, stepRunId: step!.id, messageId: message!.id, title: input.title, format, code: input.code, replaces: input.replaces ?? null });
        return { artifactId, message: message! };
      });
      span.setAttribute("dispand.result", made ? "ok" : "not-found");
      counts.counter("dispand.artifacts.shown").add(1, { "dispand.artifact.format": format, "dispand.result": made ? "ok" : "not-found" });
      if (!made) return { ok: false, error: "Not found: replaces names no artifact of this Job" };
      span.setAttribute("dispand.artifact.id", made.artifactId);
      app.engine.settled([{ type: "message", message: messageView(made.message) }]);
      return { ok: true, output: { artifactId: made.artifactId } };
    } catch (err) {
      span.setAttribute("dispand.result", "failed");
      counts.counter("dispand.artifacts.shown").add(1, { "dispand.artifact.format": format, "dispand.result": "failed" });
      recordError(span, "failed");
      throw err;
    } finally {
      span.end();
    }
  });
}
