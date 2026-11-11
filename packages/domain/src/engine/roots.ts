import type { QuestionPayload } from "@dispand/runner-protocol";
import { and, asc, count, eq, isNotNull } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, questions, roots, runs, stepRuns, workspaceSettings, type RootKind } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { meter, spanEvent } from "../telemetry/index.ts";

// A root cause (design 6.1) and its checkpoints. Every Job is counted against its root in
// `Engine.createJob`, with the root's row locked (`FOR UPDATE`, before the trigger's and the
// agent's share locks, so `jobs/active.ts`'s order holds); its state is read where a session would
// work again (`rootGoing`).

const counts = meter("engine");

/** The tool name of a checkpoint's Approval (a `permission` question with no session). */
export const CHECKPOINT = "checkpoint";

/** The workspace's checkpoint when it has none set. */
export const DEFAULT_CHECKPOINT = 100;

/** Why no Job of a declined root is made. */
export const ROOT_STOPPED = "Stopped at a checkpoint";

/** The most agents a checkpoint's Approval names. */
const MAX_AGENTS = 20;

export async function checkpointOf(db: Db | Tx, ownerId: string): Promise<number> {
  const [row] = await db.select({ checkpoint: workspaceSettings.checkpoint }).from(workspaceSettings).where(eq(workspaceSettings.ownerId, ownerId));
  return row?.checkpoint ?? DEFAULT_CHECKPOINT;
}

/** A new root cause, going, with nothing counted yet. */
export async function newRoot(db: Db | Tx, ownerId: string, kind: RootKind, runId: string | null): Promise<string> {
  const id = newId("root");
  await db.insert(roots).values({ id, ownerId, kind, runId });
  return id;
}

/** Whether the run may work: its root cause is going (a workflow run has none, and goes). */
export async function rootGoing(db: Db | Tx, runId: string): Promise<boolean> {
  const [row] = await db.select({ state: roots.state }).from(runs).innerJoin(roots, eq(roots.id, runs.rootId)).where(eq(runs.id, runId));
  return !row || row.state === "going";
}

/** What a root's Approval says it is, by kind. */
const ABOUT: Record<RootKind, string> = {
  user: "A start by you",
  chat: "Your message in a chat",
  schedule: "A schedule",
  event: "A change to a table",
  poll: "An item found by a poll",
};

/**
 * The root reached its checkpoint with the Job `reachedBy` (its row is locked by the caller): it
 * pauses and one Approval asks a person, on that Job (in the chat, for a chat message), naming
 * the root, its Jobs, the agents involved and since when. Names and counts only; no content.
 */
export async function pause(tx: Tx, root: typeof roots.$inferSelect, jobs: number, reachedBy: string): Promise<string> {
  await tx.update(roots).set({ state: "paused" }).where(eq(roots.id, root.id));
  const involved = await tx
    .selectDistinct({ name: agents.name })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(eq(runs.rootId, root.id), isNotNull(runs.agentId)))
    .orderBy(asc(agents.name))
    .limit(MAX_AGENTS);
  const [chat] =
    root.kind === "chat" && root.runId
      ? await tx.select({ id: stepRuns.id }).from(stepRuns).where(and(eq(stepRuns.runId, root.runId), isNotNull(stepRuns.sessionId))).limit(1)
      : [];
  const payload: QuestionPayload = {
    kind: "permission",
    toolName: CHECKPOINT,
    input: { root: ABOUT[root.kind], jobs, agents: involved.map((a) => a.name), since: root.createdAt.toISOString() },
    canAlwaysAllow: true,
  };
  const id = newId("q");
  await tx.insert(questions).values({
    id,
    ownerId: root.ownerId,
    runId: chat ? root.runId! : reachedBy,
    stepRunId: chat?.id ?? null,
    placement: chat ? "chat" : "notifications",
    kind: "approval",
    payload,
    status: "pending",
    rootId: root.id,
  });
  counts.counter("dispand.checkpoints.reached").add(1);
  counts.counter("dispand.questions.opened").add(1, { "dispand.question.kind": "approval" });
  spanEvent("engine.checkpoint", { "dispand.root.id": root.id, "dispand.root.kind": root.kind, "dispand.root.jobs": jobs });
  await pausedGauge(tx);
  return id;
}

/** How many roots wait on a person now. */
export async function pausedGauge(db: Db | Tx) {
  const [row] = await db.select({ n: count() }).from(roots).where(eq(roots.state, "paused"));
  counts.gauge("dispand.roots.paused", { description: "Root causes paused at a checkpoint" }).record(row?.n ?? 0);
}
