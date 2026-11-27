// The sandbox tests (`DISPAND_SANDBOX_IMAGE` set): Claude Code installed into their state folder
// (`state.ts`) as the supervisor's first start does, before any worker starts, so each worker
// gets it bound read-only. Run locally, the state folder is this run's own, removed after it.
// The install is the host's: run them on Linux, the workers' platform.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { installClaudeCode } from "../../src/claude-code.ts";
import "./state.ts";

export default async function setup(project: TestProject) {
  if (!process.env.DISPAND_SANDBOX_IMAGE) return;
  const volume = process.env.DISPAND_SANDBOX_STATE;
  const root = volume ?? (await realpath(await mkdtemp(join(tmpdir(), "dispand-sandbox-"))));
  const done = () => (volume ? undefined : rm(root, { recursive: true, force: true }));
  if (!volume) project.provide("sandboxState", root);
  const installed = await installClaudeCode(root, "clis/claude-code").catch(async (err: unknown) => {
    await done();
    throw err;
  });
  console.log(`Claude Code: ${installed} in ${root}`);
  return done;
}
