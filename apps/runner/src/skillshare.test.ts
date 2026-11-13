import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import { build } from "esbuild";
import { bundleSkillshare, SKILLSHARE_VERSION, verifySkillshare, type SkillshareArch } from "../skillshare-release.ts";
import { NativePlugins, skillshareExec } from "./plugins.ts";
import { prepareSkillshare } from "./skillshare.ts";
import { unlock } from "./skills.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) { await unlock(dir); await rm(dir, { recursive: true, force: true }); }
});
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "skillshare-contract-"));
  made.push(dir);
  return dir;
}
// This is intentionally the real, checksum-pinned release. CI verifies its JSON contract on every change.
let binary: string;
let releaseDir: string;
beforeAll(async () => {
  releaseDir = await mkdtemp(join(tmpdir(), "skillshare-release-"));
  binary = await bundleSkillshare(releaseDir, process.arch as SkillshareArch);
}, 90_000);
afterAll(async () => { await rm(releaseDir, { recursive: true, force: true }); });

test("release verification refuses modified archives before extraction", () => {
  for (const arch of ["x64", "arm64"] as const) expect(() => verifySkillshare(arch, Buffer.from("wrong release"))).toThrow("checksum mismatch");
});

test("the bundled executable identifies the pinned version and includes its license", async () => {
  const { stdout } = await promisify(execFile)(binary, ["version"]);
  expect(stdout).toContain(SKILLSHARE_VERSION);
  expect(await readFile(join(releaseDir, "LICENSE"), "utf8")).toContain("MIT License");
});

test("managed setup follows session accounts, preserves plugins on restart and leaves personal config untouched", async () => {
  const base = await scratch();
  const personal = join(base, "personal.yaml");
  await writeFile(personal, "personal config");
  const env = { CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SKILLSHARE_CONFIG: personal };
  const first = prepareSkillshare(base, "managed", env);
  const path = first.env.SKILLSHARE_CONFIG!;
  expect(first.targets).toEqual({ "claude-code": "dispand-claude", codex: "dispand-codex" });
  const config = parse(await readFile(path, "utf8"));
  expect(config.targets).toEqual({ "dispand-claude": { agent: "claude", config_dir: env.CLAUDE_CONFIG_DIR }, "dispand-codex": { agent: "codex", config_dir: env.CODEX_HOME } });
  config.plugins = { version: 2, packages: { kept: { source: "https://example.com/plugins", bindings: {} } } };
  await writeFile(path, JSON.stringify(config));
  prepareSkillshare(base, "managed", { ...env, CODEX_HOME: join(base, "codex-other") });
  const restarted = parse(await readFile(path, "utf8"));
  expect(restarted.plugins).toEqual(config.plugins);
  expect(restarted.targets["dispand-codex"].config_dir).toBe(join(base, "codex-other"));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(personal, "utf8")).toBe("personal config");
});

test("explicit local overrides, including disabling native management, are preserved", async () => {
  const base = await scratch();
  for (const targets of [undefined, {}, { codex: "custom" }]) {
    const env = { SKILLSHARE_CONFIG: join(base, "custom.yaml") };
    expect(prepareSkillshare(base, targets, env)).toEqual({ targets: targets ?? {}, env });
  }
  await expect(stat(join(base, "skillshare"))).rejects.toThrow();
});

/** Native clients are fixtures; source staging, plans, revisions and receipts use real Skillshare. */
async function clientMachine(defaultHomes = false) {
  const base = await scratch();
  const bin = join(base, "bin");
  await mkdir(bin);
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const codex = process.argv[1].endsWith("codex");
const dir = process.env[codex ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"];
fs.mkdirSync(dir, { recursive: true });
const stateFile = path.join(dir, "fixture.json");
let state = { plugins: [], markets: {} };
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
const out = data => console.log(typeof data === "string" ? data : JSON.stringify(data));
if (args.includes("--help")) out("--json --scope --force");
else if (args[0] === "--version") out("2.1.300");
else if (args[1] === "list") out(codex ? { installed: state.plugins.map(p => ({ ...p, pluginId: p.id })) } : state.plugins);
else if (args[1] === "marketplace" && args[2] === "list") {
 const markets = Object.entries(state.markets).map(([name, root]) => ({ name, root, installLocation: root }));
 out(codex ? { marketplaces: markets } : markets);
}
else if (args[1] === "marketplace" && args[2] === "add") {
 const root = args[3];
 const market = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
 state.markets[market.name] = root;
} else if (args[1] === "marketplace" && args[2] === "remove") delete state.markets[args[3]];
else if (args[1] === "install" || args[1] === "add") { state.plugins.push({ id: args[2], scope: "user", installed: true, enabled: true }); out({}); }
else if (args[1] === "uninstall" || args[1] === "remove") state.plugins = state.plugins.filter(p => p.id !== args[2]);
else process.exit(1);
fs.writeFileSync(stateFile, JSON.stringify(state));
`;
  for (const client of ["claude", "codex"]) {
    await writeFile(join(bin, client), script);
    await chmod(join(bin, client), 0o755);
  }
  // A conflicting PATH install must never be executed by the runner adapter.
  await writeFile(join(bin, "skillshare"), "#!/bin/sh\nexit 99\n");
  await chmod(join(bin, "skillshare"), 0o755);
  const env = { ...process.env, HOME: base, PATH: `${bin}:/usr/bin:/bin`, XDG_CONFIG_HOME: join(base, "config"), XDG_STATE_HOME: join(base, "state"), XDG_DATA_HOME: join(base, "data"), CLAUDE_CONFIG_DIR: join(base, defaultHomes ? ".claude" : "claude"), CODEX_HOME: join(base, defaultHomes ? ".codex" : "codex"), SKILLSHARE_CODEX_CLI: join(bin, "codex") };
  const prepared = prepareSkillshare(join(base, "runner-config"), "managed", env);
  return { base, prepared, native: new NativePlugins(prepared.targets, prepared.env, skillshareExec(binary)) };
}

test.each([false, true])("pinned Skillshare installs both targets with one preview and apply (default homes: %s)", async (defaultHomes) => {
  const { base, native } = await clientMachine(defaultHomes);
  const inventory = await native.request({ action: "list" });
  expect(inventory.error).toBeUndefined();
  expect(inventory.targets).toEqual([
    { harness: "claude-code", available: true, add: true, remove: true },
    { harness: "codex", available: true, add: true, remove: true },
  ]);
  const targets = ["claude-code", "codex"] as const;
  const operation = { action: "add-workspace" as const, name: "dispand-batched", targets: [...targets], files: [{ path: "writing/SKILL.md", base64: Buffer.from("---\nname: writing\ndescription: Write clearly\n---\nText\n").toString("base64") }] };
  const preview = await native.request({ ...operation, dryRun: true });
  expect(preview.error).toBeUndefined();
  expect(preview.blocked).toBe(false);
  expect(preview.revision).toBeTruthy();
  expect((await native.request({ ...operation, dryRun: false, revision: "stale" })).error).toBeTruthy();
  const applied = await native.request({ ...operation, dryRun: false, revision: preview.revision! });
  expect(applied.error).toBeUndefined();
  expect(applied.results).toHaveLength(2);
  const installed = await native.request({ action: "list" });
  for (const harness of targets) {
    expect(applied.results).toContainEqual({ name: operation.name, harness, status: "installed" });
    expect(installed.packages).toContainEqual(expect.objectContaining({ name: operation.name, harness, installed: true, enabled: true, pending: false }));
  }
  const removal = { action: "remove" as const, name: operation.name, targets: [...targets] };
  const removePlan = await native.request({ ...removal, dryRun: true });
  expect(removePlan.error).toBeUndefined();
  expect((await native.request({ ...removal, dryRun: false, revision: removePlan.revision! })).error).toBeUndefined();
  expect((await native.request({ action: "list" })).packages).not.toContainEqual(expect.objectContaining({ name: operation.name }));
  expect(JSON.stringify(inventory)).not.toContain(base);
});


test("a bundled runner module selects its own executable even with a conflicting PATH installation", async () => {
  const { base, prepared } = await clientMachine(true);
  const packaged = join(base, "package");
  const binDir = join(packaged, "bin", `linux-${process.arch}`);
  await mkdir(binDir, { recursive: true });
  await symlink(binary, join(binDir, "skillshare"));
  const entry = join(packaged, "main.mjs");
  await build({
    stdin: {
      contents: 'import { NativePlugins } from "./src/plugins.ts"; console.log(JSON.stringify(await new NativePlugins(JSON.parse(process.env.TEST_TARGETS), process.env).request({ action: "list" })));',
      resolveDir: process.cwd(),
    },
    outfile: entry, bundle: true, platform: "node", format: "esm",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  const { stdout } = await promisify(execFile)(process.execPath, [entry], { env: { ...prepared.env, TEST_TARGETS: JSON.stringify(prepared.targets) } });
  expect(JSON.parse(stdout).targets).toEqual([
    { harness: "claude-code", available: true, add: true, remove: true },
    { harness: "codex", available: true, add: true, remove: true },
  ]);
});


test("moving from a custom home to the default keeps former binding declarations readable", async () => {
  const { base, prepared, native } = await clientMachine();
  const operation = { action: "add-workspace" as const, name: "retained", targets: ["codex" as const], files: [{ path: "writing/SKILL.md", base64: Buffer.from("---\nname: writing\ndescription: Write clearly\n---\nText\n").toString("base64") }] };
  const preview = await native.request({ ...operation, dryRun: true });
  expect((await native.request({ ...operation, dryRun: false, revision: preview.revision! })).error).toBeUndefined();
  const next = prepareSkillshare(join(base, "runner-config"), "managed", { ...prepared.env, CODEX_HOME: join(base, ".codex") });
  expect(next.targets.codex).toBe("codex");
  const inventory = await new NativePlugins(next.targets, next.env, skillshareExec(binary)).request({ action: "list" });
  expect(inventory.error).toBeUndefined();
  expect(inventory.targets).toContainEqual({ harness: "codex", available: true, add: true, remove: true });
  expect(inventory.packages).toEqual([]);
  const saved = parse(await readFile(next.env.SKILLSHARE_CONFIG!, "utf8"));
  expect(saved.plugins.packages.retained).toBeTruthy();
  expect(saved.targets["dispand-codex"].config_dir).toBe(prepared.env.CODEX_HOME);
});
