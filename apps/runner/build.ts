// Bundles the runner into `dist/dispand-runner.tgz` (`dispand-runner/main.mjs`, run with
// `node`, and the systemd user unit), then puts it with `install/install.sh` into the web app's
// static files, so the server serves `/runner/install.sh` and `/runner/dispand-runner.tgz`.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
// Identity of the actual code and installer, including dependency changes between releases.
const files = ["dist/dispand-runner/main.mjs", "install/install.sh", "install/dispand-runner.service"];
const hash = createHash("sha256");
for (const file of files) hash.update(readFileSync(file));
const buildId = hash.digest("hex");
writeFileSync("dist/dispand-runner/build.json", JSON.stringify({ buildId }));
copyFileSync("install/dispand-runner.service", "dist/dispand-runner/dispand-runner.service");
execFileSync("tar", ["-czf", "dist/dispand-runner.tgz", "-C", "dist", "dispand-runner"]);

const web = "../web/public/runner";
mkdirSync(web, { recursive: true });
copyFileSync("dist/dispand-runner.tgz", `${web}/dispand-runner.tgz`);
copyFileSync("install/install.sh", `${web}/install.sh`);

copyFileSync("dist/dispand-runner/build.json", `${web}/build.json`);
