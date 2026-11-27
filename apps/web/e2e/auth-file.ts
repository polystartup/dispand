import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One private directory per run (mode 0700), outside the app, which the dev server would serve. The
// config makes it first; the workers it starts get its path through the environment.
const dir = (process.env.E2E_AUTH_DIR ??= mkdtempSync(join(tmpdir(), "dispand-e2e-")));

/** Where a "main-N" project's setup saves the owner's cookies. */
export const authFile = (project: string) => join(dir, `${project}.json`);
