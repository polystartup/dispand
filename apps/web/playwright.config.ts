import { defineConfig } from "@playwright/test";
import { authFile } from "./e2e/auth-file.ts";

/** Where the app sends its telemetry during the tests: `e2e/collector.mjs`, which zzz-telemetry.spec.ts reads. */
const COLLECTOR = "http://127.0.0.1:3199";
// Never reuse a server already on a port: the specs need fresh databases (custom-setup and
// assistant a first launch), and a server another checkout left there runs other code. A taken
// port fails the run at once, with Playwright saying which port is already used.
const reuseExistingServer = false;

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
  reuseExistingServer,
});

/** Matches the spec files with these names exactly (`pages` is not `yy-pages`). */
const specs = (...names: string[]) => new RegExp(`/(${names.join("|")})\\.spec\\.ts$`);
/** The specs of "main-2" to "main-4", besides the ones every chain runs. */
const CHAINS = [
  ["skills", "tools", "widgets"],
  ["workflows", "y-journey", "yx-memory"],
  ["yx-memory-pages", "yy-data-steps", "yy-pages", "yz-assistant", "yz-axe"],
];

/** The projects of the specs that share an app and its owner: "main-1" takes every spec the others don't name. */
const main = [
  { name: "main-1", testIgnore: specs("custom-setup", "assistant", ...CHAINS.flat()), port: 3100 },
  ...CHAINS.map((chain, i) => ({
    name: `main-${i + 2}`,
    testMatch: specs("auth", "settings", ...chain, "yz-audit", "zzz-telemetry"),
    port: 3103 + i,
  })),
];

const projects = [
  // Each "main-N" first runs its setup on the fresh app (auth.setup.ts: the owner, signed in), then
  // its specs start as that owner, with the cookies the setup saved.
  ...main.flatMap(({ name, port, ...match }) => [
    { name: `setup-${name}`, testMatch: /auth\.setup\.ts$/, use: { baseURL: `http://localhost:${port}` } },
    { name, ...match, dependencies: [`setup-${name}`], use: { baseURL: `http://localhost:${port}`, storageState: authFile(name) } },
  ]),
  { name: "custom-setup", testMatch: specs("custom-setup"), use: { baseURL: "http://localhost:3101" } },
  { name: "assistant", testMatch: specs("assistant"), use: { baseURL: "http://localhost:3102" } },
];

export default defineConfig({
  testDir: "./e2e",
  // Removes the cookies the setup projects saved.
  globalTeardown: "./e2e/global-teardown.ts",
  // Required: more workers would share an app, its owner and its data (and zz-questions.spec.ts
  // and zzz-telemetry.spec.ts must stay last in their chain).
  workers: 1,
  // A failed test keeps its trace in test-results/: a flake leaves more than its call log.
  // E2E_BROWSER runs the specs in another of Playwright's browsers: the artifact frame's isolation
  // is checked in "firefox" and "webkit" too (docs/security/browser.md).
  use: { trace: "retain-on-failure", browserName: (process.env.E2E_BROWSER ?? "chromium") as "chromium" | "firefox" | "webkit" },
  // "main-1" to "main-4": the chains of specs that share one app and one owner, run in file order,
  // each on its own server and database so CI runs them in parallel. Each starts with its setup
  // (auth.setup.ts: the owner), then auth.spec.ts and settings.spec.ts, and ends with yz-audit.spec.ts
  // and zzz-telemetry.spec.ts, which check that nothing its chain did leaked into telemetry or Audit.
  // A spec makes what it needs (an agent, Stem) with e2e/fixtures.ts, so it passes alone, and asserts
  // only on what it made (a list is never asserted empty: the unit tests do that). What still holds the
  // order is auth.spec.ts, which needs a first launch (it comes first), and zzz-telemetry, which reads
  // the whole chain's telemetry. "main-1" takes
  // every spec the others don't name, so a new spec always runs. "custom-setup" and "assistant" (the
  // day-one acceptance) need an app with nothing set up (first launch: no harness, no Assistant).
  projects,
  webServer: [
    { command: "node e2e/collector.mjs", url: `${COLLECTOR}/health`, reuseExistingServer },
    // CI runs one project per job (E2E_PROJECT) and starts only its app; a local run starts them all.
    ...projects
      .filter((p) => !p.name.startsWith("setup-") && (!process.env.E2E_PROJECT || p.name === process.env.E2E_PROJECT))
      .map((p) => server(Number(new URL(p.use.baseURL).port))),
  ],
});
