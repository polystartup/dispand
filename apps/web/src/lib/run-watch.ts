import { useCallback, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { afterStream, applyRunEvent, runOver, type RunSnapshot } from "./run-state.ts";

/**
 * At most this many `runs.stream` connections at once. Browsers allow six HTTP/1.1 connections
 * per host: the shell's `questions.stream` takes one, and the rest must stay free for requests.
 * Runs past the cap are polled (`runs.get`) until a stream frees up.
 */
export const MAX_RUN_STREAMS = 3;
export const POLL_MS = 3000;
/** A stream that sends nothing this long is held back on the way (a buffering proxy): the run is polled instead. */
export const STREAM_WAIT_MS = 5000;

type WatchedRun = { state: RunSnapshot | null; interrupted: boolean };
const initial: WatchedRun = { state: null, interrupted: false };
type Entry = { value: WatchedRun; listeners: Set<() => void>; stop: AbortController };

function publish(entry: Entry, state: RunSnapshot | null, interrupted = false) {
  if (entry.value.state === state && entry.value.interrupted === interrupted) return;
  entry.value = { state, interrupted };
  for (const listener of entry.listeners) listener();
}

/** One watch per run, shared by every widget showing it. */
const entries = new Map<string, Entry>();
let streaming = 0;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

async function watch(runId: string, entry: Entry) {
  const { signal } = entry.stop;
  // Once a stream was held back, this run is polled: the next one would be held back too.
  let held = false;
  for (let attempt = 0; !signal.aborted; attempt++) {
    if (!held && !runOver(entry.value.state) && streaming < MAX_RUN_STREAMS) {
      streaming++;
      // The stream's first event, its snapshot, comes at once from the server.
      const connection = new AbortController();
      const stop = () => connection.abort();
      signal.addEventListener("abort", stop, { once: true });
      let heard = false;
      const timer = setTimeout(() => {
        if (heard) return;
        held = true;
        connection.abort();
      }, STREAM_WAIT_MS);
      try {
        for await (const event of await api.runs.stream({ runId }, { signal: connection.signal })) {
          heard = true;
          publish(entry, applyRunEvent(entry.value.state, event));
          // Something came through: the next end of the stream starts the backoff over.
          attempt = -1;
          // A final run lets the connection go; resumable Job chats keep listening.
          if (runOver(entry.value.state)) break;
        }
      } catch {
        // Offline or the server restarted: decided below like a clean close.
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        streaming--;
      }
      if (signal.aborted) return;
      const next = afterStream(entry.value.state, Math.max(attempt, 0));
      // The terminal event can precede other changes in its commit. Fetch the final snapshot
      // on the next pass, and keep polling if that read fails.
      if (next.stop) continue;
      publish(entry, entry.value.state, true);
      if (!held) await sleep(next.delayMs, signal);
    } else {
      try {
        publish(entry, await api.runs.get({ runId }, { signal }));
        attempt = -1;
        if (runOver(entry.value.state)) return;
      } catch {
        if (signal.aborted) return;
        publish(entry, entry.value.state, true);
      }
      await sleep(POLL_MS, signal);
    }
  }
}

/** Refresh a stale action without overwriting an event received while the read was in flight. */
export async function refreshRun(runId: string): Promise<void> {
  const entry = entries.get(runId);
  if (!entry) return;
  const before = entry.value.state;
  const state = await api.runs.get({ runId }, { signal: entry.stop.signal });
  if (entries.get(runId) !== entry || entry.value.state !== before) return;
  publish(entry, state, entry.value.interrupted);
}

/** One shared snapshot and delivery status for all consumers watching this run. */
export function useRunWatch(runId: string | null): WatchedRun {
  const subscribe = useCallback((listener: () => void) => {
    if (!runId) return () => {};
    let entry = entries.get(runId);
    if (!entry) {
      entry = { value: initial, listeners: new Set(), stop: new AbortController() };
      entries.set(runId, entry);
      void watch(runId, entry);
    }
    const mine = entry;
    mine.listeners.add(listener);
    return () => {
      mine.listeners.delete(listener);
      if (mine.listeners.size === 0) {
        mine.stop.abort();
        entries.delete(runId);
      }
    };
  }, [runId]);
  return useSyncExternalStore(subscribe, () => (runId && entries.get(runId)?.value) || initial, () => initial);
}

/** The run as it is and as it changes, until it is over. Null: none yet. */
export function useRun(runId: string | null): RunSnapshot | null {
  return useRunWatch(runId).state;
}
