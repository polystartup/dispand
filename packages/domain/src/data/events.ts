import { EventPublisher } from "@orpc/server";

/** What changed in a table: some of its rows, or its schema (name, fields, choices). */
export type DataEvent = { type: "rows"; tableId: string; rowIds: string[] } | { type: "schema"; tableId: string };

const MAX_BUFFERED = 100;

/** Changes per table, published after their commit, for `rows.stream`. */
export class DataEvents {
  private readonly publisher = new EventPublisher<Record<string, DataEvent>>({ maxBufferedEvents: MAX_BUFFERED });

  publish(event: DataEvent): void {
    this.publisher.publish(event.tableId, event);
  }

  /**
   * The events of these tables, in order. Subscribed when called, not on the first `next`, so
   * nothing published after this call is missed; at most the latest 100 wait unread.
   */
  subscribe(tableIds: string[], signal?: AbortSignal): AsyncIterableIterator<DataEvent> {
    const buffered: DataEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const offs = [...new Set(tableIds)].map((id) =>
      this.publisher.subscribe(id, (event) => {
        buffered.push(event);
        if (buffered.length > MAX_BUFFERED) buffered.shift();
        wake?.();
      }),
    );
    const close = () => {
      if (closed) return;
      closed = true;
      for (const off of offs) off();
      signal?.removeEventListener("abort", close);
      wake?.();
    };
    if (signal?.aborted) close();
    else signal?.addEventListener("abort", close);
    const done = { done: true as const, value: undefined };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        while (buffered.length === 0 && !closed) await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        if (closed) return done;
        return { done: false, value: buffered.shift()! };
      },
      async return() {
        close();
        return done;
      },
    };
  }
}

const globalForEvents = globalThis as { __dispandDataEvents?: DataEvents };

/** The process's one publisher, kept on `globalThis` so dev reloads of this module reuse it. */
export function getDataEvents(): DataEvents {
  return (globalForEvents.__dispandDataEvents ??= new DataEvents());
}
