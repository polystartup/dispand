import { afterEach, expect, test, vi } from "vitest";
import { annotate, currentTraceId, emitLog, exportersFromEnv, inJobTrace, inSpan, meter, rememberSecret, startTelemetry, stopTelemetry, tracer, withJob } from "./index.ts";
import { captureTelemetry } from "./testing.ts";

afterEach(() => stopTelemetry());

test("nothing is exported, and no exporter made, unless the environment names an endpoint; logs are always printed", () => {
  expect(exportersFromEnv({})).toEqual({ console: true });
  expect(Object.keys(exportersFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).sort()).toEqual(["console", "logs", "metrics", "spans"]);
  expect(Object.keys(exportersFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces" })).sort()).toEqual(["console", "spans"]);
  expect(exportersFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_SDK_DISABLED: "true" })).toEqual({ console: true });
});

test("without a collector, a log record is printed once, redacted like an exported one", () => {
  startTelemetry(exportersFromEnv({}));
  const dir = vi.spyOn(console, "dir").mockImplementation(() => {});
  const token = "dj_sentinel-token-for-the-console";
  rememberSecret(token);
  emitLog("test", "info", "work done", { ref: "row_1", leaked: token, authorization: "Bearer x" });
  emitLog("test", "info", token, {});
  const calls = [...dir.mock.calls];
  dir.mockRestore();
  expect(calls.map(([r]) => [(r as { body: unknown }).body, (r as { attributes: unknown }).attributes])).toEqual([
    ["work done", { ref: "row_1" }],
    [undefined, {}],
  ]);
  expect(JSON.stringify(calls)).not.toContain(token);
});

test("started twice in one process (a dev reload), it keeps the first", async () => {
  expect(startTelemetry({})).toBe(true);
  expect(startTelemetry({})).toBe(false);
});

test("a span records an error by its kind only, and spans and logs inside a Job carry its id", async () => {
  const t = await captureTelemetry();
  const token = "dj_sentinel-token-for-the-test";
  rememberSecret(token);
  await withJob("run_1", () =>
    inSpan(tracer("test"), "work", { "dispand.thing": "x" }, () => "ORPCError", async () => {
      annotate({ "dispand.owner.id": "user_1", leaked: token });
      emitLog("test", "error", "work failed", { ref: "row_1" });
      throw new Error(`refused ${token}`);
    }),
  ).catch(() => {});
  const [span] = t.spans();
  expect(span!.name).toBe("work");
  expect(span!.attributes).toEqual({ "dispand.thing": "x", "dispand.job.id": "run_1", "dispand.owner.id": "user_1" });
  expect(span!.events.map((e) => [e.name, e.attributes])).toEqual([["exception", { "exception.type": "ORPCError" }]]);
  const [record] = t.logs();
  expect(record!.body).toBe("work failed");
  expect(record!.attributes).toEqual({ ref: "row_1", "dispand.job.id": "run_1" });
  expect(record!.spanContext?.traceId).toBe(span!.spanContext().traceId);
  expect(await t.all()).not.toContain(token);
});

test("a metric keeps only the attributes its instrument lists", async () => {
  const t = await captureTelemetry();
  meter("test").histogram("dispand.rpc.duration").record(12, { "rpc.method": "rows.create", "dispand.result": "ok", "dispand.row.value": "Ada Lovelace" });
  expect(await t.metrics()).toEqual([{ name: "dispand.rpc.duration", attributes: { "rpc.method": "rows.create", "dispand.result": "ok" } }]);
});

test("a tracer or an instrument taken before telemetry starts (when modules load) works once it has", async () => {
  const early = tracer("early");
  const histogram = meter("early").histogram("dispand.rpc.duration");
  const t = await captureTelemetry();
  early.startSpan("late").end();
  histogram.record(1, { "rpc.method": "x", "dispand.result": "ok" });
  expect(t.spans().map((s) => s.name)).toEqual(["late"]);
  expect((await t.metrics()).map((m) => m.name)).toEqual(["dispand.rpc.duration"]);
});

test("in a Job's trace, a span is a child of the Job's stored span and links the caller's; a run without one is left as it is", async () => {
  const t = await captureTelemetry();
  const job = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" };
  let seen: string | undefined;
  tracer("test").startActiveSpan("caller", (caller) => {
    inJobTrace(job, () => {
      seen = currentTraceId();
      tracer("test").startActiveSpan("work", (work) => {
        tracer("test").startSpan("inner").end();
        work.end();
      });
    });
    inJobTrace({ traceId: null, spanId: null }, () => tracer("test").startSpan("workflow").end());
    caller.end();
  });
  const byName = Object.fromEntries(t.spans().map((s) => [s.name, s]));
  const caller = byName.caller!.spanContext();
  expect(seen).toBe(job.traceId);
  expect(byName.work!.spanContext().traceId).toBe(job.traceId);
  expect(byName.work!.parentSpanContext?.spanId).toBe(job.spanId);
  expect(byName.work!.links.map((l) => [l.context.traceId, l.context.spanId])).toEqual([[caller.traceId, caller.spanId]]);
  // Only the spans started right under the Job's link the caller.
  expect(byName.inner!.spanContext().traceId).toBe(job.traceId);
  expect(byName.inner!.links).toEqual([]);
  expect(byName.workflow!.spanContext().traceId).toBe(caller.traceId);
  expect(byName.workflow!.links).toEqual([]);
});
