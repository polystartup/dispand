import { afterEach, expect, test } from "vitest";
import { annotate, emitLog, exportersFromEnv, inSpan, meter, rememberSecret, startTelemetry, stopTelemetry, tracer, withJob } from "./index.ts";
import { captureTelemetry } from "./testing.ts";

afterEach(() => stopTelemetry());

test("nothing is exported, and no exporter made, unless the environment names an endpoint", () => {
  expect(exportersFromEnv({})).toEqual({});
  expect(Object.keys(exportersFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).sort()).toEqual(["logs", "metrics", "spans"]);
  expect(Object.keys(exportersFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces" }))).toEqual(["spans"]);
  expect(exportersFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_SDK_DISABLED: "true" })).toEqual({});
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
