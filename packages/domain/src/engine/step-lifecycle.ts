import { endStepGrants } from "../runners/grants.ts";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { recordAudit } from "../audit/record.ts";
import type { Tx } from "../db/client.ts";
import { messages, runners, runs, stepRuns } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { message, storedText } from "../messages/index.ts";
import { issueJobToken } from "../platform/token.ts";
import type { SecretBox } from "../secrets.ts";
import { spanEvent } from "../telemetry/index.ts";
import { nodesOf } from "../workflows/model.ts";
import { EngineError } from "./errors.ts";
import { CLOUD_SOURCE, isCloud, type StartParams } from "./harness.ts";
import { newRoot } from "./roots.ts";
import { sessionHarness } from "./session-harness.ts";
import { defOf, expectRunLocked } from "./step-rows.ts";
import { continuationNode, type Out, runView, type StepRow, stepView } from "./views.ts";

// A step's life where several columns move together under one rule: its session replaced, its
// chat continued after it ended, its end. Each transition holds its own guard; continuing a chat
// also writes its Audit row, span and stream events. Slots and what waits for one are `slots.ts`'s.

type StepStatus = StepRow["status"];
export const ACTIVE_STEP: StepStatus[] = ["running", "waiting"];
export const OPEN_STEP: StepStatus[] = ["pending", "running", "waiting"];

/** No turn under way, none to interrupt, no input a turn start would confirm. */
const NO_TURN = { turnId: null, interruptible: false, interruptAfterPosition: null, codexInputId: null };
/** Nothing of the former session carries over: its start, its events and its slot are the new one's to get. */
const NEW_SESSION = { ...NO_TURN, turnStatus: "unknown" as const, startDeliveredAt: null, lastActivityAt: null, idleSince: null, eventSeq: 0, working: false, queuedAt: null, queueClass: null };

/** Session `sessionId` takes over from `former`, resuming its transcript once that one has ended. */
const replacement = (former: string, start: StartParams, sessionId: string) => ({
  ...NEW_SESSION, sessionId, start: { ...start, sessionId }, pendingAction: { kind: "resume" as const }, resumeAfterSession: { sessionId: former, ended: false },
});

/** A live chat gets a new session (its run's skills or tools changed), which resumes its transcript. */
export async function replaceSession(tx: Tx, step: StepRow & { sessionId: string; start: StartParams }): Promise<StepRow> {
  const [row] = await tx.update(stepRuns).set(replacement(step.sessionId, step.start, newId("ses"))).where(eq(stepRuns.id, step.id)).returning();
  return row!;
}

/** The harness said the step's transcript can't resume: its next session starts fresh (`reopen`). */
export async function transcriptGone(tx: Tx, step: StepRow) {
  await tx.update(stepRuns).set({ cliSessionId: null }).where(eq(stepRuns.id, step.id));
}

/** Ends an open step, succeeded with its outputs or failed with its error; undefined if it had ended already. */
export async function endStep(tx: Tx, step: StepRow, end: { status: "succeeded"; outputs: Record<string, string> } | { status: "failed"; error: string }, out: Out[]): Promise<StepRow | undefined> {
  expectRunLocked(tx, step.runId);
  const [row] = await tx
    .update(stepRuns)
    .set({ ...NO_TURN, ...end, turnStatus: "idle", finishedAt: new Date() })
    .where(and(eq(stepRuns.id, step.id), inArray(stepRuns.status, OPEN_STEP)))
    .returning();
  if (row) out.push({ type: "step", step: stepView(row) });
  if (row?.placement?.kind === "personal") await endStepGrants(tx, row.id, "ended");
  return row;
}

/** A new turn in the same run, keeping its transcript but replacing its session (and a Job's token). */
export async function reopen(tx: Tx, step: StepRow, out: Out[], { continueChat, secrets }: { continueChat: boolean; secrets?: SecretBox | undefined }): Promise<StepRow> {
  expectRunLocked(tx, step.runId);
  const [run] = await tx.select().from(runs).where(eq(runs.id, step.runId));
  const def = run && (await defOf(run, tx));
  if (!run || !def || continuationNode(run, def) !== step.nodeId || step.status !== run.status || (run.tokenSealed && !secrets)) throw new EngineError("CLOSED", message("engine.chatOver"));
  // Retain automatic continuation for a successful chat with history. A failure racing an
  // initial send needs a new submission from the owner before starting work again.
  if (!continueChat && !(run.status === "succeeded" && step.cliSessionId)) throw new EngineError("CLOSED", message("engine.chatOver"));
  let harness = step.harness;
  let sameHarness = true;
  let placement = step.placement;
  if (continueChat) {
    const node = nodesOf(def).find((n) => n.id === step.nodeId)!;
    // The owner's new message authorizes it afresh: its credential is chosen again.
    const current = await sessionHarness(tx, run, node, { ...step, placement: null });
    if ("problem" in current) {
      const reason = storedText(current.problem);
      if ("key" in reason) throw new EngineError("CLOSED", message(reason.key, reason.values));
      throw new EngineError("CLOSED", message("engine.chatRunnerGone"));
    }
    harness = current.harness;
    placement = current.placement;
    sameHarness = harness.id === step.harness?.id && harness.kind === step.harness.kind && (isCloud(harness) || harness.runnerId === step.runnerId);
  }
  if (sameHarness && step.runnerId && step.runnerId !== CLOUD_SOURCE) {
    const [runner] = await tx.select({ revokedAt: runners.revokedAt }).from(runners).where(and(eq(runners.id, step.runnerId), eq(runners.workspaceId, run.workspaceId))).for("share");
    if (!runner || runner.revokedAt) throw new EngineError("CLOSED", message("engine.chatRunnerGone"));
  }
  const job = run.source === "agent";
  const token = job && secrets ? issueJobToken(secrets, run.id) : null;
  const [reopened] = await tx.update(runs).set({ status: "running", error: null, finishedAt: null, ...(job ? { rootId: await newRoot(tx, run.ownerId, run.workspaceId, "chat", run.id) } : {}), ...(token ? { tokenHash: token.hash, tokenSealed: token.sealed } : {}) }).where(and(eq(runs.id, run.id), eq(runs.status, run.status))).returning();
  if (!reopened) throw new EngineError("CLOSED", message("engine.chatOver"));
  const sessionId = newId("ses");
  // A resume the harness said it couldn't take (`cannot-resume` cleared the transcript's id):
  // the next send starts fresh, told the conversation so far (`openSession`).
  const missingTranscript = step.start?.resumeCliSessionId && !step.cliSessionId;
  const next = sameHarness && !missingTranscript && harness && step.sessionId && step.start ? {
    ...replacement(step.sessionId, { ...step.start, ...(step.cliSessionId ? { resumeCliSessionId: step.cliSessionId } : {}) }, sessionId), status: "running" as const, harness,
  } : {
    status: "pending" as const, sessionId: null, harness: null, start: null, runnerId: harness ? (isCloud(harness) ? CLOUD_SOURCE : harness.runnerId) : null,
    cliSessionId: null, pendingAction: null, resumeAfterSession: null,
  };
  if (!next.sessionId) {
    // A fresh session hasn't had the owner's messages since the agent's last answer: they go to
    // it as messages again (with their files); what came before is told in its start prompt.
    const [answer] = await tx.select({ position: messages.position }).from(messages).where(and(eq(messages.stepRunId, step.id), eq(messages.role, "assistant"))).orderBy(desc(messages.position)).limit(1);
    await tx.update(messages).set({ deliveredAt: null }).where(and(eq(messages.stepRunId, step.id), eq(messages.role, "user"), isNotNull(messages.deliveredAt), answer ? sql`${messages.position} > ${answer.position}` : undefined));
  }
  const [chat] = await tx.update(stepRuns).set({ ...NEW_SESSION, ...next, placement, error: null, outputs: null, finishedAt: null }).where(eq(stepRuns.id, step.id)).returning();
  // A failed workflow's steps after the chat that never started (closed by the stop or failure)
  // wait for it again; a finished one's stay as they ended (a skipped branch is not reconsidered).
  const waiting = job || run.status !== "failed" ? [] : await tx.update(stepRuns).set({ status: "pending", error: null, finishedAt: null, queuedAt: null, queueClass: null, pendingAction: null })
    .where(and(eq(stepRuns.runId, run.id), ne(stepRuns.id, step.id), isNull(stepRuns.startedAt), inArray(stepRuns.status, ["failed", "skipped"]))).returning();
  for (const row of waiting) out.push({ type: "step", step: stepView(row) });
  if (job) await recordAudit(tx, { ownerId: run.ownerId, actor: run.ownerId ? { type: "user", userId: run.ownerId } : { type: "job", runId: run.id }, agentId: run.agentId, jobId: run.id, action: "job.reopened", resource: { type: "job", id: run.id } });
  spanEvent("engine.reopen", { "dispand.job.id": run.id, "dispand.step.id": step.id, ...(next.sessionId ? { "dispand.session.id": next.sessionId } : {}) });
  out.push({ type: "run", run: runView(reopened, def) }, { type: "step", step: stepView(chat!) });
  return chat!;
}
