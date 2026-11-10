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
  const config = codexConfig({ denied, pluginsDir: join(base, "plugins"), bypass: false });
  expect(config).toEqual({
    default_permissions: "dispand",
    permissions: {
      dispand: {
        extends: ":workspace",
        filesystem: {
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
