import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { cpSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { runnerHub } from "./vite-plugin-hub.ts";

// The bundled server cannot find the domain's migrations by its source path: ship a copy.
const copyMigrations: Plugin = {
  name: "copy-migrations",
  apply: "build",
  applyToEnvironment: (environment) => environment.name === "ssr",
  closeBundle() {
    cpSync("../../packages/domain/drizzle", "dist/server/drizzle", { recursive: true });
  },
};

export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  // PGlite loads its wasm and data files next to its own code: keep it out of the bundle.
  ssr: { external: ["@electric-sql/pglite"] },
  plugins: [tailwindcss(), tanstackStart(), viteReact(), copyMigrations, runnerHub()],
});
