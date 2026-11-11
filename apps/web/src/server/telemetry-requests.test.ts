import { expect, test } from "vitest";
import { ignoredIncoming, ignoredOutgoing } from "../../telemetry-requests.mjs";

test("pairing, the runner socket, OAuth callbacks, health and the dev server's own files make no span", () => {
  for (const url of ["/runner/pair", "/runner/pair?code=x", "/runner/ws", "/oauth/callback?code=x&state=y", "/api/health", "/@vite/client", "/node_modules/.vite/x.js"]) {
    expect(ignoredIncoming(url)).toBe(true);
  }
  for (const url of ["/", "/inbox", "/api/rpc/rows/get", "/runner/install.sh", "/files/att_1", "/api/healthz"]) {
    expect(ignoredIncoming(url)).toBe(false);
  }
});

test("telemetry's own exports to the collector make no span; other calls out do", () => {
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example.com/v1/traces" };
  expect(ignoredOutgoing("collector", 4318, env)).toBe(true);
  expect(ignoredOutgoing("traces.example.com", 443, env)).toBe(true);
  expect(ignoredOutgoing("collector", 4319, env)).toBe(false);
  expect(ignoredOutgoing("tools.example.com", 443, env)).toBe(false);
  expect(ignoredOutgoing("collector", 4318, {})).toBe(false);
});
