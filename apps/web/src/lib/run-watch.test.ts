// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "./run-state.ts";

const fake = vi.hoisted(() => ({ runs: { stream: vi.fn(), get: vi.fn() } }));
vi.mock("./api.ts", () => ({ api: fake }));
const { MAX_RUN_STREAMS, useRun } = await import("./run-watch.ts");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const at = new Date(0);
const snap = (id: string): RunSnapshot => ({
  run: { id, source: "workflow" as const, workflowId: "wf", agentId: null, triggerId: null, version: 1, status: "running", trigger: { type: "manual" }, error: null, createdAt: at, finishedAt: null },
  steps: [],
  messages: [],
  questions: [],
});

/** A stream that sends its run's snapshot, then stays open until aborted. */
function openStreams() {
  fake.runs.stream.mockImplementation(async ({ runId }: { runId: string }, { signal }: { signal: AbortSignal }) =>
    (async function* () {
      yield { type: "snapshot" as const, ...snap(runId) };
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    })(),
  );
  fake.runs.get.mockImplementation(async ({ runId }: { runId: string }) => snap(runId));
}

test("widgets showing one run share its stream", async () => {
  openStreams();
  const a = renderHook(() => useRun("run_a"));
  const b = renderHook(() => useRun("run_a"));
  await waitFor(() => expect(b.result.current?.run.id).toBe("run_a"));
  expect(a.result.current?.run.id).toBe("run_a");
  expect(fake.runs.stream).toHaveBeenCalledTimes(1);
});

test(`past ${MAX_RUN_STREAMS} runs, the others are polled instead of holding a connection`, async () => {
  openStreams();
  const ids = Array.from({ length: MAX_RUN_STREAMS + 2 }, (_, i) => `run_${i}`);
  const hooks = ids.map((id) => renderHook(() => useRun(id)));
  await waitFor(() => hooks.forEach((h, i) => expect(h.result.current?.run.id).toBe(ids[i])));
  expect(fake.runs.stream).toHaveBeenCalledTimes(MAX_RUN_STREAMS);
  expect(fake.runs.get).toHaveBeenCalledTimes(2);
  // Unmounting a streamed run frees its connection for the next poll.
  hooks[0]!.unmount();
  await waitFor(() => expect(fake.runs.stream).toHaveBeenCalledTimes(MAX_RUN_STREAMS + 1), { timeout: 5000 });
});

test("a run that ends is read once more, so its last changes (an expired question) are not missed", async () => {
  const over = { ...snap("run_x"), run: { ...snap("run_x").run, status: "failed" as const } };
  const pending = { id: "q1", runId: "run_x", stepRunId: "s", placement: "chat" as const, status: "pending" as const, answer: null, createdAt: at, payload: { kind: "confirm-outputs" as const, values: {} } };
  fake.runs.stream.mockImplementation(async () =>
    (async function* () {
      yield { type: "snapshot" as const, ...snap("run_x"), questions: [pending] };
      // The run's failure arrives; the question's expiry, of the same commit, is still to come.
      yield { type: "run" as const, run: over.run };
    })(),
  );
  fake.runs.get.mockResolvedValue({ ...over, questions: [{ ...pending, status: "expired" as const }] });
  const hook = renderHook(() => useRun("run_x"));
  await waitFor(() => expect(hook.result.current?.questions[0]?.status).toBe("expired"));
  expect(fake.runs.get).toHaveBeenCalledTimes(1);
});
