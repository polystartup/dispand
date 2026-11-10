import { defineConfig } from "@playwright/test";

const server = (port: number) => ({
  command: `pnpm exec vite dev --port ${port} --strictPort`,
  url: `http://localhost:${port}`,
  env: { DATABASE_URL: "pglite://memory", BETTER_AUTH_URL: `http://localhost:${port}`, DISPAND_GIT_FILE_URLS: "1" },
  reuseExistingServer: !process.env.CI,
});

export default defineConfig({
  testDir: "./e2e",
  // Required: more workers would share the app, its owner and its data (and zz-questions.spec.ts
  // must stay last in "main").
  workers: 1,
  // "main": one app and one owner for every spec, run in file order. "custom-setup" needs an app
  // with nothing set up (the first-launch Home is only there before an agent and a workflow
  // exist), so it has its own server and database.
  projects: [
    { name: "main", testIgnore: /custom-setup\.spec\.ts/, use: { baseURL: "http://localhost:3100" } },
    { name: "custom-setup", testMatch: /custom-setup\.spec\.ts/, use: { baseURL: "http://localhost:3101" } },
  ],
  webServer: [server(3100), server(3101)],
});
