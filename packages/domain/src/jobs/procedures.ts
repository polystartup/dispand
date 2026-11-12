import { ORPCError } from "@orpc/server";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { messages, questions, runs, stepRuns, triggers } from "../db/schema.ts";
import { messageView, questionView } from "../engine/engine.ts";
import { authed, base } from "../rpc/context.ts";
import { engineError, runQuestion } from "../workflows/procedures.ts";
import { consultsOfJob } from "./consults.ts";

const owner = base.use(authed);

/** Starts a Job of a manual trigger; a chat placement also gives the conversation's session. */
const start = owner.input(z.object({ triggerId: z.string() })).handler(async ({ input, context }) => {
  const [trigger] = await context.db
    .select()
    .from(triggers)
    .where(and(eq(triggers.id, input.triggerId), eq(triggers.ownerId, context.ownerId)));
  if (!trigger) throw new ORPCError("NOT_FOUND");
  if (trigger.config.kind !== "manual") throw new ORPCError("BAD_REQUEST", { message: "Only a manual trigger can be started by hand" });
  if (!trigger.enabled) throw new ORPCError("BAD_REQUEST", { message: "This trigger is disabled" });
  const runId = await context.engine.startJob(trigger.id, context.ownerId).catch(engineError);
  if (trigger.config.placement !== "chat") return { runId };
  const [chat] = await context.db
    .select({ sessionId: stepRuns.sessionId })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, trigger.id)));
  return { runId, ...(chat?.sessionId ? { chatSessionId: chat.sessionId } : {}) };
});

/** A Job's definition, as it was created: what its run page and its conversation name the steps from. */
const def = owner.input(z.object({ runId: z.string() })).handler(async ({ input, context }) => {
  const [run] = await context.db
    .select({ def: runs.def })
    .from(runs)
    .where(and(eq(runs.id, input.runId), eq(runs.ownerId, context.ownerId)));
  if (!run?.def) throw new ORPCError("NOT_FOUND");
  return run.def;
});

/** The consults of a Job, for its page: those it asked, and the one it answers (`consults.ts`). */
const consults = owner.input(z.object({ runId: z.string() })).handler(async ({ input, context }) => {
  const [run] = await context.db
    .select({ id: runs.id, ownerId: runs.ownerId, cause: runs.cause })
    .from(runs)
    .where(and(eq(runs.id, input.runId), eq(runs.ownerId, context.ownerId)));
  if (!run) throw new ORPCError("NOT_FOUND");
  return consultsOfJob(context.db, run);
});

/**
 * A Job as `jobs.list` and `jobs.get` show it: what made it, how it went, never its token or
 * snapshot. A poll item's id is what the tool read (it may be a subject line), so it stays out,
 * as in a trigger's polls for a Job.
 */
function jobView(r: typeof runs.$inferSelect) {
  const { id, agentId, triggerId, status, error, createdAt, finishedAt } = r;
  const cause = r.cause?.kind === "poll" ? { kind: r.cause.kind, triggerId: r.cause.triggerId, depth: r.cause.depth } : r.cause;
  return { id, agentId, triggerId, status, cause, error, createdAt, finishedAt };
}

/** How many Jobs `jobs.list` gives, newest first. */
export const JOBS_PAGE = 50;

/**
 * The owner's latest Jobs, of one agent or one trigger, or with one status: who ran, why, how it
 * went, and the ids of its Questions and Approvals still waiting. No workflow run.
 */
const list = owner
  .input(
    z.object({
      agentId: z.string().optional(),
      triggerId: z.string().optional(),
      status: z.enum(["running", "waiting", "succeeded", "failed"]).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const rows = await context.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.ownerId, context.ownerId),
          eq(runs.source, "agent"),
          input.agentId ? eq(runs.agentId, input.agentId) : undefined,
          input.triggerId ? eq(runs.triggerId, input.triggerId) : undefined,
          input.status ? eq(runs.status, input.status) : undefined,
        ),
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(JOBS_PAGE);
    const ids = rows.map((r) => r.id);
    const open = ids.length
      ? await context.db
          .select({ id: questions.id, runId: questions.runId })
          .from(questions)
          .where(and(inArray(questions.runId, ids), eq(questions.status, "pending")))
          .orderBy(asc(questions.createdAt))
      : [];
    return rows.map((r) => ({ ...jobView(r), openQuestionIds: open.filter((q) => q.runId === r.id).map((q) => q.id) }));
  });

/** How many messages of a transcript `jobs.get` gives at most at once. */
export const MAX_MESSAGES = 200;

/**
 * One Job with its transcript (a page of its messages, oldest first, and how many it has) and
 * its Questions and Approvals, answered ones included.
 */
const get = owner
  .input(
    z.object({
      id: z.string(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(MAX_MESSAGES).default(50),
    }),
  )
  .handler(async ({ input, context }) => {
    const [run] = await context.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, input.id), eq(runs.ownerId, context.ownerId), eq(runs.source, "agent")));
    if (!run) throw new ORPCError("NOT_FOUND");
    const [transcript, [total], asked] = await Promise.all([
      context.db.select().from(messages).where(eq(messages.runId, run.id)).orderBy(asc(messages.position)).offset(input.offset).limit(input.limit),
      context.db.select({ n: count() }).from(messages).where(eq(messages.runId, run.id)),
      context.db.select().from(questions).where(eq(questions.runId, run.id)).orderBy(asc(questions.createdAt)),
    ]);
    return {
      ...jobView(run),
      messages: transcript.map(messageView),
      totalMessages: total?.n ?? 0,
      questions: await Promise.all(asked.map((q) => runQuestion(context.db, context.ownerId, questionView(q)))),
    };
  });

export const jobs = { start, def, consults, list, get };
