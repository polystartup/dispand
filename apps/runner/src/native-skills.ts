import type { PluginReport } from "@dispand/runner-protocol";
import type { SkillPackage } from "./skills.ts";

/** A verified full native installation replaces its workspace package only on this harness. */
export function fallbackPackages(packages: SkillPackage[], harness: "claude-code" | "codex", report: PluginReport): SkillPackage[] {
  if (report.error) return packages;
  return packages.filter((pkg) => !pkg.nativePlugin || !pkg.nativeKey || !report.packages?.some((native) =>
    native.sourceKey === pkg.nativeKey && native.harness === harness && native.installed && native.enabled === true && !native.pending,
  ));
}


/** Alias only an installation proven to contain the same package, on this harness. */
export function nativeSkillAliases(packages: SkillPackage[], harness: "claude-code" | "codex", report: PluginReport): { alias: string; namespace: string }[] {
  const fallback = new Set(fallbackPackages(packages, harness, report));
  return packages.filter((pkg) => !fallback.has(pkg)).flatMap((pkg) => {
    const native = report.packages?.find((n) => n.sourceKey === pkg.nativeKey && n.harness === harness && n.installed && n.enabled === true && !n.pending);
    return native?.namespace ? [{ alias: pkg.name, namespace: native.namespace }] : [];
  });
}

export function resolveSkillAlias(text: string, aliases: { alias: string; namespace: string }[]): string {
  const match = /^\/([^:\s]+):([^\s]+)([\s\S]*)$/.exec(text);
  const found = match && aliases.find((a) => a.alias === match[1]);
  return found ? `/${found.namespace}:${match![2]}${match![3]}` : text;
}
