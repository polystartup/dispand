import { ORPCError } from "@orpc/server";
import { Answer, type QuestionPayload, storable, TEXT } from "@dispand/runner-protocol";
import { and, count, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { agents, questions as questionsTable, runs, stepRuns, triggers, user, workflows, workflowVersions } from "../db/schema.ts";
import { answerText } from "../engine/answers.ts";
import { EngineError, passOn } from "../engine/errors.ts";
import { awaitsConsentOf, questionView } from "../engine/views.ts";
import { jobAgentNameSql } from "../jobs/agent-name.ts";
import { proposalView } from "../platform/proposals.ts";
import { approvalView, PLUGIN_UPDATE } from "../plugins/resolve.ts";
import { message } from "../messages/index.ts";
import { base, inStreamScope, member } from "../rpc/context.ts";
import { authorize } from "../workspace/authorize.ts";
import { nodesOf, type WorkflowDef } from "../workflows/model.ts";

const owner = base.use(member);

/** Questions of the workspace's runs. */
const ofWorkspace = (db: Db, workspaceId: string) => inArray(questionsTable.runId, db.select({ id: runs.id }).from(runs).where(eq(runs.workspaceId, workspaceId)));

/** A person's Inbox items in a workspace: every Question and Approval addressed to them, never a consult, which an agent's Job answers (`engine/consults.ts`). */
const inbox = (db: Db, userId: string, workspaceId: string) => and(eq(questionsTable.addresseeId, userId), ne(questionsTable.kind, "consult"), ofWorkspace(db, workspaceId));

/**
 * Another person's answers to the caller's own personal actions, waiting for their consent
 * (`awaitsConsentOf`, the same rule as `Engine.consent`). Read on a query that joins each question's step.
 */
const awaitingConsentOf = (db: Db, userId: string, workspaceId: string) => and(
  sql`${questionsTable.consent}->>'state' = 'awaiting'`, isNull(questionsTable.deliveredAt),
  inArray(stepRuns.status, ["pending", "running", "waiting"]), sql`${stepRuns.placement}->>'kind' = 'personal'`, sql`${stepRuns.placement}->>'actorId' = ${userId}`,
  sql`${stepRuns.placement}->>'enrollmentId' = ${questionsTable.consent}->>'enrollmentId'`, ofWorkspace(db, workspaceId));

/**
 * Check at use for a listing: each pending escalation addressed to the caller is checked first
 * (`Engine.checkEscalation`, each in its own transaction), so one its addressee may no longer be
 * asked has moved on before the list is read, and isn't in it.
 */
async function checkListed(context: { db: Db; actorId: string; access: { workspaceId: string }; engine: { checkEscalation: (id: string, actor: { type: "user"; userId: string }) => Promise<string | null> } }) {
  const escalations = await context.db
    .select({ id: questionsTable.id })
    .from(questionsTable)
    .where(and(inbox(context.db, context.actorId, context.access.workspaceId), eq(questionsTable.status, "pending"), isNotNull(questionsTable.route)));
  for (const { id } of escalations) await context.engine.checkEscalation(id, { type: "user", userId: context.actorId });
}

/** How an escalation reached the caller: its hop, why, and who could no longer be asked before them (by name), for the Inbox's line. */
async function escalationOf(db: Db, q: typeof questionsTable.$inferSelect) {
  if (!q.route) return null;
  const before = q.route.tried.length > 1 ? q.route.tried[q.route.tried.length - 2]! : null;
  const [previous] = before ? await db.select({ name: user.name }).from(user).where(eq(user.id, before)) : [];
  // `left`: why that person was passed, for "can no longer be asked" or "didn't answer in 72 h".
  return { addresseeId: q.addresseeId, hop: q.route.hop, reason: q.route.reason, previous: previous?.name ?? null, left: q.route.left ?? null };
}

/**
 * Questions that wait for the owner. Chat questions count too: a chat the owner isn't looking at
 * would block silently. They show inline in their chat as well; answering in either place works.
 */
const waiting = (db: Db, userId: string, workspaceId: string) => and(inbox(db, userId, workspaceId), eq(questionsTable.status, "pending"));

async function pendingCount(db: Db, userId: string, workspaceId: string) {
  const [row] = await db.select({ n: count() }).from(questionsTable).where(waiting(db, userId, workspaceId));
  return { count: row!.n };
}

/**
 * Throws BAD_REQUEST when the answer doesn't fit the question; returns what to deliver (a listed
 * label exactly as listed, free text trimmed). Free-text "Other" is any string, so a label the question doesn't list can't be told
 * from it: it reaches the agent as the owner's own words.
 */
export function check(payload: QuestionPayload, answer: Answer): Answer {
  if (payload.kind !== answer.kind) throw new ORPCError("BAD_REQUEST", message("questions.answer.mismatch"));
  let delivered = answer;
  if (payload.kind === "choice" && answer.kind === "choice") {
    const answers: Record<string, string | string[]> = {};
    const asked = payload.questions.map((q) => q.question);
    if (Object.keys(answer.answers).some((k) => !asked.includes(k))) throw new ORPCError("BAD_REQUEST", message("questions.answer.notAsked"));
    for (const q of payload.questions) {
      const given = answer.answers[q.question];
      const labels = new Set(q.options.map((o) => o.label));
      // A listed label stays exactly as listed (the runner matches labels exactly); only free text is trimmed.
      const picks = (Array.isArray(given) ? given : given === undefined ? [] : [given]).map((p) => (labels.has(p) ? p : p.trim()));
      if (picks.length === 0 || picks.some((p) => p === "")) throw new ORPCError("BAD_REQUEST", message("questions.answer.missing", { question: q.question }));
      if (!q.multiSelect && picks.length > 1) throw new ORPCError("BAD_REQUEST", message("questions.answer.oneOnly", { question: q.question }));
      if (new Set(picks).size !== picks.length) throw new ORPCError("BAD_REQUEST", message("questions.answer.duplicate", { question: q.question }));
      answers[q.question] = Array.isArray(given) ? picks : picks[0]!;
    }
    delivered = { kind: "choice", answers };
  }
  if (payload.kind === "permission" && answer.kind === "permission" && answer.decision === "allow-always" && !payload.canAlwaysAllow) {
    throw new ORPCError("BAD_REQUEST", message("questions.answer.notForGood"));
  }
  return delivered;
}

/** The most done items the Inbox lists (every open one is listed). */
export const MAX_DONE = 100;

/** An agent's inbox: the consults addressed to it, which a Job of it answers. */
const agentInbox = (db: Db, workspaceId: string, agentId: string) => and(eq(questionsTable.kind, "consult"), eq(questionsTable.addresseeAgentId, agentId), ofWorkspace(db, workspaceId));

/**
 * The Inbox. `pending`: what waits, newest first. `all`: what waits, then the latest done items
 * (answered or expired), each with its answer, who gave it and when. With `agentId`, that agent's
 * inbox of the caller's workspace instead, read-only: everything in a workspace is shared.
 */
const list = owner.input(z.object({ status: z.enum(["pending", "all"]), agentId: z.string().optional() })).handler(async ({ input, context }) => {
  if (input.agentId) {
    // The workspace's agents, but other people's Assistants, which stay theirs.
    const [agent] = await context.db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, context.access.workspaceId), or(isNull(agents.builtIn), eq(agents.ownerId, context.actorId))));
    if (!agent) throw new ORPCError("NOT_FOUND", message("agent.notFound"));
  }
  if (!input.agentId) await checkListed(context);
  const items = input.agentId ? agentInbox(context.db, context.access.workspaceId, input.agentId) : inbox(context.db, context.actorId, context.access.workspaceId);
  // The caller's own: answers awaiting their consent wait with what is pending.
  const consents = input.agentId ? undefined : awaitingConsentOf(context.db, context.actorId, context.access.workspaceId);
  // A workflow run has its workflow, a Job its agent: neither join may drop the other's questions.
  const select = () =>
    context.db
      .select({
        q: questionsTable,
        workflowId: workflows.id,
        workflowName: workflows.name,
        agentId: runs.agentId,
        agentName: jobAgentNameSql,
        builtIn: agents.builtIn,
        triggerId: triggers.id,
        triggerName: triggers.name,
        version: runs.version,
        def: runs.def,
        nodeId: stepRuns.nodeId,
        step: { status: stepRuns.status, placement: stepRuns.placement, pendingAction: stepRuns.pendingAction, working: stepRuns.working, queuedAt: stepRuns.queuedAt },
      })
      .from(questionsTable)
      .innerJoin(runs, eq(runs.id, questionsTable.runId))
      .leftJoin(workflows, eq(workflows.id, runs.workflowId))
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(triggers, eq(triggers.id, runs.triggerId))
      // A checkpoint's Approval may have no step.
      .leftJoin(stepRuns, eq(stepRuns.id, questionsTable.stepRunId));
  const open = await select().where(or(and(items, eq(questionsTable.status, "pending")), consents)).orderBy(desc(questionsTable.createdAt), desc(questionsTable.id));
  const done =
    input.status === "all"
      ? await select()
          .where(and(items, ne(questionsTable.status, "pending"), consents ? sql`(${consents}) is not true` : undefined))
          .orderBy(desc(sql`coalesce(${questionsTable.answeredAt}, ${questionsTable.createdAt})`), desc(questionsTable.id))
          .limit(MAX_DONE)
      : [];
  const rows = [...open, ...done];
  const versions = new Map<string, Map<string, string>>();
  const names = (def: WorkflowDef | undefined) => new Map((def ? nodesOf(def) : []).map((n) => [n.id, n.name]));
  const stepName = async (r: (typeof rows)[number]) => {
    // A checkpoint's Approval is about its root cause, not a step.
    if (r.q.rootId) return "Checkpoint";
    // A plugin update's Approval is its Stem Job's, of no step.
    if (!r.nodeId) return r.agentName ?? undefined;
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
      ...questionView(r.q, r.step),
      // For the caller, read now: theirs to consent to (`questions.consent`).
      ...(awaitsConsentOf(r.q, r.step, context.actorId) ? { yoursToConsent: true } : {}),
      escalation: await escalationOf(context.db, r.q),
      orphaned: r.q.orphaned,
      workflow: r.workflowId ? { id: r.workflowId, name: r.workflowName! } : null,
      // A Job's agent; `id` null once it was deleted, and its name then says so (`jobs/agent-name.ts`).
      agent: r.agentName !== null ? { id: r.agentId, name: r.agentName, builtIn: r.builtIn } : null,
      trigger: r.triggerId ? { id: r.triggerId, name: r.triggerName! } : null,
      kind: r.q.kind,
      answeredAt: r.q.answeredAt,
      answeredBy: r.q.answeredBy,
      // A consult's: the Job started to answer it, once made.
      consultRunId: r.q.consultRunId,
      run: { id: r.q.runId },
      step: { name: (await stepName(r)) ?? r.nodeId ?? "" },
      // What the owner approves when the Approval is for a proposal: its items, from the server's row.
      proposal: r.q.proposalId ? await proposalView(context.db, context.actorId, r.q.proposalId) : null,
      // A plugin update's Approval: the plugin, and each of Stem's values still waiting, answered on its own.
      update: r.q.payload.kind === "permission" && r.q.payload.toolName === PLUGIN_UPDATE ? await approvalView(context.db, r.q) : null,
    });
  }
  return out;
});

const countPending = owner.handler(({ context }) => pendingCount(context.db, context.actorId, context.access.workspaceId));

/** The pending count as it is, then again after every change while the client listens. */
const stream = owner.handler(async function* ({ context, signal }) {
  // Subscribed before the first count is read, so no change falls between them.
  const changes = context.engine.questionChanges.subscribe("changed", { signal });
  const { organizationId, workspaceId } = context.access;
  // Before every count, the person's role there, read again: removed, the stream ends.
  const admit = async () => {
    if (!context.job && !(await authorize(context.db, context.actorId, organizationId, workspaceId))) throw new ORPCError("FORBIDDEN", message("workspace.membershipNotFound"));
    return { organizationId, workspaceId };
  };
  const currentCount = () => inStreamScope({ ...context, ownerId: context.actorId }, admit, () => pendingCount(context.db, context.actorId, workspaceId));
  try {
    yield await currentCount();
    for await (const change of changes) {
      void change;
      yield await currentCount();
    }
  } finally {
    await changes.return(undefined);
  }
});

const answer = owner.input(z.object({ questionId: z.string(), answer: Answer })).handler(async ({ input, context }) => {
  const [q] = await context.db
    .select()
    .from(questionsTable)
    .where(and(eq(questionsTable.id, input.questionId), inbox(context.db, context.actorId, context.access.workspaceId)));
  if (!q) throw new ORPCError("NOT_FOUND", message("questions.notFound"));
  const delivered = check(q.payload, input.answer);
  // An orphaned question's answer goes as a message (its words, with a prefix), and any question
  // can become orphaned before delivery: the message must fit the protocol too, or it would be lost.
  const asMessage = answerText({ payload: q.payload, answer: delivered });
  if (asMessage.length > TEXT || !storable(asMessage)) {
    throw new ORPCError("BAD_REQUEST", message("questions.answer.tooLong", { max: TEXT - 100 }));
  }
  // The engine's pending → answered update is the atomic step: a second answer finds nothing pending.
  await context.engine.answer(q.id, delivered, { type: "user", userId: context.actorId }).catch((err: unknown) => {
    // The engine's errors on this path all carry their message's key (`data`).
    if (err instanceof EngineError && err.code === "INVALID") throw new ORPCError("BAD_REQUEST", passOn(err));
    if (err instanceof EngineError && err.code === "NOT_PENDING") throw new ORPCError("CONFLICT", passOn(err));
    // An escalation that is no longer the caller's (checked at use by the engine, as it records the answer).
    if (err instanceof EngineError && err.code === "NOT_FOUND") throw new ORPCError("NOT_FOUND", passOn(err));
    throw err;
  });
});

/**
 * A personal action's subscriber consents to continue it with the answer another person gave
 * (`Engine.consent`): theirs alone to give, once, for that answer. Anyone else, or an answer not
 * waiting for them, gets NOT_FOUND and records nothing.
 */
const consent = owner.input(z.object({ questionId: z.string() })).handler(async ({ input, context }) => {
  if (!(await context.engine.consent(input.questionId, context.actorId, context.access.workspaceId))) throw new ORPCError("NOT_FOUND", message("questions.notFound"));
});

export const questions = { list, count: countPending, stream, answer, consent };
