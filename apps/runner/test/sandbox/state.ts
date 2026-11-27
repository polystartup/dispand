// Where a sandbox test keeps its state: inside the supervisor image (CI's runner-sandbox job),
// a folder of its state volume, bound into workers from the volume's host folder; elsewhere, a
// folder of this run's own temporary state folder, mounted by bind. Either way, the run's tests
// share the state folder, where Claude Code is installed once (`claude-code.setup.ts`).
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** This run's local state folder (`claude-code.setup.ts`). */
    sandboxState?: string;
  }
}

export type SandboxState = { stateDir: string; stateSource: string; base: string; done(): Promise<void> };

export async function sandboxState(): Promise<SandboxState> {
  const volume = process.env.DISPAND_STATE_VOLUME;
  const root = process.env.DISPAND_SANDBOX_STATE;
  if (volume && root) {
    const base = await mkdtemp(join(root, "test-"));
    return { stateDir: root, stateSource: volume, base, done: () => rm(base, { recursive: true, force: true }) };
  }
  const stateDir = inject("sandboxState") ?? (await realpath(await mkdtemp(join(tmpdir(), "sandbox-"))));
  const base = await mkdtemp(join(stateDir, "test-"));
  return { stateDir, stateSource: stateDir, base, done: () => rm(base, { recursive: true, force: true }) };
}
