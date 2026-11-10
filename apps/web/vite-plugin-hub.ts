import { isRunnerUpgrade, upgradeRunner } from "@dispand/domain/upgrade";
import type { Plugin } from "vite";

/** In dev, hands `/runner/ws` upgrades on Vite's server to the same hub the app uses. */
export function runnerHub(): Plugin {
  return {
    name: "dispand-runner-hub",
    apply: "serve",
    configureServer(server) {
      // Other upgrades (Vite's HMR) are Vite's. The hub is loaded through Vite's SSR module graph,
      // so it is the one `getApp()` gives the routes.
      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (isRunnerUpgrade(req))
          upgradeRunner(req, socket, head, async () => {
            const app = (await server.ssrLoadModule("/src/server/app.ts")) as typeof import("./src/server/app.ts");
            return (await app.getApp()).hub;
          });
      });
    },
  };
}
