import { expect, test } from "vitest";
import { fallbackPackages } from "./native-skills.ts";

const packages = [
  { name: "review", nativePlugin: "dispand-plugin_1", nativeKey: "source-key", files: [] },
  { name: "local", files: [] },
];
const native = { name: "dispand-plugin_1", sourceKey: "source-key", harness: "codex" as const, installed: true, enabled: true, pending: false };

test("uses the native package only on the matching harness and retains standalone workspace skills", () => {
  expect(fallbackPackages(packages, "codex", { packages: [native] })).toEqual([packages[1]]);
  expect(fallbackPackages(packages, "claude-code", { packages: [native] })).toEqual(packages);
  expect(fallbackPackages(packages, "codex", { packages: [{ ...native, name: "review" }] })).toEqual([packages[1]]);
});

test("absent, disabled, unknown, pending or failed native inventory keeps workspace packages", () => {
  for (const report of [
    {}, { error: "unavailable", packages: [native] },
    { packages: [{ ...native, sourceKey: "different-source" }] },
    { packages: [{ ...native, sourceKey: undefined }] },
    { packages: [{ ...native, installed: false }] },
    { packages: [{ ...native, enabled: false }] },
    { packages: [{ ...native, enabled: null }] },
    { packages: [{ ...native, pending: true }] },
  ]) expect(fallbackPackages(packages, "codex", report)).toEqual(packages);
});

test("a fallback invocation resolves to the namespace of the verified native installation", async () => {
  const { nativeSkillAliases, resolveSkillAlias } = await import("./native-skills.ts");
  const report = { packages: [{ ...native, namespace: "actual-native" }] };
  const aliases = nativeSkillAliases(packages, "codex", report);
  expect(resolveSkillAlias("/review:tidy these rows", aliases)).toBe("/actual-native:tidy these rows");
  expect(nativeSkillAliases(packages, "claude-code", report)).toEqual([]);
  expect(resolveSkillAlias("/review:tidy", nativeSkillAliases(packages, "codex", { packages: [{ ...native, namespace: "other", sourceKey: "wrong" }] }))).toBe("/review:tidy");
});

test("only packages staged in the session bind their commands, with the key Dispand sent", async () => {
  const { stagedSources } = await import("./native-skills.ts");
  const staged = [{ name: "tidy", nativePlugin: "dispand-tidy", nativeKey: "workspace:abc", files: [] }];
  const commands = [{ name: "tidy:tidy", description: "Staged" }, { name: "user:tidy", description: "Local user scope" }, { name: "tidy:tidy~0123456789ab", description: "Ambiguous" }, { name: "tidy:other", description: "Verified", sourceKey: "native" }];
  expect(stagedSources(commands, staged)).toEqual([{ name: "tidy:tidy", description: "Staged", sourceKey: "workspace:abc" }, commands[1], commands[2], commands[3]]);
  // A package a native installation replaced at the start was never staged: a same-named command stays unbound.
  expect(stagedSources(commands, [])).toEqual(commands);
});
