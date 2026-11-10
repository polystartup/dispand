// Bundles the runner into `dist/dispand-runner.tgz` (`dispand-runner/main.mjs`, run with
// `node`, and the systemd user unit), then puts it with `install/install.sh` into the web app's
// static files, so the server serves `/runner/install.sh` and `/runner/dispand-runner.tgz`.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/dispand-runner/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Bundled CommonJS code calls `require`, which ES modules don't have.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "warning",
});
copyFileSync("install/dispand-runner.service", "dist/dispand-runner/dispand-runner.service");
execFileSync("tar", ["-czf", "dist/dispand-runner.tgz", "-C", "dist", "dispand-runner"]);

const web = "../web/public/runner";
mkdirSync(web, { recursive: true });
copyFileSync("dist/dispand-runner.tgz", `${web}/dispand-runner.tgz`);
copyFileSync("install/install.sh", `${web}/install.sh`);
