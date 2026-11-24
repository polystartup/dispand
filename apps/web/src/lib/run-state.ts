import type { api } from "./api.ts";

type Read = Awaited<ReturnType<typeof api.runs.get>>;
/** `yoursToConsent` is sent for the reader (`runs.get`) but isn't in the procedure's inferred type: `runQuestion` takes `questionView`'s type. */
export type RunSnapshot = Omit<Read, "questions"> & { questions: (Read["questions"][number] & { yoursToConsent?: boolean })[] };
export type RunChange = Exclude<Awaited<ReturnType<typeof api.runs.stream>> extends AsyncIterable<infer E> ? E : never, { type: "snapshot" }>;
export type RunStreamEvent = RunChange | ({ type: "snapshot" } & RunSnapshot);

function upsert<T extends { id: string }>(list: T[], row: T): T[] {
  const i = list.findIndex((x) => x.id === row.id);
  return i === -1 ? [...list, row] : list.map((x, j) => (j === i ? row : x));
}

/** Applies one `runs.stream` event: a snapshot replaces everything, any other event upserts its row. */
export function applyRunEvent(state: RunSnapshot | null, event: RunStreamEvent): RunSnapshot | null {
  if (event.type === "snapshot") {
    return { run: event.run, steps: event.steps, messages: event.messages, questions: event.questions, queue: event.queue };
  }
  if (!state) return state;
  switch (event.type) {
    case "run":
      return { ...state, run: event.run };
    case "step": {
      // Her answer is no longer hers to consent to once the step is over (events carry no `yoursToConsent`).
      const over = event.step.status !== "pending" && event.step.status !== "running" && event.step.status !== "waiting";
      const questions = over ? state.questions.map((q) => (q.stepRunId === event.step.id && q.yoursToConsent ? { ...q, yoursToConsent: undefined } : q)) : state.questions;
      return { ...state, steps: upsert(state.steps, event.step), questions };
    }
    case "message":
      return { ...state, messages: upsert(state.messages, event.message) };
    case "question": {
      // An event carries no `yoursToConsent` (only a read does): what was hers stays hers while it awaits her.
      const mine = state.questions.find((q) => q.id === event.question.id)?.yoursToConsent && event.question.consent === "awaiting" && !event.question.recovery;
      return { ...state, questions: upsert(state.questions, mine ? { ...event.question, yoursToConsent: true as const } : event.question) };
    }
    case "queued": {
      // Dispatched (now the message of the same id) or removed, it leaves the queue.
      const rest = state.queue.filter((q) => q.id !== event.queued.id);
      return { ...state, queue: event.queued.state === "pending" || event.queued.state === "failed" ? upsert(state.queue, event.queued) : rest };
    }
  }
}

/**
 * Whether the owner can go on with the run's chat after it ended (failed, stopped or finished):
 * the server says which trigger may, and the run ended with that chat, not after it.
 */
export function canReopen(state: RunSnapshot | null): boolean {
  const node = state?.run.continuationNodeId;
  return !!node && state.steps.some((s) => s.nodeId === node && s.status === state.run.status);
}

/**
 * Whether nothing in the run changes any more. A failed run may still have steps at work (parallel
 * branches go on after one fails): their results and questions still come.
 */
export function runOver(state: RunSnapshot | null): boolean {
  if (canReopen(state)) return false;
  if (state?.run.status === "succeeded") return true;
  return state?.run.status === "failed" && !state.steps.some((s) => s.status === "running" || s.status === "waiting");
}

/**
 * What to do once a run's stream ended, cleanly or not: stop when the run is over; otherwise
 * reconnect in 1 s, 2 s, 4 s… up to 30 s (`attempt` counts ends in a row without an event, from 0).
 * A clean close of an active run (a proxy's idle timeout) reconnects too.
 */
export function afterStream(state: RunSnapshot | null, attempt: number): { stop: true } | { stop: false; delayMs: number } {
  if (runOver(state)) return { stop: true };
  return { stop: false, delayMs: Math.min(1000 * 2 ** attempt, 30_000) };
}
