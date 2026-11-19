// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "./run-state.ts";

const fake = vi.hoisted(() => ({ runs: { stream: vi.fn(), get: vi.fn() } }));
vi.mock("./api.ts", () => ({ api: fake }));
const { MAX_RUN_STREAMS, POLL_MS, STREAM_WAIT_MS, refreshRun, useRun, useRunWatch } = await import("./run-watch.ts");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

const at = new Date(0);
const snap = (id: string): RunSnapshot => ({
  run: { id, source: "workflow" as const, workflowId: "wf", agentId: null, deletedAgentName: null, triggerId: null, version: 1, status: "running", trigger: { type: "manual" }, error: null, createdAt: at, finishedAt: null },
  steps: [],
  messages: [],
  questions: [],
  queue: [],
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

test("a stale action refresh cannot overwrite a newer streamed snapshot", async () => {
  let emit!: () => void;
  fake.runs.stream.mockImplementation(async (_input: unknown, { signal }: { signal: AbortSignal }) => (async function* () {
    yield { type: "snapshot" as const, ...snap("run_a") };
    await new Promise<void>((resolve) => { emit = resolve; });
    yield { type: "snapshot" as const, ...snap("run_a"), run: { ...snap("run_a").run, version: 3 } };
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
  })());
  const hook = renderHook(() => useRun("run_a"));
  await waitFor(() => expect(hook.result.current?.run.version).toBe(1));
  let resolve!: (value: RunSnapshot) => void;
  fake.runs.get.mockImplementation(() => new Promise<RunSnapshot>((yes) => { resolve = yes; }));
  const refresh = refreshRun("run_a");
  await act(async () => emit());
  await waitFor(() => expect(hook.result.current?.run.version).toBe(3));
  await act(async () => {
    resolve({ ...snap("run_a"), run: { ...snap("run_a").run, version: 2 } });
    await refresh;
  });
  expect(hook.result.current?.run.version).toBe(3);
});

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

test("a stream held back on the way (a buffering proxy) gives way to polling, so the run still shows", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fake.runs.stream.mockImplementation(async (_: unknown, { signal }: { signal: AbortSignal }) =>
    (async function* () {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      yield { type: "snapshot" as const, ...snap("run_h") };
    })(),
  );
  fake.runs.get.mockImplementation(async () => snap("run_h"));
  const hook = renderHook(() => useRun("run_h"));
  await vi.advanceTimersByTimeAsync(STREAM_WAIT_MS);
  await waitFor(() => expect(hook.result.current?.run.id).toBe("run_h"));
  expect(fake.runs.stream).toHaveBeenCalledTimes(1);
});

test("an active stream that closes keeps its last state and reconnects for both subscribers", async () => {
  vi.useFakeTimers();
  openStreams();
  fake.runs.stream.mockImplementationOnce(async () => (async function* () {
    yield { type: "snapshot", ...snap("run_a") };
  })());
  const a = renderHook(() => useRunWatch("run_a"));
  const b = renderHook(() => useRunWatch("run_a"));
  await act(async () => {});
  expect(a.result.current).toEqual({ state: snap("run_a"), interrupted: true });
  expect(b.result.current).toBe(a.result.current);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(a.result.current.interrupted).toBe(false);
  expect(b.result.current).toBe(a.result.current);
  await act(() => vi.advanceTimersByTimeAsync(STREAM_WAIT_MS * 2));
  expect(a.result.current.interrupted).toBe(false);
  expect(fake.runs.stream).toHaveBeenCalledTimes(2);
  expect(fake.runs.get).not.toHaveBeenCalled();
});

test("a run switch never renders the previous run's interruption, even before the first snapshot", async () => {
  vi.useFakeTimers();
  openStreams();
  fake.runs.stream.mockRejectedValueOnce(new Error("offline"));
  const renders: boolean[] = [];
  const hook = renderHook(({ id }) => {
    const value = useRunWatch(id);
    if (id === "run_b") renders.push(value.interrupted);
    return value;
  }, { initialProps: { id: "run_a" } });
  await act(async () => {});
  expect(hook.result.current).toEqual({ state: null, interrupted: true });
  hook.rerender({ id: "run_b" });
  await act(async () => {});
  expect(hook.result.current.state?.run.id).toBe("run_b");
  expect(renders).not.toContain(true);
});

test("a buffered stream recovers from a failed poll when a read succeeds", async () => {
  vi.useFakeTimers();
  fake.runs.stream.mockImplementation(async (_: unknown, { signal }: { signal: AbortSignal }) => (async function* () {
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    yield { type: "snapshot", ...snap("run_p") };
  })());
  fake.runs.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(snap("run_p"));
  const hook = renderHook(() => useRunWatch("run_p"));
  await act(() => vi.advanceTimersByTimeAsync(STREAM_WAIT_MS));
  expect(hook.result.current).toEqual({ state: null, interrupted: true });
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
  expect(hook.result.current).toEqual({ state: snap("run_p"), interrupted: false });
  expect(fake.runs.stream).toHaveBeenCalledTimes(1);
});

test("a failed final read keeps the last state and retries until reconciled", async () => {
  vi.useFakeTimers();
  const over = snap("run_x");
  over.run.status = "succeeded";
  fake.runs.stream.mockImplementation(async () => (async function* () {
    yield { type: "snapshot", ...over };
  })());
  const final = { ...over, run: { ...over.run, finishedAt: at } };
  fake.runs.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(final);
  const hook = renderHook(() => useRunWatch("run_x"));
  await act(async () => {});
  expect(hook.result.current).toEqual({ state: over, interrupted: true });
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
  expect(hook.result.current).toEqual({ state: final, interrupted: false });
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 2));
  expect(fake.runs.get).toHaveBeenCalledTimes(2);
  expect(fake.runs.stream).toHaveBeenCalledTimes(1);
});
