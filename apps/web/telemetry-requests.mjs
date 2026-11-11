// Which requests the HTTP instrumentation leaves out (`telemetry-preload.mjs`). Kept apart so a
// test can read it without starting the instrumentation.

/** Paths whose requests make no span: a credential in their URL or body, an upgrade that may never end, or noise. */
const IGNORED = [/^\/runner\/pair(\/|$)/, /^\/runner\/ws(\/|$)/, /^\/oauth\/callback(\/|$)/, /^\/api\/health$/, /^\/@/, /^\/node_modules\//, /^\/__vite/];

/** Whether an incoming request (`url`: its path and query) is left out. */
export function ignoredIncoming(url) {
  const path = String(url ?? "").split("?", 1)[0];
  return IGNORED.some((re) => re.test(path));
}

/**
 * Whether an outgoing request is left out: telemetry's own exports to the collector (the
 * endpoints `OTEL_EXPORTER_OTLP_*` name), so sending spans makes no spans.
 */
export function ignoredOutgoing(host, port, env = process.env) {
  const endpoints = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]
    .map((name) => URL.parse(env[name] ?? ""))
    .filter((u) => u !== null);
  return endpoints.some((u) => u.hostname === host && String(u.port || (u.protocol === "https:" ? 443 : 80)) === String(port ?? ""));
}
