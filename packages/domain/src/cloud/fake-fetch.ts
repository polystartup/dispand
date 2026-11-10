// Test helper: a `fetch` that answers each request with the next recorded SSE fixture and
// keeps what was sent. No test calls a real provider.
import { readFileSync } from "node:fs";

export type SentRequest = { url: string; headers: Headers; body: Record<string, unknown>; text: string };

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export function fakeFetch(...fixtures: string[]) {
  const sent: SentRequest[] = [];
  const queue = [...fixtures];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = String(init?.body ?? "");
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(text), text });
    const next = queue.shift();
    if (next === undefined) throw new Error("no fixture left for this request");
    return new Response(fixture(next), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

export function collect() {
  const deltas: string[] = [];
  return { deltas, onText: (d: string) => void deltas.push(d), signal: new AbortController().signal };
}
