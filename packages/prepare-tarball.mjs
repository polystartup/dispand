import { cpSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { argv } from "node:process";

// pnpm runs prepack in the package directory. Repacking must drop obsolete output,
// including skill files removed since the last build.
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
cpSync("../../NOTICE", "dist/NOTICE");
for (const asset of argv.slice(2)) {
  cpSync(join("src", asset), join("dist", asset), {
    recursive: true,
    filter: (path) => !basename(path).startsWith("."),
  });
}
