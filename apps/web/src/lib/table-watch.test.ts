// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ rows: { stream: vi.fn() } }));
vi.mock("./api.ts", () => ({ api: fake }));
const { DEBOUNCE_MS, MAX_STREAM_TABLES, POLL_MS, REOPEN_MS, useTableWatch } = await import("./table-watch.ts");

type Event = { type: "rows"; tableId: string; rowIds: string[] };

/** Streams that stay open until aborted; `emit` sends an event to every one open. */
function openStreams() {
  const sinks = new Set<(e: Event) => void>();
  fake.rows.stream.mockImplementation(async (_input: unknown, { signal }: { signal: AbortSignal }) => {
    const queue: Event[] = [];
    let wake: (() => void) | undefined;
    const sink = (e: Event) => (queue.push(e), wake?.());
    sinks.add(sink);
    signal.addEventListener("abort", () => (sinks.delete(sink), wake?.()));
    return (async function* () {
      while (!signal.aborted) {
        if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
        const e = queue.shift();
        if (e) yield e;
      }
    })();
  });
  return (e: Event) => sinks.forEach((s) => s(e));
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const change = (tableId: string): Event => ({ type: "rows", tableId, rowIds: ["row_1"] });

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  cleanup();
  await tick(REOPEN_MS);
  vi.useRealTimers();
  vi.resetAllMocks();
});

test("two widgets on the same table share one stream", async () => {
  openStreams();
  renderHook(() => useTableWatch("tbl_a", () => {}));
  renderHook(() => useTableWatch("tbl_a", () => {}));
  await tick(REOPEN_MS);
  expect(fake.rows.stream).toHaveBeenCalledTimes(1);
  expect(fake.rows.stream.mock.calls[0]![0]).toEqual({ tableIds: ["tbl_a"] });
});

test("adding a table re-opens one stream with both ids", async () => {
  openStreams();
  renderHook(() => useTableWatch("tbl_a", () => {}));
  await tick(REOPEN_MS);
  renderHook(() => useTableWatch("tbl_b", () => {}));
  await tick(REOPEN_MS);
  expect(fake.rows.stream).toHaveBeenCalledTimes(2);
  expect(fake.rows.stream.mock.calls[1]![0]).toEqual({ tableIds: ["tbl_a", "tbl_b"] });
  // The first one was closed.
  expect((fake.rows.stream.mock.calls[0]![1] as { signal: AbortSignal }).signal.aborted).toBe(true);
});

test("a burst of events calls onChange once, for the watching table only", async () => {
  const emit = openStreams();
  const a = vi.fn();
  const b = vi.fn();
  renderHook(() => useTableWatch("tbl_a", a));
  renderHook(() => useTableWatch("tbl_b", b));
  await tick(REOPEN_MS + DEBOUNCE_MS);
  a.mockClear();
  b.mockClear();
  for (let i = 0; i < 5; i++) {
    emit(change("tbl_a"));
    await tick(50);
  }
  expect(a).not.toHaveBeenCalled();
  await tick(DEBOUNCE_MS);
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).not.toHaveBeenCalled();
});

test("a table whose stream just opened is read again, in case it changed meanwhile", async () => {
  openStreams();
  const onChange = vi.fn();
  renderHook(() => useTableWatch("tbl_a", onChange));
  await tick(REOPEN_MS + DEBOUNCE_MS);
  expect(onChange).toHaveBeenCalledTimes(1);
});

test("a dropped stream is re-opened after a backoff and everything is read again", async () => {
  fake.rows.stream.mockRejectedValueOnce(new Error("offline"));
  openStreams();
  const onChange = vi.fn();
  renderHook(() => useTableWatch("tbl_a", onChange));
  await tick(REOPEN_MS);
  expect(fake.rows.stream).toHaveBeenCalledTimes(1);
  await tick(999);
  expect(fake.rows.stream).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(fake.rows.stream).toHaveBeenCalledTimes(2);
  onChange.mockClear();
  await tick(DEBOUNCE_MS);
  expect(onChange).toHaveBeenCalledTimes(1);
});

test(`past ${MAX_STREAM_TABLES} tables, the others are polled`, async () => {
  openStreams();
  const ids = Array.from({ length: MAX_STREAM_TABLES + 1 }, (_, i) => `tbl_${i}`);
  const extra = vi.fn();
  ids.forEach((id, i) => renderHook(() => useTableWatch(id, i === MAX_STREAM_TABLES ? extra : () => {})));
  await tick(REOPEN_MS);
  expect((fake.rows.stream.mock.calls[0]![0] as { tableIds: string[] }).tableIds).toEqual(ids.slice(0, MAX_STREAM_TABLES));
  extra.mockClear();
  await tick(POLL_MS + DEBOUNCE_MS);
  expect(extra).toHaveBeenCalledTimes(1);
});
