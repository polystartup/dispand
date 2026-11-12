import { defineConfig } from "@playwright/test";

/** Where the app sends its telemetry during the tests: `e2e/collector.mjs`, which zzz-telemetry.spec.ts reads. */
const COLLECTOR = "http://127.0.0.1:3199";

const server = (port: number) => ({
  command: `pnpm exec vite dev --port ${port} --strictPort`,
  url: `http://localhost:${port}`,
  env: {
    DATABASE_URL: "pglite://memory",
    BETTER_AUTH_URL: `http://localhost:${port}`,
    DISPAND_GIT_FILE_URLS: "1",
    // Instrumented as in production, and exporting often.
    NODE_OPTIONS: "--import ./telemetry-preload.mjs",
    OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR,
    OTEL_BSP_SCHEDULE_DELAY: "200",
    OTEL_BLRP_SCHEDULE_DELAY: "200",
    OTEL_METRIC_EXPORT_INTERVAL: "1000",
  },
  reuseExistingServer: !process.env.CI,
});

export default defineConfig({
  testDir: "./e2e",
  // Required: more workers would share the app, its owner and its data (and zz-questions.spec.ts
  // and zzz-telemetry.spec.ts must stay last in "main").
  workers: 1,
  // "main": one app and one owner for every spec, run in file order. "custom-setup" needs an app
  // with nothing set up (first launch: no harness and no Assistant yet), so it has its own
  // server and database.
  projects: [
    { name: "main", testIgnore: /custom-setup\.spec\.ts/, use: { baseURL: "http://localhost:3100" } },
    { name: "custom-setup", testMatch: /custom-setup\.spec\.ts/, use: { baseURL: "http://localhost:3101" } },
  ],
  webServer: [{ command: "node e2e/collector.mjs", url: `${COLLECTOR}/health`, reuseExistingServer: !process.env.CI }, server(3100), server(3101)],
});
