import { type Answer, TEXT } from "@dispand/runner-protocol";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, questions, roots, runs, stepRuns } from "../db/schema.ts";
import { consultsOf, pairProblem } from "../agents/consults.ts";
import { storableText } from "../text.ts";
import { STOPPED } from "./engine.ts";
import { JOB_STEP } from "./job-def.ts";
import { ROOT_STOPPED } from "./roots.ts";

// Consults (design 6.13): a Job asks an agent its agent may consult one question, and waits for
// the answer of a Job of that agent. The wait is a `questions` row of kind `consult`; the engine
// makes the consulted Job when the row is asked (`Engine.openConsult`) and answers the row when
// that Job ends (`Engine.answerConsult`). Here: who may consult whom at each of those moments,
// and what the asker is told.

type QuestionRow = typeof questions.$inferSelect;
type RunRow = typeof runs.$inferSelect;

/** Why a consult ends when a flag was put on its entry after it was asked: the owner wants to be asked first now. */
export const FLAGGED = "The owner now asks before this consult: consult again to ask them";
/** Why a flagged consult the owner said no to has no answer. */
export const DECLINED = "The owner declined this consult";
/** Why a flagged consult whose question the owner can't be shown whole is refused. */
export const TOO_LONG = "This consult asks the owner first, and the question is too long to show them whole: shorten it";
export const NOT_LISTED = "Your agent may not consult this agent";
export const IN_CHAIN = "This agent already waits higher in this chain of consults: consulting it would wait on itself";

/** Why a run that ended without an answer gave none, as the asker reads it. */
export const CONSULTED_STOPPED = "The consulted Job was stopped";
export const CONSULTED_STOPPED_AT_CHECKPOINT = "The consulted Job was stopped at a checkpoint";

/**
 * Why the asking Job may not consult `consultedId` as its rights are now: the entry must be in
 * the Job's snapshot and on its agent now, the pair must pass `pairProblem`, and, unless the owner
 * was asked for this consult (`asked`), the entry is flagged in neither. Checked at the call and
 * again before the answer reaches the asker, so a right taken back meanwhile turns the answer
 * into this reason.
 */
async function rightsProblem(db: Db | Tx, run: Pick<RunRow, "ownerId" | "agentId" | "snapshot">, consultedId: string, asked: boolean): Promise<string | null> {
  if (!run.agentId || !run.snapshot) return NOT_LISTED;
  const then = run.snapshot.consults?.find((e) => e.agentId === consultedId);
  const now = (await consultsOf(db, run.agentId)).find((e) => e.agentId === consultedId);
  if (!then || !now) return NOT_LISTED;
  const pair = await pairProblem(db, run.ownerId, run.agentId, consultedId);
  if (pair) return pair;
  return !asked && (then.ask || now.ask) ? FLAGGED : null;
}

/**
 * The Approval the owner was asked for this consult, its entry being flagged (`Engine.askApproval`);
 * undefined when none was. Once asked, the flag is that Approval's to settle: a yes lets the
 * consult go on whatever the flag is since, and a no is its answer.
 */
export async function approvalOf(db: Db | Tx, consultId: string): Promise<QuestionRow | undefined> {
  const [row] = await db.select().from(questions).where(eq(questions.consultId, consultId));
  return row;
}

/** The agents of the chain of consults `runId` belongs to: its own, then each asking Job's above it. */
export async function chainAgents(db: Db | Tx, runId: string): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  let id: string | undefined = runId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const [run] = await db.select({ agentId: runs.agentId, cause: runs.cause }).from(runs).where(eq(runs.id, id));
    if (!run) break;
    if (run.agentId) found.push(run.agentId);
    id = run.cause?.kind === "consult" ? run.cause.jobId : undefined;
  }
  return found;
}

/**
 * Why the Job `askingRunId` may not consult `consultedId` now, in the asker's words; null when it
 * may: its rights (`rightsProblem`), an agent not already in its chain of consults (itself
 * included), and a root that isn't stopped.
 */
export async function consultProblem(db: Db | Tx, askingRunId: string, consultedId: string, asked: boolean): Promise<string | null> {
  const [run] = await db.select().from(runs).where(eq(runs.id, askingRunId));
  if (!run || run.source !== "agent") return NOT_LISTED;
  // The flag last: a consult that would be refused anyway asks the owner nothing.
  const rights = await rightsProblem(db, run, consultedId, true);
  if (rights) return rights;
  if ((await chainAgents(db, askingRunId)).includes(consultedId)) return IN_CHAIN;
  const [root] = run.rootId ? await db.select({ state: roots.state }).from(roots).where(eq(roots.id, run.rootId)) : [];
  if (!root) return NOT_LISTED;
  if (root.state === "stopped") return ROOT_STOPPED;
  return asked ? null : rightsProblem(db, run, consultedId, false);
}

/**
 * For a consult row: why its asker may no longer get an answer (`rightsProblem`, as the rights are
 * now); null when it may. Also what ends a consult in flight when a right is taken back (`Engine.endConsults`).
 */
export async function deliveryProblem(db: Db | Tx, q: Pick<QuestionRow, "id" | "runId" | "payload" | "consultRunId">): Promise<string | null> {
  if (q.payload.kind !== "consult") return null;
  const [run] = await db.select({ ownerId: runs.ownerId, agentId: runs.agentId, snapshot: runs.snapshot }).from(runs).where(eq(runs.id, q.runId));
  if (!run) return NOT_LISTED;
  // The flag guards what a consulted Job gives: a consult that made none carries only Dispand's own reason.
  const asked = !q.consultRunId || (await approvalOf(db, q.id)) !== undefined;
  return rightsProblem(db, run, q.payload.agentId, asked);
}

export const failed = (text: string): Extract<Answer, { kind: "consult" }> => ({ kind: "consult", outcome: "failed", text: storableText(text.slice(0, TEXT)) });

/** What a consulted run that ended gives its asker: its result, or why it has none. */
export async function consultEnd(db: Db | Tx, run: Pick<RunRow, "id" | "status" | "error" | "rootId">): Promise<Extract<Answer, { kind: "consult" }>> {
  if (run.status === "succeeded") {
    const [step] = await db.select({ outputs: stepRuns.outputs }).from(stepRuns).where(and(eq(stepRuns.runId, run.id), eq(stepRuns.nodeId, JOB_STEP), eq(stepRuns.status, "succeeded")));
    return { kind: "consult", outcome: "answered", text: storableText((step?.outputs?.result ?? "").slice(0, TEXT)) };
  }
  if (run.error === STOPPED) {
    const [root] = run.rootId ? await db.select({ state: roots.state }).from(roots).where(eq(roots.id, run.rootId)) : [];
    return failed(root?.state === "stopped" ? CONSULTED_STOPPED_AT_CHECKPOINT : CONSULTED_STOPPED);
  }
  return failed(`The consulted Job failed: ${run.error ?? "no reason given"}`);
}

/** The consulted agent's name now, for the asker's prompt and the answer's attribution. */
export async function agentName(db: Db | Tx, agentId: string): Promise<string> {
  const [row] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
  return row?.name ?? "an agent";
}
