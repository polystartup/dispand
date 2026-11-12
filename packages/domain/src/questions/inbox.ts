import { Answer } from "@dispand/runner-protocol";
import { ORPCError } from "@orpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { agents, questions, runs } from "../db/schema.ts";
import { attributed, EngineError } from "../engine/engine.ts";
import { jobAgentNameSql } from "../jobs/agent-name.ts";
import type { JobIdentity, PlatformApp, ToolResult } from "../platform/call.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { jobScope, reachable, type InboxScope } from "./inbox-scope.ts";
import { check } from "./procedures.ts";

// The `inbox` bundle's tools (design 6.6): a Job reads and answers other agents' open Questions.
// Every call goes through `reachable`, with the Job's rights as they are now, and then through
// "still open": an answered or expired item is out of reach, its text and answer included.

const traces = tracer("questions");
const counts = meter("questions");

const NOT_FOUND = "Not found";
const CLOSED = "This Question is no longer waiting for an answer";
/** The most items `questions_list` gives, newest first. */
export const MAX_LISTED = 50;

export const ListInput = z.object({});
export const GetInput = z.object({ questionId: z.string() });
// Only a choice: an Approval is a person's, and `reachable` admits nothing else.
export const AnswerInput = z.object({ questionId: z.string(), answer: Answer.options[0] });

type Asked = { q: typeof questions.$inferSelect; agentId: string | null; agentName: string | null };

/** The item, when the Job may reach it and it still waits; otherwise the words the agent gets, the same for every item it can't reach. */
async function openItem(db: Db, scope: InboxScope, questionId: string): Promise<Asked | string> {
  if (!(await reachable(db, scope, questionId))) return NOT_FOUND;
  const [row] = await db
    .select({ q: questions, agentId: runs.agentId, agentName: jobAgentNameSql })
    .from(questions)
    .innerJoin(runs, eq(runs.id, questions.runId))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(and(eq(questions.id, questionId), eq(questions.ownerId, scope.ownerId)));
  return row?.q.status === "pending" ? row : CLOSED;
}

/** What an agent reads of an open Question: who asked, when, and what. */
function view({ q, agentId, agentName }: Asked) {
  const asked = q.payload.kind === "choice" ? q.payload.questions : [];
  return { id: q.id, askedBy: { agent: { id: agentId, name: agentName }, jobId: q.runId }, askedAt: q.createdAt, questions: asked };
}

/** One call in a span, counted by tool and result (the words' kind, never an item's text). */
function traced(db: Db, tool: string, job: JobIdentity, work: (scope: InboxScope) => Promise<ToolResult>): Promise<ToolResult> {
  return traces.startActiveSpan(`inbox.${tool}`, { attributes: { "dispand.job.id": job.runId } }, async (span) => {
    let result = "failed";
    try {
      const scope = await jobScope(db, job);
      const out: ToolResult = scope ? await work(scope) : { ok: false, error: "This Job is over" };
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

/** `questions_list`: the open Questions the Job may reach, newest first. */
export function listQuestions(app: PlatformApp, job: JobIdentity): Promise<ToolResult> {
  return traced(app.db, "list", job, async (scope) => {
    const open = await app.db
      .select({ q: questions, agentId: runs.agentId, agentName: jobAgentNameSql })
      .from(questions)
      .innerJoin(runs, eq(runs.id, questions.runId))
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(and(eq(questions.ownerId, job.ownerId), eq(questions.status, "pending"), eq(questions.kind, "question")))
      .orderBy(desc(questions.createdAt), desc(questions.id));
    const listed = [];
    for (const row of open) {
      if (listed.length === MAX_LISTED) break;
      if (await reachable(app.db, scope, row.q.id)) listed.push(view(row));
    }
    return { ok: true, output: listed };
  });
}

/** `questions_get`: one open Question the Job may reach. */
export function getQuestion(app: PlatformApp, job: JobIdentity, input: z.infer<typeof GetInput>): Promise<ToolResult> {
  return traced(app.db, "get", job, async (scope) => {
    const item = await openItem(app.db, scope, input.questionId);
    return typeof item === "string" ? { ok: false, error: item } : { ok: true, output: view(item) };
  });
}

/**
 * `questions_answer`: answers one open Question the Job may reach, as that Job of its agent. The
 * engine's pending → answered update is the one atomic step: of two answers at once (a person's,
 * another Job's), the second finds nothing waiting and is told so.
 */
export function answerQuestion(app: PlatformApp, job: JobIdentity, input: z.infer<typeof AnswerInput>): Promise<ToolResult> {
  return traced(app.db, "answer", job, async (scope) => {
    const item = await openItem(app.db, scope, input.questionId);
    if (typeof item === "string") return { ok: false, error: item };
    const [agent] = await app.db.select({ name: agents.name }).from(agents).where(eq(agents.id, job.agentId));
    try {
      const delivered = check(item.q.payload, input.answer);
      const name = agent?.name ?? "";
      // A CLI session gets it with who answered in its words: that too must fit the protocol.
      if (!Answer.safeParse(attributed(delivered, name)).success) return { ok: false, error: "An answer is too long" };
      await app.engine.answer(item.q.id, delivered, { type: "agent", agentId: job.agentId, runId: job.runId, name });
    } catch (err) {
      if (err instanceof EngineError) return { ok: false, error: err.code === "NOT_PENDING" ? CLOSED : err.message };
      if (err instanceof ORPCError) return { ok: false, error: err.message };
      throw err;
    }
    return { ok: true, output: { answered: item.q.id } };
  });
}
