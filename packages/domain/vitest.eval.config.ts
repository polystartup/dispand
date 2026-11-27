import { defineConfig } from "vitest/config";
import { testTags } from "./src/runners/test-tags.ts";

// The behaviour evals (`src/evals/`, `pnpm eval`): a real model, one case at a time, never in `pnpm test`
// or CI, whose default config matches no `.eval.ts` file. Each case waits on the model, so a test may take minutes.
export default defineConfig({
  test: {
    include: ["src/evals/**/*.eval.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    tags: testTags,
    setupFiles: ["./src/runners/test-setup.ts", "./src/runners/test-wait.ts"],
  },
});
