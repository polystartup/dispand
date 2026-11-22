import { TEXT } from "@dispand/runner-protocol";
import { z } from "zod";
import type { JobIdentity, PlatformApp, ToolResult } from "../platform/call.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { ownInbox } from "./own-inbox.ts";

// Every actor's own inbox: an agent's Job lists, reads and answers the consults addressed to its
// agent (`ownInbox`), never another actor's items. An answer settles the consult as the engine
// settles it when the Job started for it ends (`Engine.answerFromInbox`).

const traces = tracer("questions");
const counts = meter("questions");

const NOT_FOUND = "Not found";
const CLOSED = "This Question is no longer waiting for an answer";
const OVER = "This Job is over";

export const ListInput = z.object({});
export const GetInput = z.object({ questionId: z.string() });
export const AnswerInput = z.object({ questionId: z.string(), text: z.string().trim().min(1).max(TEXT) });

type Item = NonNullable<Awaited<ReturnType<typeof ownInbox>>>[number];

/** What an agent reads of an item: who asked, when, and what. */
function view({ q, agentId, agentName }: Item) {
  return { id: q.id, askedBy: { agent: { id: agentId, name: agentName }, jobId: q.runId }, askedAt: q.createdAt, question: q.payload.kind === "consult" ? q.payload.question : "" };
}

/** One call in a span, counted by tool and result (the words' kind, never an item's text). */
function traced(tool: string, job: JobIdentity, work: () => Promise<ToolResult>): Promise<ToolResult> {
  return traces.startActiveSpan(`inbox.${tool}`, { attributes: { "dispand.job.id": job.runId } }, async (span) => {
    let result = "failed";
    try {
      const out = await work();
      result = out.ok ? "ok" : out.error === NOT_FOUND ? "not-found" : out.error === CLOSED ? "closed" : "refused";
      if (!out.ok) recordError(span, result);
      return out;
    } finally {
      span.setAttribute("dispand.result", result);
      counts.counter("dispand.inbox.calls").add(1, { "dispand.inbox.tool": tool, "dispand.result": result });
      span.end();
    }
  });
}

/** `questions_list`: the items of the Job's agent's own inbox, newest first. */
export function listQuestions(app: PlatformApp, job: JobIdentity): Promise<ToolResult> {
  return traced("list", job, async () => {
    const items = await ownInbox(app.db, job.runId);
    return items ? { ok: true, output: items.map(view) } : { ok: false, error: OVER };
  });
}

/** `questions_get`: one item of the Job's agent's own inbox. */
export function getQuestion(app: PlatformApp, job: JobIdentity, input: z.infer<typeof GetInput>): Promise<ToolResult> {
  return traced("get", job, async () => {
    const items = await ownInbox(app.db, job.runId, input.questionId);
    if (!items) return { ok: false, error: OVER };
    return items[0] ? { ok: true, output: view(items[0]) } : { ok: false, error: NOT_FOUND };
  });
}

/** `questions_answer`: answers one item of the Job's agent's own inbox; the asking Job goes on with it. */
export function answerQuestion(app: PlatformApp, job: JobIdentity, input: z.infer<typeof AnswerInput>): Promise<ToolResult> {
  return traced("answer", job, async () => {
    const items = await ownInbox(app.db, job.runId, input.questionId);
    if (!items) return { ok: false, error: OVER };
    if (!items[0]) return { ok: false, error: NOT_FOUND };
    // Read again in the engine's transaction: of two answers at once, the second finds nothing waiting.
    if (!(await app.engine.answerFromInbox(job.runId, input.questionId, input.text))) return { ok: false, error: CLOSED };
    return { ok: true, output: { answered: input.questionId } };
  });
}
