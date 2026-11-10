import { expect, test } from "vitest";
import { applyRunEvent, afterStream, type RunSnapshot } from "./run-state.ts";

const at = new Date(0);
const snapshot: RunSnapshot = {
  run: { id: "run_1", workflowId: "wf_1", version: 1, status: "running", trigger: { type: "manual" }, error: null, createdAt: at, finishedAt: null },
  steps: [],
  messages: [{ id: "m1", runId: "run_1", stepRunId: "s1", role: "assistant", text: "Hi", createdAt: at }],
  questions: [],
};

test("a snapshot replaces the state, later events upsert their row by id", () => {
  let state = applyRunEvent(null, { type: "message", message: snapshot.messages[0]! });
  expect(state).toBeNull();
  state = applyRunEvent(state, { type: "snapshot", ...snapshot });
  expect(state).toEqual(snapshot);
  state = applyRunEvent(state, { type: "message", message: { ...snapshot.messages[0]!, text: "Hi there" } });
  state = applyRunEvent(state, { type: "message", message: { ...snapshot.messages[0]!, id: "m2", role: "user", text: "Yo" } });
  expect(state!.messages.map((m) => m.text)).toEqual(["Hi there", "Yo"]);
  state = applyRunEvent(state, { type: "run", run: { ...snapshot.run, status: "succeeded" } });
  expect(state!.run.status).toBe("succeeded");
});

test("the stream stops only once the run is over; otherwise it reconnects, backing off to 30 s", () => {
  const over = { ...snapshot, run: { ...snapshot.run, status: "succeeded" as const } };
  expect(afterStream(over, 0)).toEqual({ stop: true });
  expect(afterStream({ ...over, run: { ...over.run, status: "failed" } }, 0)).toEqual({ stop: true });
  // Failed, but a parallel step still works: its result is still to come.
  const working = { id: "s2", runId: "run_1", nodeId: "n2", iteration: 0, status: "running" as const, outputs: null, error: null, startedAt: at, finishedAt: null, interactive: false, prompt: null };
  expect(afterStream({ ...over, run: { ...over.run, status: "failed" }, steps: [working] }, 0)).toEqual({ stop: false, delayMs: 1000 });
  // An active run whose stream ended (error or a proxy's clean close) reconnects.
  expect(afterStream(snapshot, 0)).toEqual({ stop: false, delayMs: 1000 });
  expect(afterStream(null, 1)).toEqual({ stop: false, delayMs: 2000 });
  expect(afterStream(snapshot, 3)).toEqual({ stop: false, delayMs: 8000 });
  expect(afterStream(snapshot, 12)).toEqual({ stop: false, delayMs: 30_000 });
});
