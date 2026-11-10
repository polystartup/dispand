import type { api } from "./api.ts";

export type RunSnapshot = Awaited<ReturnType<typeof api.runs.get>>;
export type RunChange = Exclude<Awaited<ReturnType<typeof api.runs.stream>> extends AsyncIterable<infer E> ? E : never, { type: "snapshot" }>;
export type RunStreamEvent = RunChange | ({ type: "snapshot" } & RunSnapshot);

function upsert<T extends { id: string }>(list: T[], row: T): T[] {
  const i = list.findIndex((x) => x.id === row.id);
  return i === -1 ? [...list, row] : list.map((x, j) => (j === i ? row : x));
}

/** Applies one `runs.stream` event: a snapshot replaces everything, any other event upserts its row. */
export function applyRunEvent(state: RunSnapshot | null, event: RunStreamEvent): RunSnapshot | null {
  if (event.type === "snapshot") {
    return { run: event.run, steps: event.steps, messages: event.messages, questions: event.questions };
  }
  if (!state) return state;
  switch (event.type) {
    case "run":
      return { ...state, run: event.run };
    case "step":
      return { ...state, steps: upsert(state.steps, event.step) };
    case "message":
      return { ...state, messages: upsert(state.messages, event.message) };
    case "question":
      return { ...state, questions: upsert(state.questions, event.question) };
  }
}

/**
 * Whether nothing in the run changes any more. A failed run may still have steps at work (parallel
 * branches go on after one fails): their results and questions still come.
 */
export function runOver(state: RunSnapshot | null): boolean {
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
