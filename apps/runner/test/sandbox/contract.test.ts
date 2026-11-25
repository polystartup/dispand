// The sandbox contract, checked on a real worker: run with DISPAND_SANDBOX_RUNTIME (runsc in
// CI's runner-sandbox job, runc to try it locally) and DISPAND_SANDBOX_IMAGE (the worker image).
import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Sandbox, workerEnv } from "../../src/sandbox/worker.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const run = promisify(execFile);

test("a worker gets only what the runner set, never the supervisor's own variables", () => {
  const inherited = { ANTHROPIC_API_KEY: "sk-inherited", PATH: "/usr/bin", SHARED: "same" };
  expect(workerEnv({ ...inherited, CLAUDE_CODE_ENTRYPOINT: "sdk-ts", SHARED: "same", HOME: "/root" }, inherited)).toEqual({ CLAUDE_CODE_ENTRYPOINT: "sdk-ts" });
});

test("a folder outside the state directory, or with mount syntax in its path, is never mounted", async () => {
  const sandbox = new Sandbox({ owner: `test-${process.pid}`, image: "w", runtime: "runc", stateDir: "/state", stateSource: "/state" });
  await sandbox.sweep();
  await expect(sandbox.worker("/elsewhere/run", "/state/cli/k")).rejects.toThrow();
  const base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-")));
  try {
    const odd = new Sandbox({ owner: `test-${process.pid}`, image: "w", runtime: "runc", stateDir: base, stateSource: base, network: "none" });
    await odd.sweep();
    await mkdir(join(base, "runs", "a,readonly=false"), { recursive: true });
    const worker = await odd.worker(join(base, "runs", "a,readonly=false"), join(base, "cli", "k"));
    expect(() => worker.probe(["true"])).toThrow("can't be mounted");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a conversation's native plugins are mounted read-only at their own paths, and nothing else of the store", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-")));
  try {
    const sandbox = new Sandbox({ owner: `test-${process.pid}`, image: "w", runtime: "runc", stateDir: base, stateSource: base, network: "none" });
    await sandbox.sweep();
    await mkdir(join(base, "runs", "k"), { recursive: true });
    await mkdir(join(base, "native-plugins", "aaa"), { recursive: true });
    await mkdir(join(base, "native-plugins", "bbb"), { recursive: true });
    const worker = await sandbox.worker(join(base, "runs", "k"), join(base, "cli", "k"), [], { plugins: [{ pluginId: "plugin_a", dir: join(base, "native-plugins", "aaa") }] });
    const mounts = worker.command(["true"], join(base, "runs", "k"), {}).args.filter((a) => a.includes("native-plugins"));
    expect(mounts).toEqual([`type=bind,src=${join(base, "native-plugins", "aaa")},dst=/run/plugins/plugin_a,readonly`]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a folder whose path goes through a symlink is never mounted", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-")));
  try {
    const sandbox = new Sandbox({ owner: `test-${process.pid}`, image: "w", runtime: "runc", stateDir: base, stateSource: base });
    await sandbox.sweep();
    await mkdir(join(base, "root", "runs", "k"), { recursive: true });
    await mkdir(join(base, "elsewhere"));
    // The conversations' CLI homes, pointed at another folder.
    await symlink(join(base, "elsewhere"), join(base, "root", "cli"));
    await expect(sandbox.worker(join(base, "root", "runs", "k"), join(base, "root", "cli", "k"))).rejects.toThrow("symlink");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a launch's variables reach the container through a file, never the docker client's environment or argv", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-")));
  try {
    const sandbox = new Sandbox({ owner: `test-${process.pid}`, image: "w", runtime: "runc", stateDir: base, stateSource: base, network: "none" });
    await sandbox.sweep();
    await mkdir(join(base, "runs", "k"), { recursive: true });
    const worker = await sandbox.worker(join(base, "runs", "k"), join(base, "cli", "k"));
    const run = worker.command(["node", "server.js"], join(base, "runs", "k"), { LD_PRELOAD: "/plugin/evil.so", PLUGIN_TOKEN: "s3cret" });
    expect(Object.keys(run.env).filter((k) => k === "LD_PRELOAD" || k === "PLUGIN_TOKEN")).toEqual([]);
    expect(run.args.join(" ")).not.toContain("s3cret");
    const file = run.args[run.args.indexOf("--env-file") + 1]!;
    expect(await readFile(file, "utf8")).toBe("LD_PRELOAD=/plugin/evil.so\nPLUGIN_TOKEN=s3cret\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("no worker starts before the previous run's workers are cleared, nor when clearing them failed", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-")));
  try {
    await mkdir(join(base, "runs", "k"), { recursive: true });
    const unswept = new Sandbox({ owner: `test-${process.pid}`, image: "w", runtime: "runc", stateDir: base, stateSource: base, network: "none" });
    await expect(unswept.worker(join(base, "runs", "k"), join(base, "cli", "k"))).rejects.toThrow("hasn't cleared");
    const failed = new Sandbox({ owner: `test-${process.pid}`, image: "w", runtime: "runc", stateDir: base, stateSource: base, network: "none", docker: "/nonexistent/docker" });
    await failed.sweep().catch(() => undefined);
    await expect(failed.worker(join(base, "runs", "k"), join(base, "cli", "k"))).rejects.toThrow("couldn't clear");
    // Starts that meet one failure share its retry, while it runs: a second sweep could remove a worker the first let start.
    const slow = join(base, "slow-docker");
    await writeFile(slow, "#!/bin/sh\nsleep 1\nexit 1\n", { mode: 0o755 });
    const flaky = new Sandbox({ owner: `test-${process.pid}`, image: "w", runtime: "runc", stateDir: base, stateSource: base, network: "none", docker: slow });
    await flaky.sweep().catch(() => undefined);
    let running = 0;
    let most = 0;
    const sweep = flaky.sweep.bind(flaky);
    flaky.sweep = () => {
      most = Math.max(most, ++running);
      const swept = sweep();
      swept.finally(() => running--).catch(() => undefined);
      return swept;
    };
    await Promise.all([1, 2, 3].map(() => flaky.worker(join(base, "runs", "k"), join(base, "cli", "k")).catch(() => undefined)));
    // Never two at once: each failure is tried again once, by whichever start sees it first.
    expect(most).toBe(1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

describe.skipIf(!RUNTIME)(`contract on ${RUNTIME}`, () => {
  let state: SandboxState;
  let base: string;
  let sandbox: Sandbox;
  const output = (child: ChildProcessWithoutNullStreams) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d));
      child.stderr.on("data", (d: Buffer) => (out += d));
      child.on("exit", (code) => resolve({ code, out }));
    });

  beforeAll(async () => {
    state = await sandboxState();
    base = state.base;
    // No network at all: its route through the supervisor is egress.test.ts's.
    sandbox = new Sandbox({ owner: `test-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: "none" });
    await sandbox.sweep();
    // What a worker must never see: the runner's config and another conversation's folder.
    await writeFile(join(base, "config.json"), "{\"token\":\"secret\"}");
    await mkdir(join(base, "root", "runs", "other"), { recursive: true });
    await writeFile(join(base, "root", "runs", "other", "notes.txt"), "other");
  });
  afterAll(() => state.done());

  const folders = async (key: string) => {
    const workspace = join(base, "root", "runs", key);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    return { workspace, cliHome: join(base, "root", "cli", key) };
  };

  test("non-root, read-only image, no capability, no network, only its own storage and its own variables", async () => {
    const { workspace, cliHome } = await folders("contract");
    const worker = await sandbox.worker(workspace, cliHome);
    const script = `
      echo uid=$(id -u)
      echo caps=$(awk '/CapEff/{print $2}' /proc/self/status)
      echo nnp=$(awk '/NoNewPrivs/{print $2}' /proc/self/status)
      for p in /etc /usr /opt /var "${workspace}" /run/cli/claude /run/cli/codex /run/cli/claude/projects /run/cli/codex/sessions; do
        if touch "$p/.w" 2>/dev/null; then echo "write:$p=yes"; rm -f "$p/.w"; else echo "write:$p=no"; fi
      done
      echo config=$(test -e "${base}/config.json" && echo seen || echo hidden)
      echo other=$(test -e "${base}/root/runs/other" && echo seen || echo hidden)
      echo socket=$(test -e /var/run/docker.sock && echo seen || echo hidden)
      echo net=$(node -e "console.log(Object.keys(require('os').networkInterfaces()).filter((n) => n !== 'lo').join('+') || 'none')")
      echo key=\${ANTHROPIC_API_KEY:-none} mark=\${DISPAND_TEST_MARK:-none}`;
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-supervisor");
    const { code, out } = await output(worker.probe(["sh", "-c", script], { ...process.env, DISPAND_TEST_MARK: "set-by-runner" }));
    vi.unstubAllEnvs();
    await worker.remove();
    expect(code, out).toBe(0);
    const lines = Object.fromEntries(out.trim().split(/\s+/).map((l) => l.split("=") as [string, string]));
    expect(lines.uid).toBe(String(process.getuid!()));
    expect(lines.uid).not.toBe("0");
    expect(lines.caps).toBe("0000000000000000");
    expect(lines.nnp).toBe("1");
    expect(lines).toMatchObject({ "write:/etc": "no", "write:/usr": "no", "write:/opt": "no", "write:/var": "no" });
    expect(lines).toMatchObject({ [`write:${workspace}`]: "yes", "write:/run/cli/claude": "yes", "write:/run/cli/codex": "yes", "write:/run/cli/claude/projects": "yes", "write:/run/cli/codex/sessions": "yes" });
    expect(lines).toMatchObject({ config: "hidden", other: "hidden", socket: "hidden", net: "none", key: "none", mark: "set-by-runner" });
  });

  test("teardown ends the whole process tree, a child in its own session included", async () => {
    const { workspace, cliHome } = await folders("teardown");
    const worker = await sandbox.worker(workspace, cliHome);
    const beat = join(workspace, "beat");
    const child = worker.probe(["sh", "-c", `setsid sh -c 'while true; do date +%s%N > "${beat}"; sleep 0.1; done' & sleep 1000`]);
    await vi.waitFor(() => readFile(beat, "utf8"), { timeout: 30_000, interval: 200 });
    await worker.remove();
    const after = await readFile(beat, "utf8");
    await new Promise((r) => setTimeout(r, 1000));
    expect(await readFile(beat, "utf8")).toBe(after);
    child.kill();
  });

  test.skipIf(!process.env.DISPAND_SANDBOX_COLD_IMAGE)("a first launch pulls the worker image by digest on a daemon that hasn't got it", async () => {
    const image = process.env.DISPAND_SANDBOX_COLD_IMAGE!;
    await run("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    const cold = new Sandbox({ owner: `test-${process.pid}`, image, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: "none" });
    await cold.sweep();
    const { workspace, cliHome } = await folders("cold");
    const worker = await cold.worker(workspace, cliHome);
    const { code, out } = await output(worker.probe(["claude", "--version"]));
    await worker.remove();
    expect(code, out).toBe(0);
    expect(out).toContain("Claude Code");
  });
});
