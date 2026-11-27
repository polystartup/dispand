import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Each server test file boots one PGlite database, which its tests share
// (`@dispand/domain/test-support`); its first test waits for that boot, seconds on a busy
// machine. Files stay isolated, unlike in packages/domain: the component tests mock `lib/api.ts`
// per file, and a component another file of the worker already loaded (WorkflowFormWidget loads
// ChatPanel) would keep that file's mock.
// Coverage: measured on CI's unit-test jobs and printed in their logs, with no threshold yet. Not on
// the PostgreSQL jobs, which run the same code again. `include` counts the files no test loads too.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    setupFiles: ["src/test/i18n.ts", "src/test/testing-library.ts", "@dispand/domain/test-wait"],
    testTimeout: 30_000,
    coverage: {
      enabled: Boolean(process.env.CI) && !process.env.DISPAND_TEST_DATABASE_URL,
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.{ts,tsx}"],
    },
    projects: [
      { extends: true, test: { name: "web", include: ["src/**/*.test.{ts,tsx}"], exclude: ["src/**/*.shell.test.{ts,tsx}"] } },
      // The app built with the fixture shell: an alias, so the setup's catalogs have its messages too.
      {
        extends: true,
        resolve: { alias: { "#web-shell": fileURLToPath(new URL("src/shell/fixture.tsx", import.meta.url)) } },
        test: { name: "shell", include: ["src/**/*.shell.test.{ts,tsx}"] },
      },
    ],
  },
});
