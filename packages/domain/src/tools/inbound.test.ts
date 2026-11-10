import { expect, test } from "vitest";
import { InboundRefused, MAX_RESPONSE_BYTES, redact, screenedFetch } from "./inbound.ts";

function serving(body: string | ReadableStream<Uint8Array>, type: string): typeof fetch {
  return (async () => new Response(body, { status: 200, headers: { "content-type": type } })) as typeof fetch;
}

function screen(inner: typeof fetch) {
  const refusals: InboundRefused[] = [];
  const s = screenedFetch(inner, (e) => refusals.push(e));
  return { ...s, refusals };
}

test("a JSON message with too many values is refused before anything parses it further, envelope included", async () => {
  const icons = new Array(300_000).fill(null);
  const message = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { _meta: { "io.modelcontextprotocol/serverInfo": { icons } }, tools: [] } });
  const s = screen(serving(message, "application/json"));
  await expect(s.fetch("http://x/mcp")).rejects.toBeInstanceOf(InboundRefused);
  expect(s.refused()).toBe("sent a message too large to read");
  expect(s.refusals).toHaveLength(1);
});

test("an event stream is checked event by event, and passed on unchanged", async () => {
  const first = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"text":"ok"}}\n\n';
  const ok = screen(serving(first, "Text/Event-Stream; charset=utf-8"));
  expect(await (await ok.fetch("http://x/mcp")).text()).toBe(first);
  const big = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: new Array(201).fill({}) } });
  const s = screen(serving(`${first}event: message\ndata: ${big}\n\n`, "text/event-stream"));
  await expect((await s.fetch("http://x/mcp")).text()).rejects.toBeInstanceOf(InboundRefused);
  expect(s.refused()).toBe("offers more than 200 actions");
});

test("JSON is checked whatever the declared media type, as the SDK reads it", async () => {
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: new Array(201).fill({}) } });
  for (const type of ["Application/JSON", 'application/json; profile="text/event-stream"', "text/plain", ""]) {
    const s = screen(serving(big, type));
    await expect(s.fetch("http://x/mcp"), type).rejects.toBeInstanceOf(InboundRefused);
  }
});

test("the byte budget covers every response of the connection together", async () => {
  const half = "x".repeat(MAX_RESPONSE_BYTES / 2 + 10);
  const s = screen(serving(half, "text/plain"));
  await (await s.fetch("http://x/a")).text();
  await expect(s.fetch("http://x/b")).rejects.toBeInstanceOf(InboundRefused);
  expect(s.refused()).toBe("sent more than 16 MiB");
});

test("redact covers every string and key, short credentials included; only a scheme name stays", () => {
  const value = { a: "key abc", b: "Bearer hunter2", c: "token hunter2", "hunter2-key": 1, d: [`${"x".repeat(3990)}tok-0123456789`] };
  expect(redact(value, { "x-api-key": "abc", authorization: "Bearer hunter2", other: "tok-0123456789" })).toEqual({
    a: "key ••••",
    b: "••••",
    c: "token ••••",
    "••••-key": 1,
    d: [`${"x".repeat(3990)}••••`],
  });
});

test("redact masks the URL's secrets with the headers', the longest first", () => {
  const headers = { "x-api-version": "v1", authorization: "Bearer sk-123456789" };
  expect(redact(["at v1_s3cret-url-token/x", "vsk-123456789"], headers, ["v1_s3cret-url-token", "v1_s3cret-url-token"])).toEqual(["at ••••/x", "v••••"]);
});
