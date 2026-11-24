// A plugin's stdio server (code fetched from Dispand) runs in a worker of its own: its files
// read-only, its data folder writable, a scratch CLI home, and the worker's route out.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Launch as PluginLaunch } from "../plugin-servers.ts";
import type { Sandbox } from "./worker.ts";

/** The launch that starts the plugin in its worker (`docker run -i …`), for whoever started it before, and that worker's removal. */
export async function serveInWorker(sandbox: Sandbox, launch: PluginLaunch, root: string): Promise<{ launch: PluginLaunch; remove(): Promise<void> }> {
  const files = launch.env.PLUGIN_ROOT;
  const data = launch.env.PLUGIN_DATA;
  if (!files || !data) throw new Error("a plugin's launch names its folders");
  const cliHome = join(root, "cli", `plugin-${randomUUID()}`);
  const worker = await sandbox.worker(data, cliHome, [files]);
  const run = worker.command([launch.command, ...launch.args], launch.cwd, launch.env);
  return {
    launch: { command: run.command, args: run.args, env: run.env, cwd: data },
    remove: async () => {
      await worker.remove();
      await rm(cliHome, { recursive: true, force: true });
    },
  };
}
