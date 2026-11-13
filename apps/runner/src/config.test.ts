import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { permissionBoundary } from "./boundary.ts";
import { codexEnv, loadConfig, loadToken, machineConfigPaths, preparePairing, runnerStateDir, serverUrl, stateDir } from "./config.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function configWith(server: string) {
  const dir = await mkdtemp(join(tmpdir(), "config-"));
  made.push(dir);
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ server, roots: ["/srv/work"] }));
  return path;
}

test.each(["https://dispand.lan", "http://localhost:3000", "http://127.0.0.1:3000", "http://127.1.2.3", "http://[::1]:3000"])(
  "accepts %s",
  async (server) => {
    expect(loadConfig(await configWith(server)).server).toBe(server);
    expect(serverUrl(server)).toBe(server);
  },
);

test.each(["http://dispand.lan", "http://localhost:1@evil.invalid", "http://127.0.0.1.evil.test", "http://localhost.evil.test", "ws://127.0.0.1", "ftp://dispand.lan"])(
  "refuses %s: the token would go out in clear",
  async (server) => {
    const path = await configWith(server);
    expect(() => loadConfig(path)).toThrow(/https/);
    expect(() => serverUrl(server)).toThrow(/https/);
  },
);

test("a root that contains or sits inside the machine's config is refused", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "roots-")));
  made.push(base);
  const home = join(base, "home");
  const runnerConfig = join(home, ".config", "dispand-runner");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(runnerConfig, { recursive: true });
  await mkdir(join(base, "elsewhere", "claude-config"), { recursive: true });
  const path = join(runnerConfig, "config.json");
  const load = async (roots: string[], env: NodeJS.ProcessEnv = {}) => {
    await writeFile(path, JSON.stringify({ server: "https://dispand.lan", roots }));
    return () => loadConfig(path, env, home);
  };
  expect((await load([join(home, "dispand")]))().roots).toEqual([join(home, "dispand")]);
  for (const roots of [[home], [join(home, ".claude")], [join(home, ".claude", "projects")], [join(home, ".config")], [join(home, "ok"), "/"]]) {
    expect(await load(roots), roots.join()).toThrow(/must not (contain or be inside|be a project.s .claude)/);
  }
  // A project's config dir is never a root.
  await mkdir(join(base, "project", ".claude"), { recursive: true });
  expect(await load([join(base, "project", ".claude")])).toThrow(/\.claude/);
  // The CLI's user config dir is CLAUDE_CONFIG_DIR when set.
  expect(await load([join(base, "elsewhere")], { CLAUDE_CONFIG_DIR: join(base, "elsewhere", "claude-config") })).toThrow(/claude-config/);
  // Codex's home too: CODEX_HOME when set, else ~/.codex.
  expect(await load([join(home, ".codex")])).toThrow(/\.codex/);
  expect(await load([join(base, "elsewhere")], { CODEX_HOME: join(base, "elsewhere", "codex-home") })).toThrow(/codex-home/);
  // The state dir, where skill files go, is neither in a root nor in the machine's config.
  expect(await load([join(home, ".local")])).toThrow(/dispand-runner/);
  expect(await load([join(base, "elsewhere")], { XDG_STATE_HOME: join(base, "elsewhere", "state") })).toThrow(/state/);
  expect(await load([join(home, "dispand")], { XDG_STATE_HOME: join(home, ".claude") })).toThrow(/state dir/);
  expect(runnerStateDir({}, "/home/me")).toBe("/home/me/.local/state/dispand-runner");
  expect(runnerStateDir({ XDG_STATE_HOME: "relative" }, "/home/me")).toBe("/home/me/.local/state/dispand-runner");
});

test("a Read of ~/.codex/auth.json is denied, and a root inside ~/.codex is refused", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "codex-read-")));
  made.push(base);
  const home = join(base, "home");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), "{}");
  const cwd = join(base, "run");
  await mkdir(cwd);
  expect(permissionBoundary(cwd, home, {}).readDecision("Read", { file_path: join(home, ".codex", "auth.json") })).toBe("deny");
  const runnerConfig = join(home, ".config", "dispand-runner");
  await mkdir(runnerConfig, { recursive: true });
  await writeFile(join(runnerConfig, "config.json"), JSON.stringify({ server: "https://dispand.lan", roots: [join(home, ".codex", "runs")] }));
  expect(() => loadConfig(join(runnerConfig, "config.json"), {}, home)).toThrow(/\.codex/);
});

test("CODEX_HOME is made absolute and real once, and must exist", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "codex-home-")));
  made.push(base);
  await mkdir(join(base, "real"));
  await symlink(join(base, "real"), join(base, "link"));
  const env = codexEnv({ PATH: "/usr/bin", CODEX_HOME: relative(process.cwd(), join(base, "link")) });
  expect(env).toEqual({ PATH: "/usr/bin", CODEX_HOME: join(base, "real") });
  expect(machineConfigPaths("/cfg", env, "/home/me")).toContain(join(base, "real"));
  expect(codexEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  expect(machineConfigPaths("/cfg", {}, "/home/me")).toContain("/home/me/.codex");
  expect(() => codexEnv({ CODEX_HOME: "missing-codex-home" })).toThrow(/CODEX_HOME/);
});

describe("the token lives in config.json", () => {
  async function dir() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "token-")));
    made.push(base);
    return base;
  }
  const old = { server: "https://old.lan", roots: ["/srv/old"], allowBypass: false };

  test("pairing writes config and token as one file: a failed write leaves the old state whole", async () => {
    const base = await dir();
    const d = join(base, "config");
    await mkdir(d);
    await writeFile(join(d, "config.json"), JSON.stringify({ ...old, token: "old-token" }), { mode: 0o600 });
    const pairing = preparePairing(d, { server: "https://new.lan", roots: [join(base, "root")], allowBypass: false });
    // The directory turns read-only: the commit can't write.
    await chmod(d, 0o500);
    try {
      expect(() => pairing.commit("new-token", "runner_new")).toThrow();
    } finally {
      await chmod(d, 0o700);
    }
    expect(JSON.parse(await readFile(join(d, "config.json"), "utf8"))).toEqual({ ...old, token: "old-token" });
    pairing.commit("new-token", "runner_new");
    expect(JSON.parse(await readFile(join(d, "config.json"), "utf8"))).toMatchObject({ server: "https://new.lan", token: "new-token" });
    expect(loadToken(d)).toBe("new-token");
  });

  test("a separate token file from an older runner moves into config.json", async () => {
    const d = await dir();
    await writeFile(join(d, "config.json"), JSON.stringify(old), { mode: 0o644 });
    await writeFile(join(d, "token"), "legacy\n", { mode: 0o600 });
    expect(loadToken(d)).toBe("legacy");
    expect(JSON.parse(await readFile(join(d, "config.json"), "utf8"))).toEqual({ ...old, token: "legacy" });
    expect(((await stat(join(d, "config.json"))).mode & 0o777).toString(8)).toBe("600");
    await expect(stat(join(d, "token"))).rejects.toThrow();
    expect(loadToken(d)).toBe("legacy");
  });
});

describe("re-pairing: state is kept per runner id", () => {
  const files = ["state.json", "backlog.jsonl", "sessions.json"];
  async function paired(runnerId: string) {
    const base = await realpath(await mkdtemp(join(tmpdir(), "repair-")));
    made.push(base);
    const d = join(base, "config");
    await mkdir(join(d, "state", runnerId), { recursive: true });
    await writeFile(join(d, "config.json"), JSON.stringify({ server: "https://old.lan", roots: [join(base, "root")], allowBypass: false, token: "old", runnerId }), { mode: 0o600 });
    for (const f of files) await writeFile(join(d, "state", runnerId, f), "{}\n", { mode: 0o600 });
    return { base, d };
  }
  const exists = (p: string) => stat(p).then(() => true, () => false);

  test("a failed commit leaves the old pairing and its state in place, and in use", async () => {
    const { base, d } = await paired("runner_1");
    const pairing = preparePairing(d, { server: "https://new.lan", roots: [join(base, "root")], allowBypass: false });
    await chmod(d, 0o500);
    try {
      expect(() => pairing.commit("new", "runner_2")).toThrow();
    } finally {
      await chmod(d, 0o700);
    }
    expect(stateDir(d)).toBe(join(d, "state", "runner_1"));
    for (const f of files) expect(await exists(join(d, "state", "runner_1", f)), f).toBe(true);
  });

  test("a successful re-pair uses a new, empty state; the old one is removed", async () => {
    const { base, d } = await paired("runner_1");
    preparePairing(d, { server: "https://new.lan", roots: [join(base, "root")], allowBypass: false }).commit("new", "runner_2");
    expect(JSON.parse(await readFile(join(d, "config.json"), "utf8"))).toMatchObject({ server: "https://new.lan", runnerId: "runner_2" });
    const now = stateDir(d);
    expect(now).toBe(join(d, "state", "runner_2"));
    expect(await readdir(now)).toEqual([]);
    expect(await exists(join(d, "state", "runner_1"))).toBe(false);
  });

  test("the same pairing again keeps its state", async () => {
    const { base, d } = await paired("runner_1");
    preparePairing(d, { server: "https://old.lan", roots: [join(base, "root")], allowBypass: false }).commit("again", "runner_1");
    for (const f of files) expect(await exists(join(d, "state", "runner_1", f)), f).toBe(true);
  });

  test("state files from before move under the runner id, or are dropped without one", async () => {
    const { d } = await paired("runner_1");
    await rm(join(d, "state"), { recursive: true });
    for (const f of files) await writeFile(join(d, f), `${f}\n`);
    expect(stateDir(d)).toBe(join(d, "state", "runner_1"));
    for (const f of files) {
      expect(await readFile(join(d, "state", "runner_1", f), "utf8")).toBe(`${f}\n`);
      expect(await exists(join(d, f))).toBe(false);
    }
    const raw = JSON.parse(await readFile(join(d, "config.json"), "utf8")) as Record<string, unknown>;
    delete raw.runnerId;
    await writeFile(join(d, "config.json"), JSON.stringify(raw));
    for (const f of files) await writeFile(join(d, f), "old\n");
    expect(stateDir(d)).toBe(join(d, "state", "unpaired"));
    for (const f of files) expect(await exists(join(d, f))).toBe(false);
    expect(await readdir(join(d, "state", "unpaired"))).toEqual([]);
  });

  test("a runner id that isn't one path segment is refused", async () => {
    const { base, d } = await paired("runner_1");
    expect(() => preparePairing(d, { server: "https://old.lan", roots: [join(base, "root")], allowBypass: false }).commit("t", "../x")).toThrow();
  });
});

test("the machine's MCP servers: names as the protocol allows, never dispand, at most 100", async () => {
  const dir = await mkdtemp(join(tmpdir(), "config-"));
  made.push(dir);
  const path = join(dir, "config.json");
  const load = async (mcpServers: unknown) => {
    await writeFile(path, JSON.stringify({ server: "https://dispand.lan", roots: ["/srv/work"], mcpServers }));
    return () => loadConfig(path);
  };
  const fetch = { command: "uvx", args: ["mcp-server-fetch"] };
  expect((await load({ fetch, "brave-search": { command: "npx", env: { BRAVE_API_KEY: "k" } } }))().mcpServers).toEqual({
    fetch,
    "brave-search": { command: "npx", env: { BRAVE_API_KEY: "k" } },
  });
  expect(await load({ dispand: fetch })).toThrow(/reserved/);
  expect(await load({ "a b": fetch })).toThrow();
  expect(await load({ fetch: { command: "" } })).toThrow();
  // A field the runner wouldn't use is a mistake, not ignored.
  expect(await load({ fetch: { ...fetch, cwd: "/tmp" } })).toThrow();
  expect(await load(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`s${i}`, fetch])))).toThrow(/at most 100/);
});

test("Skillshare config, receipts and sources stay outside every runner root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-config-"));
  made.push(dir);
  await mkdir(join(dir, "runner"));
  const path = join(dir, "runner", "config.json");
  const env = { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_DATA_HOME: join(dir, "data") };
  const forbidden = machineConfigPaths(join(dir, "runner"), env, dir);
  for (const base of [env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_DATA_HOME]) {
    expect(forbidden).toContain(join(base, "skillshare"));
    await writeFile(path, JSON.stringify({ server: "https://dispand.test", roots: [join(base, "skillshare", "nested")] }));
    expect(() => loadConfig(path, env, dir)).toThrow(/skillshare/);
  }
});


test("runner executables including bundled Skillshare stay outside session roots", async () => {
  const path = await configWith("https://dispand.test");
  const packaged = machineConfigPaths("/cfg", {}, "/users/test").find((p) => p.endsWith("/dist/dispand-runner/"))!;
  expect(packaged).toBeTruthy();
  await writeFile(path, JSON.stringify({ server: "https://dispand.test", roots: [join(packaged, "bin")] }));
  expect(() => loadConfig(path)).toThrow(/dispand-runner/);
});
