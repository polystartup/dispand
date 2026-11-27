// Where a sandbox test keeps its state: inside the supervisor image (CI's runner-sandbox job),
// a folder of its state volume, bound into workers from the volume's host folder; elsewhere, a
// folder of one temporary state folder mounted by bind. Either way, every test shares the state
// folder, where Claude Code is installed once (`claude-code.setup.ts`).
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxState = { stateDir: string; stateSource: string; base: string; done(): Promise<void> };

/** The state folder every local run shares. */
export async function localState(): Promise<string> {
  const dir = join(tmpdir(), `dispand-sandbox-${process.getuid?.() ?? 0}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return realpath(dir);
}

export async function sandboxState(): Promise<SandboxState> {
  const volume = process.env.DISPAND_STATE_VOLUME;
  const root = process.env.DISPAND_SANDBOX_STATE;
  if (volume && root) {
    const base = await mkdtemp(join(root, "test-"));
    return { stateDir: root, stateSource: volume, base, done: () => rm(base, { recursive: true, force: true }) };
  }
  const stateDir = await localState();
  const base = await mkdtemp(join(stateDir, "test-"));
  return { stateDir, stateSource: stateDir, base, done: () => rm(base, { recursive: true, force: true }) };
}
