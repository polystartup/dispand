import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, questions, runs } from "../db/schema.ts";
import { jobAgentName } from "./agent-name.ts";

// How a consult shows on the Jobs' pages and in the Jobs list (design 6.13): the Job that asks
// waits on a `consult` question row, and the Job that answers it carries that row in its cause.
// Read-only views for the owner; nothing here changes a consult.

type RunRow = typeof runs.$inferSelect;
type QuestionRow = typeof questions.$inferSelect;

/** Where an agent whose row is gone shows, when no Job of it kept its name (`agent-name.ts`). */
const DELETED = "Deleted agent";

/** `waiting`: no answer yet (the Job may not exist yet: its root is paused, or the owner is asked first). `ended`: the question expired with its step, unanswered. */
export type ConsultState = "waiting" | "answered" | "failed" | "ended";

export function consultState(q: Pick<QuestionRow, "status" | "answer">): ConsultState {
  if (q.status === "pending") return "waiting";
  if (q.status === "expired") return "ended";
  return q.answer?.kind === "consult" && q.answer.outcome === "answered" ? "answered" : "failed";
}

async function namesOf(db: Db, ownerId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.ownerId, ownerId), inArray(agents.id, ids)));
  return new Map(rows.map((a) => [a.id, a.name]));
}

/**
 * One Job's consults: those it asked (the agent, the state, the consulted Job once there is one,
 * the question and the answer or the reason there is none), and the consult it answers (the
 * asking agent and Job, and the question).
 */
export async function consultsOfJob(db: Db, run: Pick<RunRow, "id" | "ownerId" | "cause">) {
  const rows = await db
    .select()
    .from(questions)
    .where(and(eq(questions.runId, run.id), eq(questions.ownerId, run.ownerId), eq(questions.kind, "consult")))
    .orderBy(questions.createdAt, questions.id);
  const cause = run.cause?.kind === "consult" ? run.cause : null;
  const [asking] = cause ? await db.select().from(runs).where(and(eq(runs.id, cause.jobId), eq(runs.ownerId, run.ownerId))) : [];
  const [row] = cause ? await db.select().from(questions).where(and(eq(questions.id, cause.questionId), eq(questions.ownerId, run.ownerId))) : [];
  const names = await namesOf(db, run.ownerId, [...rows.flatMap((q) => (q.payload.kind === "consult" ? [q.payload.agentId] : [])), ...(asking?.agentId ? [asking.agentId] : [])]);
  // A consulted Job keeps its agent's name once the agent is deleted.
  const made = rows.flatMap((q) => (q.consultRunId ? [q.consultRunId] : []));
  const kept = new Map(
    made.length ? (await db.select({ id: runs.id, agentName: runs.agentName }).from(runs).where(and(eq(runs.ownerId, run.ownerId), inArray(runs.id, made)))).map((r) => [r.id, r.agentName]) : [],
  );
  return {
    asked: rows.flatMap((q) =>
      q.payload.kind !== "consult"
        ? []
        : [
            {
              questionId: q.id,
              agentId: q.payload.agentId,
              agent: jobAgentName(names.get(q.payload.agentId), (q.consultRunId && kept.get(q.consultRunId)) || null) ?? DELETED,
              runId: q.consultRunId,
              state: consultState(q),
              question: q.payload.question,
              // The answer, or the reason there is none.
              answer: q.answer?.kind === "consult" ? q.answer.text : null,
              createdAt: q.createdAt,
            },
          ],
    ),
    answering:
      asking && row?.payload.kind === "consult"
        ? { runId: asking.id, agentId: asking.agentId, agent: jobAgentName(asking.agentId && names.get(asking.agentId), asking.agentName) ?? DELETED, question: row.payload.question }
        : null,
  };
}

/**
 * What the Jobs list says of each Job in `rows`: the agent a pending consult of it waits on, and
 * the agent that consulted it. Both by name, as the agent is now (or as a Job of it kept it).
 */
export async function consultMarks(db: Db, rows: Pick<RunRow, "id" | "ownerId" | "cause">[]) {
  const ids = rows.map((r) => r.id);
  const ownerId = rows[0]?.ownerId;
  if (!ownerId) return new Map<string, { waitingOn: string | null; consultedBy: string | null }>();
  const waiting = await db
    .select({ runId: questions.runId, payload: questions.payload })
    .from(questions)
    .where(and(eq(questions.ownerId, ownerId), inArray(questions.runId, ids), eq(questions.kind, "consult"), eq(questions.status, "pending")))
    .orderBy(questions.createdAt, questions.id);
  const askers = rows.flatMap((r) => (r.cause?.kind === "consult" ? [r.cause.jobId] : []));
  const askerRuns = askers.length
    ? await db.select({ id: runs.id, agentId: runs.agentId, agentName: runs.agentName }).from(runs).where(and(eq(runs.ownerId, ownerId), inArray(runs.id, askers)))
    : [];
  const waitingOn = new Map<string, string>();
  for (const q of waiting) if (q.payload.kind === "consult" && !waitingOn.has(q.runId)) waitingOn.set(q.runId, q.payload.agentId);
  const askerAgent = new Map(askerRuns.map((r) => [r.id, r.agentId]));
  const askerKept = new Map(askerRuns.map((r) => [r.id, r.agentName]));
  const names = await namesOf(db, ownerId, [...waitingOn.values(), ...[...askerAgent.values()].filter((id): id is string => !!id)]);
  return new Map(
    rows.map((r) => {
      const on = waitingOn.get(r.id);
      const by = r.cause?.kind === "consult" ? askerAgent.get(r.cause.jobId) : undefined;
      return [
        r.id,
        {
          waitingOn: on === undefined ? null : (names.get(on) ?? DELETED),
          consultedBy: r.cause?.kind !== "consult" ? null : (jobAgentName(by && names.get(by), askerKept.get(r.cause.jobId) ?? null) ?? DELETED),
        },
      ] as const;
    }),
  );
}
