import { defineConfig } from "vitest/config";

// Each server test file boots one PGlite database, which its tests share
// (`@dispand/domain/test-support`); its first test waits for that boot, seconds on a busy
// machine. Files stay isolated, unlike in packages/domain: the component tests mock `lib/api.ts`
// per file, and a component another file of the worker already loaded (WorkflowFormWidget loads
// ChatPanel) would keep that file's mock.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { include: ["src/**/*.test.{ts,tsx}"], testTimeout: 30_000 },
});
