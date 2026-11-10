import { defineConfig } from "vitest/config";

// The real-hub tests open a PGlite database and hash a password, and other tests spawn the CLI
// entry point or install.sh: seconds each when files run in parallel on a busy machine.
export default defineConfig({ test: { testTimeout: 30_000 } });
