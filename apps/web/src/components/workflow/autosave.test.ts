import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Autosaver, saverFor, type SaveState } from "./autosave.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferredSaves() {
  const calls: { value: string; resolve: () => void; reject: () => void }[] = [];
  const save = (value: string) =>
    new Promise<string>((resolve, reject) => calls.push({ value, resolve: () => resolve(value), reject: () => reject(new Error("x")) }));
  const states: SaveState[] = [];
  const saved: string[] = [];
  const saver = new Autosaver(save, { state: (s) => states.push(s), saved: (r) => saved.push(r) }, 800);
  return { calls, states, saved, saver };
}

test("saves 800 ms after the last change, one save at a time, then the latest pending value", async () => {
  const { calls, states, saved, saver } = deferredSaves();
  saver.change("a");
  saver.change("ab");
  await vi.advanceTimersByTimeAsync(799);
  expect(calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls.map((c) => c.value)).toEqual(["ab"]);

  // Edits while it is in flight: no second save until the first settles.
  saver.change("abc");
  saver.change("abcd");
  await vi.advanceTimersByTimeAsync(800);
  expect(calls).toHaveLength(1);
  calls[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.map((c) => c.value)).toEqual(["ab", "abcd"]);
  expect(states.at(-1)).toBe("saving");
  calls[1]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  // "ab" came back with "abcd" waiting: only the latest result counts.
  expect(saved).toEqual(["abcd"]);
  expect(states.at(-1)).toBe("saved");
});

test("not 'Saved' while an edit is pending; a failed save is retried with the next flush", async () => {
  const { calls, states, saver } = deferredSaves();
  saver.change("a");
  await vi.advanceTimersByTimeAsync(800);
  saver.change("ab");
  calls[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toBe("unsaved");
  await vi.advanceTimersByTimeAsync(800);
  calls[1]!.reject();
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toBe("error");
  expect(saver.latest).toBe("ab");

  const flushed = saver.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.map((c) => c.value)).toEqual(["a", "ab", "ab"]);
  calls[2]!.resolve();
  await flushed;
  expect(states.at(-1)).toBe("saved");
});

test("flush saves at once and waits for the save in flight first", async () => {
  const { calls, saved, saver } = deferredSaves();
  saver.change("a");
  await vi.advanceTimersByTimeAsync(800);
  saver.change("ab");
  const flushed = saver.flush();
  expect(calls).toHaveLength(1);
  calls[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.map((c) => c.value)).toEqual(["a", "ab"]);
  calls[1]!.resolve();
  await flushed;
  expect(saved).toEqual(["ab"]);
});

test("a save's result is reported only when no newer value waits behind it", async () => {
  const { calls, saved, saver } = deferredSaves();
  saver.change("a");
  await vi.advanceTimersByTimeAsync(800);
  saver.change("ab");
  calls[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  // "a" came back while "ab" waits: reporting it would put stale content in the cache.
  expect(saved).toEqual([]);
  await vi.advanceTimersByTimeAsync(800);
  calls[1]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(saved).toEqual(["ab"]);
});

test("an editor mounting again shares the queue: the older pending save can't land after the newer one", async () => {
  const { calls, saver } = deferredSaves();
  const again = saverFor("wf_1", () => saver);
  expect(saverFor("wf_1", () => new Autosaver(async () => "", { state: () => {}, saved: () => {} }))).toBe(again);
  // The first editor: one save in flight, a newer edit pending, then it leaves (flush).
  saver.change("a");
  await vi.advanceTimersByTimeAsync(800);
  saver.change("ab");
  void saver.flush();
  // The second editor takes the same queue and saves something newer still.
  const states: SaveState[] = [];
  again.listen({ state: (s) => states.push(s), saved: () => {} });
  expect(states).toEqual(["unsaved"]);
  again.change("abc");
  calls[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  // "ab" was replaced by "abc" before it went: nothing older follows the newest.
  expect(calls.map((c) => c.value)).toEqual(["a", "abc"]);
});
