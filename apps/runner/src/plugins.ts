import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { nativeSourceKey, PluginOperation, PluginReport, workspacePluginContent, type PluginHarness } from "@dispand/runner-protocol";
import { z } from "zod";
import { runnerStateDir } from "./config.ts";
import { unlock, writeSkills } from "./skills.ts";

// Skillshare's JSON contract: internal/plugin/model.go and targets.go. Parse only the
// fields we use. Never forward native messages, local paths, source URLs or identifiers.
const name = z.string();
const rows = <T extends z.ZodType>(item: T) => z.array(item).nullish().transform((v) => v ?? []);
const Inventory = z.object({
  targetDefinitions: rows(z.object({ target: name, operations: rows(name) })),
  packages: z.record(name, z.object({ bindings: z.record(name, z.object({ id: name, source: name.optional(), sourceRef: name.optional(), commit: name.optional(), plugin: name.optional(), pending: name.optional(), contextChanged: z.boolean().optional(), cleanup: z.boolean().optional(), refChanged: z.boolean().optional() })).nullish() })),
  hosts: rows(z.object({ target: name, status: name, error: name.optional(), installed: rows(z.object({ id: name.optional(), installed: z.boolean().optional(), enabledKnown: z.boolean(), enabled: z.boolean() })) })),
});
const Discovery = z.object({ candidates: rows(z.object({ name, targets: rows(name), problem: name.optional() })) });
const Plan = z.object({ revision: name, blocked: z.boolean(), changes: rows(z.object({ name, target: name, action: name })) });
const Result = z.object({ results: rows(z.object({ name, target: name, status: name })) });
type Harness = z.infer<typeof PluginHarness>;
// Native manifests use kebab-case; Skillshare's logical binding retains the workspace id.
const workspacePluginName = (name: string) => name.toLowerCase().replace(/[._]/g, "-");
export type PluginExec = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; failed: boolean }>;

const execute: PluginExec = (args, env) => new Promise((resolve) => {
  const child = spawn("skillshare", args, { cwd: homedir(), env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process group already exited. */ }
    }
  };
  const timer = setTimeout(stop, 120_000);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) stop();
    else chunks.push(chunk);
  });
  child.on("error", () => {
    clearTimeout(timer);
    resolve({ stdout: "", failed: true });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) stop();
    resolve({ stdout: Buffer.concat(chunks).toString("utf8"), failed: stopped || code !== 0 });
  });
});

/** One operation at a time; native failures never trigger retry, sync or fallback. */
export class NativePlugins {
  private busy = false;
  private readonly targets: Partial<Record<Harness, string>>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec: PluginExec;
  private readonly workspaceRoot: string;
  constructor(targets: Partial<Record<Harness, string>>, env: NodeJS.ProcessEnv, exec: PluginExec = execute) {
    this.targets = targets;
    this.workspaceRoot = join(runnerStateDir(env), "native-skills");
    // Match machineConfigPaths even when the operator supplied relative local env paths:
    // Skillshare always runs from home, rather than from the runner service's directory.
    this.env = { ...env };
    for (const key of ["SKILLSHARE_CONFIG", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) {
      if (env[key]) this.env[key] = resolve(env[key]);
    }
    this.exec = exec;
  }

  async request(input: PluginOperation): Promise<PluginReport> {
    if (this.busy) return { error: "Native plugin management is busy" };
    this.busy = true;
    try {
      const op = PluginOperation.parse(input);
      const entries = Object.entries(this.targets) as [Harness, string][];
      if (!entries.length) return { error: "Native plugin management is disabled in this runner's local config" };
      if (new Set(entries.map(([, target]) => target)).size !== entries.length) return { error: "Native plugin targets must name separate accounts" };
      const harness = (target: string) => entries.find(([, t]) => target === t)?.[0];
      const workspaceRoot = this.workspaceRoot;
      const args = ["plugin", op.action === "add-workspace" ? "add" : op.action, "--global", "--json", "--no-tui"];
      if (op.action === "add-workspace") {
        const digest = createHash("sha256").update(workspacePluginContent(op.files)).digest("hex");
        const dir = join(workspaceRoot, op.name, digest);
        const plugin = workspacePluginName(op.name);
        const root = join(dir, plugin);
        await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const existing = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("invalid workspace plugin source");
        // Content-addressed sources persist for Skillshare's maintained reinstall lifecycle.
        // Only skills and our manifest are written, using the session writer's path/frontmatter rules.
        if (!existing) {
          await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
          const staging = await mkdtemp(join(dirname(dir), ".stage-"));
          try {
            await writeSkills(staging, [{ name: plugin, files: op.files.map((f) => ({ path: f.path, content: Buffer.from(f.base64, "base64") })) }]);
            await rename(staging, dir);
          } finally {
            await unlock(staging);
            await rm(staging, { recursive: true, force: true });
          }
        }
        args.push(root, "--name", op.name, "--plugin", plugin);
      }
      if (op.action === "discover" || op.action === "add") {
        args.push(op.source);
        if (op.sourceRef) args.push("--source-ref", op.sourceRef);
      }
      if (op.action === "add") args.push("--name", op.name, "--plugin", op.plugin);
      if (op.action === "remove") args.push(op.name);
      if ("targets" in op) {
        for (const h of op.targets) {
          const target = this.targets[h];
          if (!target) return { error: "This harness has no locally authorized native plugin target" };
          args.push("--target", target);
        }
        if (op.dryRun) args.push("--dry-run");
        else args.push("--revision", op.revision!);
      }
      const { stdout, failed } = await this.exec(args, this.env);
      const data: unknown = JSON.parse(stdout);
      let report: PluginReport;
      if (op.action === "list") {
        const inventory = Inventory.parse(data);
        report = {
          targets: entries.map(([harness, target]) => {
            const host = inventory.hosts.find((h) => h.target === target);
            const ops = inventory.targetDefinitions.find((d) => d.target === target)?.operations ?? [];
            return { harness, available: host?.status === "ready" && !host.error, add: ops.includes("add"), remove: ops.includes("remove") };
          }),
          packages: Object.entries(inventory.packages).flatMap(([name, pkg]) => entries.flatMap(([harness, target]) => {
            const binding = pkg.bindings?.[target];
            if (!binding) return [];
            const host = inventory.hosts.find((h) => h.target === target);
            const native = host?.installed.find((i) => i.id === binding.id);
            const digest = binding.source && dirname(dirname(dirname(binding.source))) === workspaceRoot && basename(dirname(dirname(binding.source))) === name && basename(binding.source) === workspacePluginName(name) && binding.plugin === workspacePluginName(name) ? basename(dirname(binding.source)) : undefined;
            const identity = nativeSourceKey(binding.source ?? "", binding.commit || binding.sourceRef || "", binding.plugin ?? "");
            const sourceKey = digest && /^[a-f0-9]{64}$/.test(digest) ? `workspace:${digest}` : identity ? createHash("sha256").update(identity).digest("hex") : undefined;
            return [{ name, ...(sourceKey ? { sourceKey } : {}), harness, installed: host?.status === "ready" && !host.error && !!native && (harness === "claude-code" || native.installed === true), enabled: native?.enabledKnown ? native.enabled : null, pending: !!binding.pending || !!binding.contextChanged || !!binding.cleanup || !!binding.refChanged }];
          })),
        };
      } else if (op.action === "discover") {
        report = { candidates: Discovery.parse(data).candidates.map((c) => ({ name: c.name, blocked: !!c.problem, targets: entries.flatMap(([h]) => c.targets.includes(h === "claude-code" ? "claude" : "codex") ? [h] : []) })) };
      } else if (op.dryRun) {
        const plan = Plan.parse(data);
        report = { revision: plan.revision, blocked: plan.blocked, changes: plan.changes.map((c) => ({ name: c.name, action: c.action, ...(harness(c.target) ? { harness: harness(c.target) } : {}) })) };
      } else {
        report = { results: Result.parse(data).results.map((r) => ({ name: r.name, status: r.status, ...(harness(r.target) ? { harness: harness(r.target) } : {}) })) };
      }
      // A failing command can have successful per-target results: preserve them for the caller.
      if (failed) report.error = "Skillshare reported a native plugin failure; inspect each target before retrying";
      return PluginReport.parse(report);
    } catch {
      return { error: "Skillshare could not complete native plugin management; check its installation and local configuration on the runner" };
    } finally {
      this.busy = false;
    }
  }
}
