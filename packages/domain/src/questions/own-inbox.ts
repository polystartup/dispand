import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, questions, roots, runs } from "../db/schema.ts";
import { jobAgentNameSql } from "../jobs/agent-name.ts";

/** The most items an agent's inbox gives, newest first. */
export const MAX_LISTED = 50;

/**
 * The pending items of the calling Job's agent's own inbox (or the one item `questionId`), newest
 * first; null once that Job is over. One predicate: addressed to the Job's agent, asked in the
 * Job's workspace, its root going (an item held at a checkpoint is invisible), the asking Job and
 * the calling one on the same side of `configure` by their snapshots, never by their agents' current
 * settings, and not the Job started for it, whose end is its answer.
 */
export async function ownInbox(db: Db | Tx, runId: string, questionId?: string) {
  const [caller] = await db.select({ agentId: runs.agentId, workspaceId: runs.workspaceId, snapshot: runs.snapshot, status: runs.status }).from(runs).where(eq(runs.id, runId));
  if (!caller?.agentId || !["running", "waiting"].includes(caller.status)) return null;
  const configure = caller.snapshot?.bundles?.includes("configure") ?? false;
  return db
    .select({ q: questions, agentId: runs.agentId, agentName: jobAgentNameSql })
    .from(questions)
    .innerJoin(runs, eq(runs.id, questions.runId))
    .innerJoin(roots, eq(roots.id, runs.rootId))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(
      and(
        eq(questions.addresseeAgentId, caller.agentId),
        eq(questions.status, "pending"),
        eq(runs.workspaceId, caller.workspaceId),
        eq(roots.state, "going"),
        sql`coalesce(${runs.snapshot}->'bundles', '[]'::jsonb) @> '["configure"]'::jsonb = ${configure}`,
        or(isNull(questions.consultRunId), ne(questions.consultRunId, runId)),
        questionId ? eq(questions.id, questionId) : undefined,
      ),
    )
    .orderBy(desc(questions.createdAt), desc(questions.id))
    .limit(MAX_LISTED);
}
