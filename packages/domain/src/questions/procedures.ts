import { ORPCError } from "@orpc/server";
import { Answer, type QuestionPayload, storable, TEXT } from "@dispand/runner-protocol";
import { and, count, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { agents, questions as questionsTable, runs, stepRuns, triggers, workflows, workflowVersions } from "../db/schema.ts";
import { answerText, EngineError, questionView } from "../engine/engine.ts";
import { proposalView } from "../platform/proposals.ts";
import { authed, base } from "../rpc/context.ts";
import { nodesOf, type WorkflowDef } from "../workflows/model.ts";

const owner = base.use(authed);

/** The owner's Inbox items: every Question and Approval, never a consult, which an agent's Job answers (`engine/consults.ts`). */
const inbox = (ownerId: string) => and(eq(questionsTable.ownerId, ownerId), ne(questionsTable.kind, "consult"));

/**
 * Questions that wait for the owner. Chat questions count too: a chat the owner isn't looking at
 * would block silently. They show inline in their chat as well; answering in either place works.
 */
const waiting = (ownerId: string) => and(inbox(ownerId), eq(questionsTable.status, "pending"));

async function pendingCount(db: Db, ownerId: string) {
  const [row] = await db.select({ n: count() }).from(questionsTable).where(waiting(ownerId));
  return { count: row!.n };
}

/**
 * Throws BAD_REQUEST when the answer doesn't fit the question; returns what to deliver (a listed
 * label exactly as listed, free text trimmed). Free-text "Other" is any string, so a label the question doesn't list can't be told
 * from it: it reaches the agent as the owner's own words.
 */
export function check(payload: QuestionPayload, answer: Answer): Answer {
  const bad = (message: string): never => {
    throw new ORPCError("BAD_REQUEST", { message });
  };
  if (payload.kind !== answer.kind) return bad("The answer doesn't match the question");
  let delivered = answer;
  if (payload.kind === "choice" && answer.kind === "choice") {
    const answers: Record<string, string | string[]> = {};
    const asked = payload.questions.map((q) => q.question);
    if (Object.keys(answer.answers).some((k) => !asked.includes(k))) return bad("The answer names a question that wasn't asked");
    for (const q of payload.questions) {
      const given = answer.answers[q.question];
      const labels = new Set(q.options.map((o) => o.label));
      // A listed label stays exactly as listed (the runner matches labels exactly); only free text is trimmed.
      const picks = (Array.isArray(given) ? given : given === undefined ? [] : [given]).map((p) => (labels.has(p) ? p : p.trim()));
      if (picks.length === 0 || picks.some((p) => p === "")) return bad(`Answer “${q.question}”`);
      if (!q.multiSelect && picks.length > 1) return bad(`“${q.question}” takes one answer`);
      if (new Set(picks).size !== picks.length) return bad(`“${q.question}” lists the same answer twice`);
      answers[q.question] = Array.isArray(given) ? picks : picks[0]!;
    }
    delivered = { kind: "choice", answers };
  }
  if (payload.kind === "permission" && answer.kind === "permission" && answer.decision === "allow-always" && !payload.canAlwaysAllow) {
    return bad("This permission can't be allowed for good");
  }
  return delivered;
}

/** The most done items the Inbox lists (every open one is listed). */
export const MAX_DONE = 100;

/**
 * The Inbox. `pending`: what waits, newest first. `all`: what waits, then the latest done items
 * (answered or expired), each with its answer, who gave it and when.
 */
const list = owner.input(z.object({ status: z.enum(["pending", "all"]) })).handler(async ({ input, context }) => {
  // A workflow run has its workflow, a Job its agent: neither join may drop the other's questions.
  const select = () =>
    context.db
      .select({
        q: questionsTable,
        workflowId: workflows.id,
        workflowName: workflows.name,
        agentId: agents.id,
        agentName: agents.name,
        triggerId: triggers.id,
        triggerName: triggers.name,
        version: runs.version,
        def: runs.def,
        nodeId: stepRuns.nodeId,
      })
      .from(questionsTable)
      .innerJoin(runs, eq(runs.id, questionsTable.runId))
      .leftJoin(workflows, eq(workflows.id, runs.workflowId))
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(triggers, eq(triggers.id, runs.triggerId))
      // A checkpoint's Approval may have no step.
      .leftJoin(stepRuns, eq(stepRuns.id, questionsTable.stepRunId));
  const open = await select().where(waiting(context.ownerId)).orderBy(desc(questionsTable.createdAt), desc(questionsTable.id));
  const done =
    input.status === "all"
      ? await select()
          .where(and(inbox(context.ownerId), ne(questionsTable.status, "pending")))
          .orderBy(desc(sql`coalesce(${questionsTable.answeredAt}, ${questionsTable.createdAt})`), desc(questionsTable.id))
          .limit(MAX_DONE)
      : [];
  const rows = [...open, ...done];
  const versions = new Map<string, Map<string, string>>();
  const names = (def: WorkflowDef | undefined) => new Map((def ? nodesOf(def) : []).map((n) => [n.id, n.name]));
  const stepName = async (r: (typeof rows)[number]) => {
    // A checkpoint's Approval is about its root cause, not a step.
    if (r.q.rootId || !r.nodeId) return "Checkpoint";
    if (r.def || !r.workflowId) return names(r.def ?? undefined).get(r.nodeId);
    const key = `${r.workflowId}:${r.version}`;
    if (!versions.has(key)) {
      const [v] = await context.db
        .select({ def: workflowVersions.def })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.workflowId, r.workflowId), eq(workflowVersions.version, r.version)));
      versions.set(key, names(v?.def));
    }
    return versions.get(key)!.get(r.nodeId!);
  };
  const out = [];
  for (const r of rows) {
    out.push({
      ...questionView(r.q),
      orphaned: r.q.orphaned,
      workflow: r.workflowId ? { id: r.workflowId, name: r.workflowName! } : null,
      agent: r.agentId ? { id: r.agentId, name: r.agentName! } : null,
      trigger: r.triggerId ? { id: r.triggerId, name: r.triggerName! } : null,
      kind: r.q.kind,
      answeredAt: r.q.answeredAt,
      answeredBy: r.q.answeredBy,
      run: { id: r.q.runId },
      step: { name: (await stepName(r)) ?? r.nodeId! },
      // What the owner approves when the Approval is for a proposal: its items, from the server's row.
      proposal: r.q.proposalId ? await proposalView(context.db, context.ownerId, r.q.proposalId) : null,
    });
  }
  return out;
});

const countPending = owner.handler(({ context }) => pendingCount(context.db, context.ownerId));

/** The pending count as it is, then again after every change while the client listens. */
const stream = owner.handler(async function* ({ context, signal }) {
  // Subscribed before the first count is read, so no change falls between them.
  const changes = context.engine.questionChanges.subscribe("changed", { signal });
  yield await pendingCount(context.db, context.ownerId);
  for await (const change of changes) {
    void change;
    yield await pendingCount(context.db, context.ownerId);
  }
});

const answer = owner.input(z.object({ questionId: z.string(), answer: Answer })).handler(async ({ input, context }) => {
  const [q] = await context.db
    .select()
    .from(questionsTable)
    .where(and(eq(questionsTable.id, input.questionId), inbox(context.ownerId)));
  if (!q) throw new ORPCError("NOT_FOUND");
  const delivered = check(q.payload, input.answer);
  // An orphaned question's answer goes as a message (its words, with a prefix), and any question
  // can become orphaned before delivery: the message must fit the protocol too, or it would be lost.
  const asMessage = answerText({ payload: q.payload, answer: delivered });
  if (asMessage.length > TEXT || !storable(asMessage)) {
    throw new ORPCError("BAD_REQUEST", { message: `The answer is too long (at most about ${TEXT - 100} characters)` });
  }
  // The engine's pending → answered update is the atomic step: a second answer finds nothing pending.
  await context.engine.answer(q.id, delivered, { type: "user", userId: context.ownerId }).catch((err: unknown) => {
    if (err instanceof EngineError && err.code === "NOT_PENDING") throw new ORPCError("CONFLICT", { message: err.message });
    throw err;
  });
});

export const questions = { list, count: countPending, stream, answer };
