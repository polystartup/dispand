// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reloadOnChunkError } from "./chunk-reload.ts";

const reload = vi.fn();
let stop = () => {};
beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  vi.stubGlobal("location", { ...window.location, reload });
  stop = reloadOnChunkError();
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

const fail = () => {
  const event = new Event("vite:preloadError", { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

test("a chunk that fails to load reloads the page and swallows the error", () => {
  expect(fail().defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
});

test("a second failure within a minute is left to the error boundary", () => {
  fail();
  expect(fail().defaultPrevented).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
});

test("a failure a minute later reloads again", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  fail();
  vi.setSystemTime(Date.now() + 61_000);
  expect(fail().defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

test("without storage it never reloads", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(fail().defaultPrevented).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

test("once stopped, a failure is left alone", () => {
  stop();
  expect(fail().defaultPrevented).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
