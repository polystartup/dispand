import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { cpSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { runnerHub } from "./vite-plugin-hub.ts";

// Ship domain files in the locations the bundled server resolves at runtime.
const copyDomainFiles: Plugin = {
  name: "copy-domain-files",
  apply: "build",
  applyToEnvironment: (environment) => environment.name === "ssr",
  closeBundle() {
    cpSync("../../packages/domain/src/assistant/skill", "dist/server/assets/skill", { recursive: true });
    cpSync("../../packages/domain/drizzle", "dist/server/drizzle", { recursive: true });
  },
};

export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  // PGlite loads its wasm and data files next to its own code: keep it out of the bundle. The
  // PostgreSQL driver too: its telemetry hooks it as it loads (`telemetry-preload.mjs`), which a
  // bundled copy never does. pdf.js loads its worker module next to its own code too.
  ssr: { external: ["@electric-sql/pglite", "pg", "pdfjs-dist"] },
  plugins: [tailwindcss(), tanstackStart(), viteReact(), copyDomainFiles, runnerHub()],
});
