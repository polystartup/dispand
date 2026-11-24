// Where a sandbox test keeps its state: inside the supervisor image (CI's runner-sandbox job),
// a folder of its state volume, bound into workers from the volume's host folder; elsewhere, a
// temporary folder mounted by bind.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxState = { stateDir: string; stateSource: string; base: string; done(): Promise<void> };

export async function sandboxState(): Promise<SandboxState> {
  const volume = process.env.DISPAND_STATE_VOLUME;
  const root = process.env.DISPAND_SANDBOX_STATE;
  if (volume && root) {
    const base = await mkdtemp(join(root, "test-"));
    return { stateDir: root, stateSource: volume, base, done: () => rm(base, { recursive: true, force: true }) };
  }
  const base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-")));
  return { stateDir: base, stateSource: base, base, done: () => rm(base, { recursive: true, force: true }) };
}
