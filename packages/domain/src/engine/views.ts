import type { chatQueue, messages, questions, runs, stepRuns } from "../db/schema.ts";
import type { Paused } from "../runners/grants.ts";
import { deletedAgent } from "../jobs/agent-name.ts";
import { steering } from "./harness.ts";
import type { WorkflowDef } from "../workflows/model.ts";

export type RunRow = typeof runs.$inferSelect;
export type StepRow = typeof stepRuns.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;
export type QueuedRow = typeof chatQueue.$inferSelect;

/**
 * The chat trigger an owner can continue after its run ended (failed, stopped or finished), even
 * if its first session never started. A workflow run keeps no def: pass its version's.
 */
export function continuationNode(run: RunRow, def: WorkflowDef | null = run.def) {
  if (def?.trigger.field.type !== "chat" || (run.status !== "failed" && run.status !== "succeeded")) return undefined;
  if (run.source === "agent" && !run.agentId) return undefined;
  return def.trigger.field.id;
}

export function runView(r: RunRow, def: WorkflowDef | null = r.def) {
  const { id, source, workflowId, version, agentId, triggerId, status, trigger, error, createdAt, finishedAt } = r;
  // A Job whose agent was deleted names it as it kept it: "Order drafter (Deleted)".
  const deletedAgentName = agentId === null && r.agentName !== null ? deletedAgent(r.agentName) : null;
  const chatNode = continuationNode(r, def);
  return { ...(chatNode ? { continuationNodeId: chatNode } : {}), id, source, workflowId, version, agentId, deletedAgentName, triggerId, status, trigger, error, createdAt, finishedAt };
}
/** A step not ended yet: only then can it, or its answers, wait for consent or recovery. */
const going = (s: Pick<StepRow, "status">) => s.status === "pending" || s.status === "running" || s.status === "waiting";

/** Why a personal action waits (`runners/grants.ts`), while it isn't ended, holds no slot and isn't queued for one. */
export function pausedFor(s: Pick<StepRow, "status" | "pendingAction" | "working" | "queuedAt">): Paused | undefined {
  return going(s) && s.pendingAction?.paused && !s.working && !s.queuedAt ? s.pendingAction.paused : undefined;
}

/**
 * Whether `userId` is the one to consent now to another person's answer to a personal action
 * (`Engine.consent`): it awaits, undelivered, its step's subscriber, under the same enrollment.
 */
export function awaitsConsentOf(q: Pick<QuestionRow, "consent" | "deliveredAt" | "stepRunId">, step: Pick<StepRow, "status" | "placement"> | null | undefined, userId: string): boolean {
  const placement = step?.placement;
  return q.consent?.state === "awaiting" && !q.deliveredAt && !!q.stepRunId && !!step && going(step) && placement?.kind === "personal" && placement.actorId === userId && placement.enrollmentId === q.consent.enrollmentId;
}

export function stepView(s: StepRow) {
  const { id, runId, nodeId, iteration, status, outputs, error, startedAt, finishedAt, queuedAt, turnStatus, turnId, interruptible } = s;
  // prompt: as the step got it, values filled in (for the owner to debug a run); null until started.
  // `credential`: the kind of its placement only, never whose subscription.
  const paused = pausedFor(s);
  return { id, runId, nodeId, iteration, status, outputs, error, startedAt, finishedAt, queuedAt, turnStatus, turnId, interruptible, interactive: s.start?.interactive ?? false, prompt: s.start?.prompt ?? null, ...(s.placement ? { credential: s.placement.kind } : {}), ...(s.nativePlugins?.length ? { nativePlugins: s.nativePlugins.map((p) => p.name) } : {}), ...(paused ? { paused } : {}), ...(s.cliSessionId ? { resumable: true as const } : {}), ...(s.start?.interactive && s.harness ? { steering: steering(s.harness) } : {}) };
}
export function messageView(m: MessageRow) {
  const { id, runId, stepRunId, role, text, createdAt, files, result } = m;
  return { id, runId, stepRunId, role, text, createdAt, ...(files?.length ? { files } : {}), ...(result ? { result } : {}) };
}
/** A queued chat message; `removed` and `dispatched` tell a client to drop it (a dispatched one is now the message of the same id). */
export function queuedView(q: QueuedRow) {
  const { id, runId, stepRunId, state, text, skillId, files, error, createdAt } = q;
  return { id, runId, stepRunId, state, text, skillId, error, createdAt, ...(files?.length ? { files } : {}) };
}
/**
 * `step`: its step's row, when the reader has it. `recovery`: its answer is recorded but its personal
 * action paused before taking it (`Engine.personalAnswer`), so it waits for that action's recovery.
 */
export function questionView(q: QuestionRow, step?: Pick<StepRow, "status" | "pendingAction" | "working" | "queuedAt"> | null) {
  // `rootId`: a checkpoint's Approval (`roots.ts`), told apart by it and never by its tool name.
  const { id, runId, stepRunId, placement, payload, status, answer, createdAt, about, proposalId, rootId } = q;
  const recovery = status === "answered" && !q.deliveredAt && !!step && pausedFor(step) !== undefined;
  return { id, runId, stepRunId, placement, payload, status, answer, createdAt, about, proposalId, rootId, ...(recovery ? { recovery } : {}), ...(q.consent ? { consent: q.consent.state } : {}), ...(q.route && q.addresseeId ? { escalation: { addresseeId: q.addresseeId, hop: q.route.hop } } : {}), ...(q.remember ? { remember: { scopes: q.remember.scopes, ...(q.remember.decisions ? { decisions: q.remember.decisions } : {}), label: q.remember.subject.kind === "cli" ? q.remember.subject.rule : about ? `${about.tool}: ${about.action}` : payload.kind === "permission" ? payload.toolName : "" } } : {}) };
}

/** What `runs.stream` forwards: each carries the whole row as it is now (upserts by id). */
export type RowEvent =
  | { type: "run"; run: ReturnType<typeof runView> }
  | { type: "step"; step: ReturnType<typeof stepView> }
  | { type: "message"; message: ReturnType<typeof messageView> }
  | { type: "question"; question: ReturnType<typeof questionView> }
  | { type: "queued"; queued: ReturnType<typeof queuedView> };

/**
 * What `Engine.events` carries per run: row events, and `changed`, which names rows of the run by
 * kind and id. `runs.stream` reads each named row again, as its reader may see it, and forwards
 * its row event: `changed` itself never reaches a client. Dispand never publishes it (`Out` has
 * none); a process that embeds Dispand publishes it for changes it learns of another way.
 */
export type RunEvent = RowEvent | { type: "changed"; rows: { kind: RowEvent["type"]; id: string }[] };

/**
 * What a transaction leaves to do once it commits: its runs' events, the steps it handed a slot
 * to (`slots.ts`), the Jobs it made (a consult's: they start), and the sessions of the steps it
 * stopped (told to end).
 */
export type Out = RowEvent | { type: "slot"; runId: string; stepId: string } | { type: "job"; runId: string } | { type: "end"; steps: StepRow[] };
