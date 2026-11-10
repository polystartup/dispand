import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const CODE = "SECRET2345";

/**
 * A scratch machine for install.sh: a fake download (a bundle whose `main.mjs pair` records its
 * argv and environment and saves a config and token like the real one), and fake curl, node
 * and systemctl that record their argv. The user manager has `managerConfig` as XDG_CONFIG_HOME.
 */
async function machine(managerConfig: string | null, opts: { failEnable?: boolean } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "install-")));
  made.push(base);
  const home = join(base, "home");
  const bin = join(base, "bin");
  const bundle = join(base, "bundle", "dispand-runner");
  const argvLog = join(base, "argv");
  await mkdir(home, { recursive: true });
  await mkdir(bin);
  await mkdir(bundle, { recursive: true });
  await writeFile(
    join(bundle, "main.mjs"),
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(base, "pairs"))}, JSON.stringify({ args, code: process.env.DISPAND_PAIRING_CODE }) + "\\n");
const at = (flag) => args[args.indexOf(flag) + 1];
mkdirSync(at("--config"), { recursive: true });
writeFileSync(at("--config") + "/config.json", JSON.stringify({ server: at("--server"), token: "tok" }));
`,
  );
  await writeFile(join(bundle, "dispand-runner.service"), await readFile(resolve("install/dispand-runner.service")));
  await promisify(execFile)("tar", ["-czf", join(base, "runner.tgz"), "-C", dirname(bundle), "dispand-runner"]);
  const script = (name: string, body: string) => writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${argvLog}\n${body}\n`).then(() => chmod(join(bin, name), 0o755));
  await script("curl", `while [ $# -gt 0 ]; do if [ "$1" = -o ]; then cp ${join(base, "runner.tgz")} "$2"; fi; shift; done`);
  await script("node", `exec ${process.execPath} "$@"`);
  await script(
    "systemctl",
    `if [ "$2" = show-environment ]; then ${managerConfig ? `echo XDG_CONFIG_HOME=${managerConfig}` : "true"}; echo PATH=/usr/bin; fi
${opts.failEnable ? 'if [ "$2" = enable ]; then exit 1; fi' : ""}`,
  );
  const shellConfig = join(base, "shell-config");
  const run = (extraEnv: NodeJS.ProcessEnv = {}, args = ["--server", "https://dispand.test", "--root", join(base, "root")]) =>
    promisify(execFile)("sh", ["install/install.sh", ...args], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: undefined,
        CODEX_HOME: undefined,
        DISPAND_PAIRING_CODE: CODE,
        ...extraEnv,
        HOME: home,
        XDG_CONFIG_HOME: shellConfig,
        XDG_DATA_HOME: join(base, "data"),
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
  const pairs = async () =>
    (await readFile(join(base, "pairs"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; code?: string });
  const argv = () => readFile(argvLog, "utf8").catch(() => "");
  /** Replaces the download with a bundle that also holds `marker` (a newer runner). */
  const newRelease = async (marker: string) => {
    await writeFile(join(bundle, "VERSION"), marker);
    await promisify(execFile)("tar", ["-czf", join(base, "runner.tgz"), "-C", dirname(bundle), "dispand-runner"]);
  };
  return { base, home, shellConfig, run, pairs, argv, newRelease, dest: join(base, "data", "dispand-runner") };
}

test("pair gets the code through its environment, never argv, and the config dir the unit reads", async () => {
  const m = await machine(null);
  await m.run();
  expect(await m.pairs()).toEqual([
    { args: ["pair", "--config", join(m.shellConfig, "dispand-runner"), "--server", "https://dispand.test", "--root", join(m.base, "root")], code: CODE },
  ]);
  // No argv of anything install.sh started (curl, node, systemctl, pair) carries the code.
  expect(await m.argv()).toContain("node ");
  expect(await m.argv()).not.toContain(CODE);
});

test("with the manager's XDG_CONFIG_HOME, or ~/.config without one, never the shell's", async () => {
  for (const managerConfig of [null, "manager-config"]) {
    const base = await realpath(await mkdtemp(join(tmpdir(), "mgr-")));
    made.push(base);
    const m = await machine(managerConfig === null ? null : join(base, managerConfig));
    await m.run();
    const unitDir = managerConfig === null ? join(m.home, ".config", "systemd", "user") : join(base, managerConfig, "systemd", "user");
    const unit = await readFile(join(unitDir, "dispand-runner.service"), "utf8");
    expect(unit).toContain(`run --config "${join(m.shellConfig, "dispand-runner")}"`);
    await expect(readFile(join(m.shellConfig, "systemd", "user", "dispand-runner.service"))).rejects.toThrow();
  }
});

test("the unit passes on the installing shell's CLAUDE_CONFIG_DIR, and only when it is set", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ccd-")));
  made.push(base);
  await mkdir(join(base, "claude config"));
  // Relative to where install.sh runs: written into the unit as an absolute path.
  await (await machine(join(base, "manager"))).run({ CLAUDE_CONFIG_DIR: relative(process.cwd(), join(base, "claude config")) });
  const unit = await readFile(join(base, "manager", "systemd", "user", "dispand-runner.service"), "utf8");
  expect(unit).toContain(`Environment="CLAUDE_CONFIG_DIR=${join(base, "claude config")}"`);
  const without = await machine(null);
  await without.run();
  const plain = await readFile(join(without.home, ".config", "systemd", "user", "dispand-runner.service"), "utf8");
  expect(plain).not.toContain("CLAUDE_CONFIG_DIR");
});

test("a unit directory that can't be written fails the install before the code is spent", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ro-")));
  made.push(base);
  // The manager's config dir has a file where systemd/ should be.
  await mkdir(join(base, "manager"));
  await writeFile(join(base, "manager", "systemd"), "");
  const m = await machine(join(base, "manager"));
  await expect(m.run()).rejects.toThrow();
  expect(await m.pairs()).toEqual([]);
});

test("a rerun after a later failure resumes without pairing again", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "rerun-")));
  made.push(base);
  const m = await machine(join(base, "manager"), { failEnable: true });
  await expect(m.run()).rejects.toThrow();
  expect(await m.pairs()).toHaveLength(1);
  // Fixed: enable works now. The same command (its code already spent) finishes the install.
  await writeFile(join(m.base, "bin", "systemctl"), `#!/bin/sh\nif [ "$2" = show-environment ]; then echo XDG_CONFIG_HOME=${join(base, "manager")}; fi\n`);
  const { stdout } = await m.run();
  expect(stdout).toContain("Already paired with https://dispand.test");
  expect(await m.pairs()).toHaveLength(1);
});

test("the unit passes on the installing shell's CODEX_HOME, and only when it is set", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "cxh-")));
  made.push(base);
  await mkdir(join(base, "codex home"));
  await (await machine(join(base, "manager"))).run({ CODEX_HOME: relative(process.cwd(), join(base, "codex home")) });
  const unit = await readFile(join(base, "manager", "systemd", "user", "dispand-runner.service"), "utf8");
  expect(unit).toContain(`Environment="CODEX_HOME=${join(base, "codex home")}"`);
  const without = await machine(null);
  await without.run();
  const plain = await readFile(join(without.home, ".config", "systemd", "user", "dispand-runner.service"), "utf8");
  expect(plain).not.toContain("CODEX_HOME");
});

test("install --update keeps config.json byte for byte, replaces the code and restarts the unit", async () => {
  const m = await machine(null);
  await m.run();
  const configPath = join(m.shellConfig, "dispand-runner", "config.json");
  // Hand-edited by the machine's owner: kept as written, spacing included.
  const config = `{ "server": "https://dispand.test",  "token": "tok", "roots": ["/x"], "allowBypass": true }\n`;
  await writeFile(configPath, config);
  await m.newRelease("v2");
  await writeFile(join(m.base, "argv"), "");

  // What Settings shows: no server, no code, no root.
  const { stdout } = await m.run({ DISPAND_PAIRING_CODE: undefined }, ["--update"]);
  expect(await readFile(configPath, "utf8")).toBe(config);
  expect(await readFile(join(m.dest, "VERSION"), "utf8")).toBe("v2");
  expect(await m.pairs()).toHaveLength(1);
  const argv = await m.argv();
  expect(argv).toContain("curl -fsSL --proto =https --tlsv1.2 https://dispand.test/runner/dispand-runner.tgz");
  expect(argv).toContain("systemctl --user restart dispand-runner.service");
  expect(stdout).toContain("updated");
});

test("install --update without a paired runner fails before downloading anything", async () => {
  const m = await machine(null);
  await expect(m.run({ DISPAND_PAIRING_CODE: undefined }, ["--update"])).rejects.toMatchObject({ stderr: expect.stringContaining("not installed") });
  expect(await m.argv()).not.toContain("curl ");
  expect(await m.pairs()).toEqual([]);
});

test("install --update applies the https rule to the saved server", async () => {
  const m = await machine(null);
  await m.run();
  await writeFile(join(m.shellConfig, "dispand-runner", "config.json"), JSON.stringify({ server: "http://dispand.lan", token: "tok" }));
  await writeFile(join(m.base, "argv"), "");
  await expect(m.run({ DISPAND_PAIRING_CODE: undefined }, ["--update"])).rejects.toMatchObject({ stderr: expect.stringContaining("https") });
  expect(await m.argv()).not.toContain("curl ");
});

test("install --update keeps the unit's CLAUDE_CONFIG_DIR and CODEX_HOME when its shell has none", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "upd-env-")));
  made.push(base);
  await mkdir(join(base, "claude"));
  await mkdir(join(base, "codex"));
  const m = await machine(join(base, "manager"));
  await m.run({ CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex") });
  await m.run({ DISPAND_PAIRING_CODE: undefined }, ["--update"]);
  const unit = await readFile(join(base, "manager", "systemd", "user", "dispand-runner.service"), "utf8");
  expect(unit).toContain(`Environment="CLAUDE_CONFIG_DIR=${join(base, "claude")}"`);
  expect(unit).toContain(`Environment="CODEX_HOME=${join(base, "codex")}"`);
  expect(unit.match(/CODEX_HOME/g)).toHaveLength(1);
});
