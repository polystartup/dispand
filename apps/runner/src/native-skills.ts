import type { PluginReport } from "@dispand/runner-protocol";
import type { SkillPackage } from "./skills.ts";

/** A verified full native installation replaces its workspace package only on this harness. */
export function fallbackPackages(packages: SkillPackage[], harness: "claude-code" | "codex", report: PluginReport): SkillPackage[] {
  if (report.error) return packages;
  return packages.filter((pkg) => !pkg.nativePlugin || !pkg.nativeKey || !report.packages?.some((native) =>
    native.sourceKey === pkg.nativeKey && native.harness === harness && native.installed && native.enabled === true && !native.pending,
  ));
}
