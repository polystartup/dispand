import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { flushTelemetry, startTelemetry, stopTelemetry } from "./index.ts";

/**
 * Tests: telemetry started with in-memory exporters (behind redaction, like the real ones), and
 * what was exported so far. `stop` at the end of the test.
 */
export async function captureTelemetry() {
  await stopTelemetry();
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  startTelemetry({ spans, logs, metrics, simple: true, metricIntervalMs: 60_000 });
  return {
    spans: () => spans.getFinishedSpans(),
    logs: () => logs.getFinishedLogRecords(),
    /** Every data point exported so far, by instrument, with its attributes. */
    metrics: async () => {
      await flushTelemetry();
      return metrics.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics.flatMap((m) => m.dataPoints.map((p) => ({ name: m.descriptor.name, attributes: p.attributes })))));
    },
    /** Everything exported, as text: to check a sentinel never appears. */
    all: async () => {
      await flushTelemetry();
      return JSON.stringify([spans.getFinishedSpans().map((s) => [s.name, s.attributes, s.events, s.status]), logs.getFinishedLogRecords().map((r) => [r.body, r.attributes]), metrics.getMetrics()]);
    },
    stop: stopTelemetry,
  };
}
