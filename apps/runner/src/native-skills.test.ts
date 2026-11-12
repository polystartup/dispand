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
