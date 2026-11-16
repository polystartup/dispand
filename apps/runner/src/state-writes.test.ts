import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// One rule for the runner's state on disk (config, token, state.json, sessions.json, backlog
// rewrites): replaced only through writeDurable. The backlog's appends go through its own fd.
// skills.ts and memory.ts write no state: a session's skill and memory files, each created once
// (O_EXCL), never replaced, and removed with the session. plugin-servers.ts neither: a plugin's
// files, each created once (O_EXCL) in a fresh folder renamed whole into place, never replaced.
// attachments.ts neither: a chat message's files in a run folder, each created once (O_EXCL), never replaced.
test("no runner source writes or renames a file except through writeDurable", () => {
  const dir = join(import.meta.dirname);
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "durable.ts" && f !== "skills.ts" && f !== "memory.ts" && f !== "plugin-servers.ts" && f !== "attachments.ts")
    .filter((f) => /\b(writeFileSync|renameSync|writeFile|rename|appendFileSync|appendFile|copyFileSync|copyFile)\s*\(/.test(readFileSync(join(dir, f), "utf8")));
  expect(offenders).toEqual([]);
});
