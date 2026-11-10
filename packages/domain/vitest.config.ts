import { defineConfig } from "vitest/config";

// Each worker boots one PGlite database, which its tests share (`runners/test-support.ts`), and
// `isolate: false` keeps it across the worker's files. The worker's first test waits for that boot:
// seconds when every worker boots at once, past the 5 s default.
// `--expose-gc` lets the hub's memory test measure what is retained, not what is merely uncollected.
export default defineConfig({ test: { testTimeout: 30_000, isolate: false, execArgv: ["--expose-gc"] } });
