import { writeDurable } from "./durable.ts";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** Installer-managed systemd services only. The transient unit survives the runner's restart. */
export function startUpdates(server: string, token: string, configDir: string): void {
  if (process.env.DISPAND_RUNNER_MANAGED !== "1") return;
  // Keep the running code's identity even if a failed installer replaces files on disk.
  const build = readFile(new URL("./build.json", pathToFileURL(process.argv[1]!)), "utf8")
    .then((text) => (JSON.parse(text) as { buildId: string }).buildId);
  let failed = false;
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const buildId = await build;
      const res = await fetch(new URL("/runner/update", server), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${token}`, "dispand-runner-build": buildId, "dispand-update-failed": failed ? "1" : "0" },
      });
      if (!res.ok || (await res.json() as { update?: boolean }).update !== true) return;
      failed = true;
      const dir = await mkdtemp(join(tmpdir(), "dispand-update-"));
      try {
        const installer = await fetch(new URL("/runner/install.sh", server), { redirect: "error", signal: AbortSignal.timeout(30_000) });
        if (!installer.ok) throw new Error("installer unavailable");
        const script = join(dir, "install.sh");
        writeDurable(script, await installer.text());
        const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: dirname(configDir) };
        const names = ["HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
        await promisify(execFile)("systemd-run", ["--user", "--collect", "--wait", "--unit=dispand-runner-update",
          ...names.flatMap((name) => environment[name] ? [`--setenv=${name}=${environment[name]}`] : []),
          "/bin/sh", "-c", `trap 'rm -rf -- "$2"' EXIT; sh "$1" --update`, "dispand-update", script, dir,
        ], { timeout: 150_000 });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch {
      // No installer output: it can contain private paths. systemd keeps diagnostics locally.
      console.error("dispand-runner: update check or install failed");
    } finally {
      running = false;
    }
  };
  void poll();
  setInterval(() => void poll(), 5000).unref();
}
