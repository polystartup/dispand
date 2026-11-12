import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, questions, runs } from "../db/schema.ts";
import { rightsOf, within, type JobIdentity, type Rights } from "../platform/rights.ts";

// What an `inbox` reader may see of the Inbox (design 6.6): the one check, at dispatch for an
// `interaction` trigger's agent and, for the `inbox` tools, for the calling Job.

/** Who reads, and what it may use: its bundles and the tables they apply to. */
export type InboxScope = Pick<Rights, "bundles" | "tables"> & { ownerId: string; agentId: string };

/** At dispatch: the agent's rights as they are now. Null when it no longer exists. */
export async function agentScope(db: Db | Tx, ownerId: string, agentId: string): Promise<InboxScope | null> {
  const [row] = await db
    .select({ bundles: agents.bundles, tables: agents.dataTables })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)));
  return row ? { ownerId, agentId, bundles: row.bundles, tables: row.tables } : null;
}

/**
 * For a Job: its snapshot's rights that its agent still has, as the platform's authorization
 * computes them, so a grant after the Job was created widens nothing and a revocation narrows it
 * at once. Null once the Job is over.
 */
export async function jobScope(db: Db | Tx, job: JobIdentity): Promise<InboxScope | null> {
  const rights = await rightsOf(db, job);
  return rights ? { ownerId: job.ownerId, agentId: job.agentId, ...rights } : null;
}

/**
 * Whether `scope` may see the item: the reader has `inbox`, and the item is a Question with
 * choices (an Approval, or a confirmation of a Job's values, is a person's), asked by a Job of another agent, a Job without `configure`, whose
 * tables are all within the reader's. The asking Job is judged by its snapshot, everything it
 * could read while it worked, not by what its agent has kept since: a Question may quote what it
 * read before a table was taken away. A workflow's question (no agent, no snapshot) is never
 * reachable. Anything else, a missing item or another owner's included, is false: one answer for all.
 */
export async function reachable(db: Db | Tx, scope: InboxScope, questionId: string): Promise<boolean> {
  if (!scope.bundles.includes("inbox")) return false;
  const [row] = await db
    .select({ kind: questions.kind, payload: questions.payload, source: runs.source, agentId: runs.agentId, snapshot: runs.snapshot })
    .from(questions)
    .innerJoin(runs, eq(runs.id, questions.runId))
    .where(and(eq(questions.id, questionId), eq(questions.ownerId, scope.ownerId)));
  if (!row || row.kind !== "question" || row.payload.kind !== "choice" || row.source !== "agent" || !row.agentId || row.agentId === scope.agentId) return false;
  const bundles = row.snapshot?.bundles ?? [];
  if (bundles.includes("configure")) return false;
  // A Job with no bundle reached no table.
  return bundles.length === 0 || within(row.snapshot?.tables ?? "all", scope.tables);
}

/**
 * Whether an `interaction` event's Job may start, or its session be sent its prompt: the item is
 * `reachable`, and for `created`, still open (one answered or expired while its event waited is
 * nothing to help with). `answered` and `expired` Jobs start on a closed item.
 */
export async function startable(db: Db | Tx, scope: InboxScope, questionId: string, operation: string): Promise<boolean> {
  if (!(await reachable(db, scope, questionId))) return false;
  if (operation !== "created") return true;
  const [row] = await db.select({ status: questions.status }).from(questions).where(eq(questions.id, questionId));
  return row?.status === "pending";
}
