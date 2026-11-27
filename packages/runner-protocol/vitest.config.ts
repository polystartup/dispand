import { defineConfig } from "vitest/config";

// Coverage: measured on CI's unit-test jobs and printed in their logs, with no threshold yet. Not on
// the PostgreSQL jobs, which run the same code again. `include` counts the files no test loads too.
export default defineConfig({
  test: {
    coverage: {
      enabled: Boolean(process.env.CI) && !process.env.DISPAND_TEST_DATABASE_URL,
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
