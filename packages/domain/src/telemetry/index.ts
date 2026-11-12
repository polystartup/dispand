import {
  type Attributes,
  type Context,
  context,
  createContextKey,
  logs,
  type Meter,
  type MetricOptions,
  metrics,
  SeverityNumber,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
  isSpanContextValid,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { ExportResult } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, ConsoleLogRecordExporter, type LogRecordExporter, LoggerProvider, type ReadableLogRecord, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { createAllowListAttributesProcessor, MeterProvider, type MetricReader, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type ReadableSpan, SimpleSpanProcessor, type SpanExporter, type SpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { METRICS, type MetricName } from "./metrics.ts";
import { redactLogRecord, redactSpan } from "./redact.ts";

// Dispand's telemetry: the one module that knows OpenTelemetry's SDK. Every other module gets a
// tracer, a meter and a logger by name from here, and records errors with `recordError`.
// OTLP exporters exist only when the standard environment says where to send (`OTEL_EXPORTER_OTLP_*`);
// the providers run anyway, so tests read what would have been sent. Log records always also go
// to the process's output. Whatever is exported or printed first goes through `redact.ts`.

export { isOpenedSecret, rememberSecret } from "./redact.ts";
export type { Span } from "@opentelemetry/api";

const JOB = createContextKey("dispand.job");
const JOB_ID = "dispand.job.id";

/** Where telemetry goes: the OTLP exporters, or (tests) exporters given; `console` prints each log record. */
export type Exporters = { console?: boolean; spans?: SpanExporter; logs?: LogRecordExporter; metrics?: PushMetricExporter; metricIntervalMs?: number; simple?: boolean };

type Started = { traces: TracerProvider; logs: LoggerProvider; metrics: MeterProvider; contextManager: AsyncLocalStorageContextManager };
const STARTED = Symbol.for("dispand.telemetry");
const INSTRUMENTATIONS = Symbol.for("dispand.instrumentations");
type Global = typeof globalThis & { [STARTED]?: Started };

/** Wraps an exporter so nothing leaves without going through redaction. */
function redactedSpans(inner: SpanExporter): SpanExporter {
  return {
    export: (spans: ReadableSpan[], done: (result: ExportResult) => void) => inner.export(spans.map(redactSpan), done),
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}
function redactedLogs(inner: LogRecordExporter): LogRecordExporter {
  return {
    export: (records: ReadableLogRecord[], done: (result: ExportResult) => void) => inner.export(records.map(redactLogRecord), done),
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush(),
  };
}

/** Puts the Job id of the current context on every span started in it. */
const jobOnSpans: SpanProcessor = {
  onStart(span, parent) {
    const job = parent.getValue(JOB);
    if (typeof job === "string") span.setAttribute(JOB_ID, job);
  },
  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

const has = (env: NodeJS.ProcessEnv, ...names: string[]) => names.some((n) => !!env[n]);

/**
 * The console, and the OTLP exporters the environment asks for: none when it names no endpoint, or
 * when the SDK is disabled. Logs are printed even then: an install reads them in its output.
 */
export function exportersFromEnv(env: NodeJS.ProcessEnv = process.env): Exporters {
  if (env.OTEL_SDK_DISABLED === "true") return { console: true };
  const all = has(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  return {
    console: true,
    ...(all || has(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") ? { spans: new OTLPTraceExporter() } : {}),
    ...(all || has(env, "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") ? { logs: new OTLPLogExporter() } : {}),
    ...(all || has(env, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") ? { metrics: new OTLPMetricExporter() } : {}),
  };
}

/**
 * Starts telemetry once per process (a reload of the dev server finds it started). `exporters`:
 * where to send, from the environment by default. Returns false when it was already started.
 */
export function startTelemetry(exporters: Exporters = exportersFromEnv(), env: NodeJS.ProcessEnv = process.env): boolean {
  const g = globalThis as Global;
  if (g[STARTED]) return false;
  const resource = resourceFromAttributes({ "service.name": env.OTEL_SERVICE_NAME || "dispand" });
  // The SDK no longer reads its intervals from the environment: the standard variables are read here.
  const ms = (name: string) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const spanDelay = ms("OTEL_BSP_SCHEDULE_DELAY");
  const logDelay = ms("OTEL_BLRP_SCHEDULE_DELAY");
  const spanProcessor = (e: SpanExporter) =>
    exporters.simple ? new SimpleSpanProcessor({ exporter: redactedSpans(e) }) : new BatchSpanProcessor({ exporter: redactedSpans(e), ...(spanDelay ? { scheduledDelayMillis: spanDelay } : {}) });
  const logProcessor = (e: LogRecordExporter) =>
    exporters.simple ? new SimpleLogRecordProcessor({ exporter: redactedLogs(e) }) : new BatchLogRecordProcessor({ exporter: redactedLogs(e), ...(logDelay ? { scheduledDelayMillis: logDelay } : {}) });
  const readers: MetricReader[] = exporters.metrics
    ? [new PeriodicExportingMetricReader({ exporter: exporters.metrics, exportIntervalMillis: exporters.metricIntervalMs ?? ms("OTEL_METRIC_EXPORT_INTERVAL") ?? 60_000 })]
    : [];
  const started: Started = {
    contextManager: new AsyncLocalStorageContextManager().enable(),
    traces: new TracerProvider({ resource, spanProcessors: [jobOnSpans, ...(exporters.spans ? [spanProcessor(exporters.spans)] : [])] }),
    // Printed as each record is emitted, so a crash still shows the last one.
    logs: new LoggerProvider({
      resource,
      processors: [
        ...(exporters.console ? [new SimpleLogRecordProcessor({ exporter: redactedLogs(new ConsoleLogRecordExporter()) })] : []),
        ...(exporters.logs ? [logProcessor(exporters.logs)] : []),
      ],
    }),
    // Each instrument keeps only the attributes it lists: a stray one is dropped here.
    metrics: new MeterProvider({
      resource,
      readers,
      views: Object.entries(METRICS).map(([instrumentName, keys]) => ({ instrumentName, attributesProcessors: [createAllowListAttributesProcessor([...keys])] })),
    }),
  };
  context.setGlobalContextManager(started.contextManager);
  trace.setGlobalTracerProvider(started.traces);
  logs.setGlobalLoggerProvider(started.logs);
  metrics.setGlobalMeterProvider(started.metrics);
  // The preload's instrumentations (HTTP, PostgreSQL, fetch) started before any provider: their
  // metrics go to the real one from now on.
  for (const instrumentation of (g as { [INSTRUMENTATIONS]?: { setMeterProvider(p: MeterProvider): void }[] })[INSTRUMENTATIONS] ?? []) instrumentation.setMeterProvider(started.metrics);
  g[STARTED] = started;
  return true;
}

/** Sends what is buffered and stops (on shutdown, and between tests). */
export async function stopTelemetry(): Promise<void> {
  const g = globalThis as Global;
  const started = g[STARTED];
  if (!started) return;
  delete g[STARTED];
  await Promise.allSettled([started.traces.shutdown(), started.logs.shutdown(), started.metrics.shutdown()]);
  trace.disable();
  logs.disable();
  metrics.disable();
  context.disable();
}

/** Sends what is buffered, without stopping. */
export async function flushTelemetry(): Promise<void> {
  const started = (globalThis as Global)[STARTED];
  if (started) await Promise.allSettled([started.traces.forceFlush(), started.logs.forceFlush(), started.metrics.forceFlush()]);
}

/**
 * A tracer that asks for the current provider at each span: modules take theirs when they load,
 * before telemetry starts (and tests start it again), so one taken once would stay a no-op.
 */
export function tracer(name: string): Tracer {
  const current = () => trace.getTracer(`dispand.${name}`);
  return {
    startSpan: (...args: Parameters<Tracer["startSpan"]>) => current().startSpan(...args),
    startActiveSpan: ((...args: unknown[]) => (current().startActiveSpan as (...a: unknown[]) => unknown)(...args)) as Tracer["startActiveSpan"],
  };
}

/** Metric instruments, looked up in the current provider at each use, for the same reason. Their names are those of `metrics.ts`. */
export function meter(name: string) {
  const current = (): Meter => metrics.getMeter(`dispand.${name}`);
  return {
    counter: (instrument: MetricName, options?: MetricOptions) => ({ add: (value: number, attributes?: Attributes) => current().createCounter(instrument, options).add(value, attributes) }),
    histogram: (instrument: MetricName, options?: MetricOptions) => ({ record: (value: number, attributes?: Attributes) => current().createHistogram(instrument, options).record(value, attributes) }),
    gauge: (instrument: MetricName, options?: MetricOptions) => ({ record: (value: number, attributes?: Attributes) => current().createGauge(instrument, options).record(value, attributes) }),
  };
}

/** Runs `fn` for a Job: spans started and records logged inside carry its id. */
export function withJob<T>(jobId: string, fn: () => T): T {
  return context.with(context.active().setValue(JOB, jobId), fn);
}

/** The id of the trace running now, to store with what it creates (a Job); none outside a span. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan()?.spanContext();
  return span && isSpanContextValid(span) ? span.traceId : undefined;
}

/** Attributes for the span running now, if any (an owner id once it is known, a count). */
export function annotate(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** An event on the span running now, if any: ids, names and kinds only. */
export function spanEvent(name: string, attributes: Attributes): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
}

/**
 * Marks a span failed with the error's kind only. Never `span.recordException`: it records the
 * message and the stack, which can quote a statement's parameters or a token.
 */
export function recordError(span: Span, kind: string): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.addEvent("exception", { "exception.type": kind });
}

/** Runs `fn` in a span named `name`; a throw marks it failed with `kindOf(err)` and goes on. */
export async function inSpan<T>(t: Tracer, name: string, attributes: Attributes, kindOf: (err: unknown) => string, fn: (span: Span) => Promise<T>): Promise<T> {
  return t.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      recordError(span, kindOf(err));
      throw err;
    } finally {
      span.end();
    }
  });
}

/** A log record for `event`, with the current span's ids (and Job's) and `attributes`. Never the error's text. */
export function emitLog(name: string, severity: "error" | "warn" | "info", event: string, attributes: Attributes, active: Context = context.active()): void {
  const job = active.getValue(JOB);
  logs.getLogger(`dispand.${name}`).emit({
    severityNumber: severity === "error" ? SeverityNumber.ERROR : severity === "warn" ? SeverityNumber.WARN : SeverityNumber.INFO,
    severityText: severity.toUpperCase(),
    body: event,
    attributes: { ...attributes, ...(typeof job === "string" ? { [JOB_ID]: job } : {}) },
    context: active,
  });
}
