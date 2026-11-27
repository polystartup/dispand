import { defineConfig } from "vitest/config";
import { testTags } from "./src/runners/test-tags.ts";

// Each worker boots one PGlite database, which its tests share (`runners/test-support.ts`), and
// `isolate: false` keeps it across the worker's files. The worker's first test waits for that boot:
// seconds when every worker boots at once, past the 5 s default.
// `--expose-gc` lets the hub's memory test measure what is retained, not what is merely uncollected.
// On a PostgreSQL server, the tests tagged in `testTags` are skipped; `test-setup.ts` checks the tags.
// Coverage: measured on CI's unit-test jobs and printed in their logs, with no threshold yet. Not on
// the PostgreSQL jobs, which run the same code again. `include` counts the files no test loads too.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    isolate: false,
    execArgv: ["--expose-gc"],
    tags: testTags,
    setupFiles: ["./src/runners/test-setup.ts", "./src/runners/test-wait.ts"],
    coverage: {
      enabled: Boolean(process.env.CI) && !process.env.DISPAND_TEST_DATABASE_URL,
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
