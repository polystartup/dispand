import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import type { RunnerConfig } from "./config.ts";
import { writeDurable } from "./durable.ts";

/** Source development uses the same downloaded release as the distributable. */
export function runnerPackageDir(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/dispand-runner/" : "./", import.meta.url));
}

/** The package's own executable, never a potentially incompatible Skillshare on PATH. */
export function skillshareBinary(): string {
  return join(runnerPackageDir(), "bin", `${process.platform}-${process.arch}`, "skillshare");
}

/** Default native accounts follow the session's CLI homes. Explicit local overrides stay intact. */
export function prepareSkillshare(dir: string, targets: RunnerConfig["pluginTargets"], env: NodeJS.ProcessEnv): { targets: NonNullable<RunnerConfig["pluginTargets"]>; env: NodeJS.ProcessEnv } {
  if (targets !== undefined) return { targets, env };
  const configDir = join(dir, "skillshare");
  const configPath = join(configDir, "config.yaml");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  let text = "";
  try { text = readFileSync(configPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const document = parseDocument(text || "{}\n");
  if (document.errors.length) throw new Error("Invalid runner-managed Skillshare configuration");
  document.set("source", join(configDir, "skills"));
  // Skillshare requires built-in names for default homes, and named accounts for other homes.
  // Keep previous account definitions so declarations for a former home remain readable.
  const accounts = document.toJS()?.targets ?? {};
  const home = env.HOME || homedir();
  const configured: NonNullable<RunnerConfig["pluginTargets"]> = {};
  for (const [harness, agent, variable, defaultDir] of [
    ["claude-code", "claude", "CLAUDE_CONFIG_DIR", ".claude"],
    ["codex", "codex", "CODEX_HOME", ".codex"],
  ] as const) {
    const dir = env[variable] || join(home, defaultDir);
    const target = resolve(dir) === resolve(home, defaultDir) ? agent : `dispand-${agent}`;
    if (target === agent) accounts[target] = {};
    else accounts[target] = { agent, config_dir: dir };
    configured[harness] = target;
  }
  document.set("targets", accounts);
  const updated = document.toString();
  if (updated !== text) writeDurable(configPath, updated);
  return { targets: configured, env: { ...env, SKILLSHARE_CONFIG: configPath } };
}
