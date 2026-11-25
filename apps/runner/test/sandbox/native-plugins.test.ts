// A conversation's native plugins in its worker: each granted plugin read-only at its own path,
// and no other conversation's. Real gVisor in CI (DISPAND_SANDBOX_RUNTIME).
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { nativePluginFolders, sweepNativePlugins } from "../../src/sandbox/native-plugins.ts";
import { Sandbox } from "../../src/sandbox/worker.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";

const plugin = (name: string) => [{ path: ".claude-plugin/plugin.json", content: Buffer.from(JSON.stringify({ name })) }];
const output = (child: ChildProcessWithoutNullStreams) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });

describe.skipIf(!RUNTIME)(`native plugins on ${RUNTIME}`, () => {
  let state: SandboxState;
  beforeAll(async () => {
    state = await sandboxState();
  });
  afterAll(async () => {
    await sweepNativePlugins(join(state.base, "store"));
    await state.done();
  });

  test("each worker sees its own granted plugin read-only, and not another conversation's", async () => {
    const store = join(state.base, "store");
    const files = { plugin_a: plugin("alpha"), plugin_b: plugin("beta") };
    const folders = await nativePluginFolders(store, (["plugin_a", "plugin_b"] as const).map((pluginId) => ({ pluginId, digest: contentDigest(files[pluginId]) })), async (id) => files[id as keyof typeof files]);
    const sandbox = new Sandbox({ owner: `test-native-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: "none" });
    await sandbox.sweep();
    for (const [mine, theirs] of [["plugin_a", "plugin_b"], ["plugin_b", "plugin_a"]] as const) {
      const workspace = join(state.base, "runs", mine);
      await mkdir(workspace, { recursive: true });
      const worker = await sandbox.worker(workspace, join(state.base, "cli", mine), [], { plugins: folders.filter((f) => f.pluginId === mine) });
      const script = `cat /run/plugins/${mine}/.claude-plugin/plugin.json; echo; touch /run/plugins/${mine}/x 2>/dev/null && echo writable || echo readonly; ls /run/plugins; test -e /run/plugins/${theirs} && echo seen || echo hidden`;
      const { code, out } = await output(worker.probe(["sh", "-c", script]));
      await worker.remove();
      expect(code, out).toBe(0);
      expect(out).toContain(JSON.stringify({ name: mine === "plugin_a" ? "alpha" : "beta" }));
      expect(out).toContain("readonly");
      expect(out).toContain("hidden");
      expect(out).not.toContain("writable");
    }
  }, 180_000);
});
