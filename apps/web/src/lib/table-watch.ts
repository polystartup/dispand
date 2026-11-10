import { useEffect, useRef } from "react";
import { api } from "./api.ts";

/** `rows.stream` takes this many tables; the others are polled. */
export const MAX_STREAM_TABLES = 20;
export const POLL_MS = 10_000;
/** A burst of changes calls `onChange` once, this long after the last. */
export const DEBOUNCE_MS = 300;
/** The stream is re-opened this long after the watched tables change, so several widgets mounting together open one. */
export const REOPEN_MS = 300;
const BACKOFF_MS = { first: 1000, max: 30_000 };

type Listener = { tableId: string; fire: () => void };

/** One stream per tab, over the tables every mounted widget and grid watches. */
const listeners = new Set<Listener>();
let open: { ids: string[]; stop: AbortController } | null = null;
let reopenTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const fireTable = (tableId: string) => {
  for (const l of listeners) if (l.tableId === tableId) l.fire();
};

function start(ids: string[]) {
  const stop = new AbortController();
  const { signal } = stop;
  void (async () => {
    let dropped = false;
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        const events = await api.rows.stream({ tableIds: ids }, { signal });
        // Changes made while the stream was down are unknown: read everything again.
        if (dropped) ids.forEach(fireTable);
        for await (const event of events) {
          attempt = -1;
          fireTable(event.tableId);
        }
      } catch {
        // Offline, the server restarted, or a table is gone: retried below like a clean close.
      }
      dropped = true;
      await sleep(Math.min(BACKOFF_MS.first * 2 ** Math.max(attempt, 0), BACKOFF_MS.max), signal);
    }
  })();
  return { ids, stop };
}

function reopen() {
  const ids = [...new Set([...listeners].map((l) => l.tableId))];
  const streamed = ids.slice(0, MAX_STREAM_TABLES);
  if (!open || open.ids.length !== streamed.length || !streamed.every((id) => open!.ids.includes(id))) {
    open?.stop.abort();
    const before = new Set(open?.ids);
    open = streamed.length > 0 ? start(streamed) : null;
    // What changed between a widget's first read and this stream opening is missed: read it again.
    streamed.filter((id) => !before.has(id)).forEach(fireTable);
  }
  clearInterval(pollTimer);
  pollTimer = undefined;
  if (ids.length > streamed.length) {
    const polled = new Set(ids.slice(MAX_STREAM_TABLES));
    pollTimer = setInterval(() => polled.forEach(fireTable), POLL_MS);
  }
}

/**
 * Calls `onChange` (debounced) when rows or the schema of the table change. Every widget and the
 * Data grid share one `rows.stream` per tab, over the union of the tables they watch.
 */
export function useTableWatch(tableId: string, onChange: () => void): void {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener: Listener = {
      tableId,
      fire: () => {
        clearTimeout(timer);
        timer = setTimeout(() => latest.current(), DEBOUNCE_MS);
      },
    };
    listeners.add(listener);
    clearTimeout(reopenTimer);
    reopenTimer = setTimeout(reopen, REOPEN_MS);
    return () => {
      clearTimeout(timer);
      listeners.delete(listener);
      clearTimeout(reopenTimer);
      reopenTimer = setTimeout(reopen, REOPEN_MS);
    };
  }, [tableId]);
}
