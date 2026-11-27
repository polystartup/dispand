import { defineConfig } from "vitest/config";

// The real-hub tests open a PGlite database and hash a password, and other tests spawn the CLI
// entry point or install.sh: seconds each when files run in parallel on a busy machine.
// Coverage: measured on CI's unit-test jobs and printed in their logs, with no threshold yet. Not on
// the PostgreSQL jobs, which run the same code again. `include` counts the files no test loads too.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    setupFiles: ["@dispand/domain/test-wait"],
    coverage: {
      enabled: Boolean(process.env.CI) && !process.env.DISPAND_TEST_DATABASE_URL,
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
