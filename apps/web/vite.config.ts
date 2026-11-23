import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { runnerHub } from "./vite-plugin-hub.ts";

export default defineConfig(({ command }) => ({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  // PGlite loads its wasm and data files next to its own code: keep it out of the bundle. The
  // PostgreSQL driver too: its telemetry hooks it as it loads (`telemetry-preload.mjs`), which a
  // bundled copy never does. pdf.js loads its worker module next to its own code too.
  ssr: { external: ["@electric-sql/pglite", "pg", "pdfjs-dist"] },
  // The built server imports the domain package instead of a copy of it, so another entry that
  // imports both (`openDb` next to `buildApp`) gets one domain module, and the domain finds its own
  // migrations and skill files. Its message catalogs are data: inlined. (`ssr.external` would skip
  // the workspace's subpaths, which resolve to `.ts` sources.)
  ...(command === "build" && { environments: { ssr: { build: { rolldownOptions: { external: [/^@dispand\/domain(\/(?!.*\.json$)|$)/] } } } } }),
  plugins: [tailwindcss(), tanstackStart(), viteReact(), runnerHub()],
}));
