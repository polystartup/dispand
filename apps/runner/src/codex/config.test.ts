import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { codexDenied } from "../boundary.ts";
import { codexConfig } from "./config.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("every denied path is denied; skill packages are readable only", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "codex-config-")));
  made.push(base);
  await mkdir(join(base, "dotfiles", "codex"), { recursive: true });
  await symlink(join(base, "dotfiles", "codex"), join(base, ".codex"));
  const denied = codexDenied([join(base, ".codex"), join(base, ".claude.json")]);
  // A Codex home with its plugin folders and no skills folder: a missing one gets no grant.
  const home = join(base, "codex-home");
  await mkdir(join(home, "plugins", "cache"), { recursive: true });
  await mkdir(join(home, "plugins", "marketplaces"), { recursive: true });
  const config = codexConfig({ denied, codexHome: home, pluginsDir: join(base, "plugins"), bypass: false });
  expect(config).toEqual({
    default_permissions: "dispand",
    permissions: {
      dispand: {
        extends: ":workspace",
        filesystem: {
          [join(home, "plugins", "cache")]: "read",
          [join(home, "plugins", "marketplaces")]: "read",
          [join(base, ".codex")]: "deny",
          [join(base, "dotfiles", "codex")]: "deny",
          [join(base, ".claude.json")]: "deny",
          [join(base, "plugins")]: "read",
          ":workspace_roots": { ".": "write", ".codex": "read", ".agents": "read", "AGENTS.md": "read", "AGENTS.override.md": "read" },
        },
        network: { enabled: true },
      },
    },
    shell_environment_policy: { exclude: ["DISPAND_*"] },
  });
});

test("bypass selects Codex's unsandboxed profile, still without DISPAND_* in shells", () => {
  expect(codexConfig({ denied: ["/x"], bypass: true })).toEqual({ default_permissions: ":danger-full-access", shell_environment_policy: { exclude: ["DISPAND_*"] } });
});

test("native plugin code is readable while Codex settings and credentials stay denied", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "codex-home-")));
  made.push(home);
  await mkdir(join(home, "plugins", "cache"), { recursive: true });
  await mkdir(join(home, "skills"));
  const config = codexConfig({ denied: [home], codexHome: home, bypass: false });
  const fs = (config.permissions as { dispand: { filesystem: Record<string, unknown> } }).dispand.filesystem;
  expect(fs[home]).toBe("deny");
  expect(fs[join(home, "plugins", "cache")]).toBe("read");
  expect(fs[join(home, "skills")]).toBe("read");
  expect(fs[join(home, "config.toml")]).toBeUndefined();
  expect(fs[join(home, "auth.json")]).toBeUndefined();
});

test("an empty local Codex home uses the normal absolute default", () => {
  expect(codexConfig({ denied: [], codexHome: "", bypass: false })).toEqual(codexConfig({ denied: [], bypass: false }));
});
