import type { messages, questions, runs, stepRuns } from "../db/schema.ts";
import { deletedAgent } from "../jobs/agent-name.ts";

export type RunRow = typeof runs.$inferSelect;
export type StepRow = typeof stepRuns.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;

export function runView(r: RunRow) {
  const { id, source, workflowId, version, agentId, triggerId, status, trigger, error, createdAt, finishedAt } = r;
  // A Job whose agent was deleted names it as it kept it: "Order drafter (Deleted)".
  const deletedAgentName = agentId === null && r.agentName !== null ? deletedAgent(r.agentName) : null;
  return { id, source, workflowId, version, agentId, deletedAgentName, triggerId, status, trigger, error, createdAt, finishedAt };
}
export function stepView(s: StepRow) {
  const { id, runId, nodeId, iteration, status, outputs, error, startedAt, finishedAt, queuedAt, turnStatus, turnId, interruptible } = s;
  // prompt: as the step got it, values filled in (for the owner to debug a run); null until started.
  return { id, runId, nodeId, iteration, status, outputs, error, startedAt, finishedAt, queuedAt, turnStatus, turnId, interruptible, interactive: s.start?.interactive ?? false, prompt: s.start?.prompt ?? null, ...(s.cliSessionId ? { resumable: true as const } : {}) };
}
export function messageView(m: MessageRow) {
  const { id, runId, stepRunId, role, text, createdAt, files, result } = m;
  return { id, runId, stepRunId, role, text, createdAt, ...(files?.length ? { files } : {}), ...(result ? { result } : {}) };
}
export function questionView(q: QuestionRow) {
  // `rootId`: a checkpoint's Approval (`roots.ts`), and `consultId` a consult's, each told apart by it and never by its tool name.
  const { id, runId, stepRunId, placement, payload, status, answer, createdAt, about, proposalId, rootId, consultId } = q;
  return { id, runId, stepRunId, placement, payload, status, answer, createdAt, about, proposalId, rootId, consultId, ...(q.remember ? { remember: { scopes: q.remember.scopes, ...(q.remember.decisions ? { decisions: q.remember.decisions } : {}), label: q.remember.subject.kind === "cli" ? q.remember.subject.rule : about ? `${about.tool}: ${about.action}` : payload.kind === "permission" ? payload.toolName : "" } } : {}) };
}

/** What `runs.stream` forwards: each carries the whole row as it is now (upserts by id). */
export type RunEvent =
  | { type: "run"; run: ReturnType<typeof runView> }
  | { type: "step"; step: ReturnType<typeof stepView> }
  | { type: "message"; message: ReturnType<typeof messageView> }
  | { type: "question"; question: ReturnType<typeof questionView> };

/**
 * What a transaction leaves to do once it commits: its runs' events, the steps it handed a slot
 * to (`slots.ts`), the Jobs it made (a consult's: they start), and the sessions of the steps it
 * stopped (told to end).
 */
export type Out = RunEvent | { type: "slot"; runId: string; stepId: string } | { type: "job"; runId: string } | { type: "end"; steps: StepRow[] };
