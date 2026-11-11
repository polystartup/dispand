import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { expect, test } from "vitest";
import { redactAttributes, redactLogRecord, redactSpan, rememberSecret } from "./redact.ts";

const TOKEN = "dj_sentinel-job-token-0123456789";

test("attributes that name a secret, or hold a header, are dropped; ids, names and counts stay", () => {
  const out = redactAttributes({
    authorization: "Bearer x",
    "http.request.header.authorization": ["Bearer x"],
    "http.response.header.set-cookie": ["s=1"],
    "oauth.code": "abc",
    "oauth.state": "xyz",
    "tool.api_key": "k",
    "user.password": "p",
    "dispand.job.id": "run_1",
    "rpc.method": "rows.create",
    "http.response.status_code": 200,
    "db.rows": 3,
  });
  expect(out).toEqual({ "dispand.job.id": "run_1", "rpc.method": "rows.create", "http.response.status_code": 200, "db.rows": 3 });
});

test("a URL keeps its path, never its query string or credentials", () => {
  const out = redactAttributes({
    "url.full": "https://user:pass@tools.example.com:8443/mcp/x?key=s3cret#frag",
    "http.url": "https://tools.example.com/mcp?token=abc",
    "http.target": "/oauth/callback?code=abc&state=xyz",
    "url.query": "key=s3cret",
    "url.path": "/mcp/x",
    "url.original": "not a url ?x=1",
  });
  expect(out).toEqual({ "url.full": "https://tools.example.com:8443/mcp/x", "http.url": "https://tools.example.com/mcp", "http.target": "/oauth/callback", "url.path": "/mcp/x", "url.original": "not a url " });
});

test("a value equal to a secret the process opened is dropped, whatever its key", () => {
  rememberSecret(TOKEN);
  expect(redactAttributes({ "some.id": TOKEN, list: ["a", TOKEN], other: "a" })).toEqual({ list: ["a"], other: "a" });
  // Short values are never taken for a secret (a two-letter header would empty every span).
  rememberSecret("ab");
  expect(redactAttributes({ x: "ab" })).toEqual({ x: "ab" });
});

const span = (extra: Record<string, unknown> = {}) =>
  ({
    name: "rows.create",
    kind: SpanKind.INTERNAL,
    spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: TraceFlags.SAMPLED }),
    startTime: [0, 0],
    endTime: [0, 1],
    duration: [0, 1],
    ended: true,
    status: { code: SpanStatusCode.ERROR, message: `token ${TOKEN} refused` },
    attributes: { "rpc.method": "rows.create", authorization: "x" },
    links: [],
    events: [
      { name: "exception", time: [0, 0], attributes: { "exception.type": "ORPCError", "exception.message": `bad ${TOKEN}`, "exception.stacktrace": "at x" } },
      { name: "note", time: [0, 0], attributes: { "url.full": "https://x.example/?q=1" } },
    ],
    resource: {},
    instrumentationScope: { name: "t" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...extra,
  }) as never;

test("a span keeps its error's kind, never its message or stack, from any instrumentation", () => {
  const out = redactSpan(span());
  expect(out.status).toEqual({ code: SpanStatusCode.ERROR });
  expect(out.attributes).toEqual({ "rpc.method": "rows.create" });
  expect(out.events).toEqual([
    { name: "exception", time: [0, 0], attributes: { "exception.type": "ORPCError" } },
    { name: "note", time: [0, 0], attributes: { "url.full": "https://x.example/" } },
  ]);
  // What identifies the span is kept as it was.
  expect(out.spanContext().spanId).toBe("b".repeat(16));
  expect(out.name).toBe("rows.create");
});

test("a log record's attributes are redacted, and a body equal to a secret is dropped", () => {
  rememberSecret(TOKEN);
  const record = { hrTime: [0, 0], hrTimeObserved: [0, 0], body: TOKEN, attributes: { cookie: "s", ref: "run_1" }, resource: {}, instrumentationScope: { name: "t" }, droppedAttributesCount: 0 } as never;
  const out = redactLogRecord(record);
  expect(out.body).toBeUndefined();
  expect(out.attributes).toEqual({ ref: "run_1" });
});

test("redaction never throws, whatever it is given", () => {
  expect(() => redactAttributes({ "url.full": 3 as never, x: null as never, y: undefined })).not.toThrow();
  expect(() => redactSpan(span({ events: undefined, attributes: undefined, status: undefined }))).not.toThrow();
});
