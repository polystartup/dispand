import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { afterStream, applyRunEvent, runOver, type RunSnapshot } from "./run-state.ts";

/**
 * At most this many `runs.stream` connections at once. Browsers allow six HTTP/1.1 connections
 * per host: the shell's `questions.stream` takes one, and the rest must stay free for requests.
 * Runs past the cap are polled (`runs.get`) until a stream frees up.
 */
export const MAX_RUN_STREAMS = 3;
export const POLL_MS = 3000;

type Entry = { state: RunSnapshot | null; listeners: Set<(s: RunSnapshot | null) => void>; stop: AbortController };

/** One watch per run, shared by every widget showing it. */
const entries = new Map<string, Entry>();
let streaming = 0;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

async function watch(runId: string, entry: Entry) {
  const { signal } = entry.stop;
  const set = (state: RunSnapshot | null) => {
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
  };
  for (let attempt = 0; !signal.aborted; attempt++) {
    if (streaming < MAX_RUN_STREAMS) {
      streaming++;
      try {
        for await (const event of await api.runs.stream({ runId }, { signal })) {
          set(applyRunEvent(entry.state, event));
          // Something came through: the next end of the stream starts the backoff over.
          attempt = -1;
          // A final run lets the connection go; resumable Job chats keep listening.
          if (runOver(entry.state)) break;
        }
      } catch {
        // Offline or the server restarted: decided below like a clean close.
      } finally {
        streaming--;
      }
      const next = afterStream(entry.state, Math.max(attempt, 0));
      if (signal.aborted) return;
      if (next.stop) {
        // The event that ended the run may come before the last changes of the same commit (a
        // question it expired): read the run once more rather than stop on a partial picture.
        try {
          set(await api.runs.get({ runId }, { signal }));
        } catch {
          // The streamed state stands.
        }
        return;
      }
      await sleep(next.delayMs, signal);
    } else {
      // No stream free: poll, and try for a stream again next time.
      try {
        set(await api.runs.get({ runId }, { signal }));
        attempt = -1;
        if (runOver(entry.state)) return;
      } catch {
        // Retried below.
      }
      await sleep(POLL_MS, signal);
    }
  }
}

/** The run as it is and as it changes, until it is over. Null: none yet. */
export function useRun(runId: string | null): RunSnapshot | null {
  const [state, setState] = useState<RunSnapshot | null>(null);
  useEffect(() => {
    setState(null);
    if (!runId) return;
    let entry = entries.get(runId);
    if (!entry) {
      entry = { state: null, listeners: new Set(), stop: new AbortController() };
      entries.set(runId, entry);
      void watch(runId, entry);
    }
    const mine = entry;
    mine.listeners.add(setState);
    setState(mine.state);
    return () => {
      mine.listeners.delete(setState);
      if (mine.listeners.size === 0) {
        mine.stop.abort();
        entries.delete(runId);
      }
    };
  }, [runId]);
  return state;
}
