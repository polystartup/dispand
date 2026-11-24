// One worker container per session: the CLI and every process it starts run there, never in
// the supervisor. The sandbox contract (SECURITY.md, runner section) is what this file keeps:
// non-root, read-only image, no capability, no network, only the conversation's own storage
// mounted, nothing of the supervisor's environment, and teardown confirmed by the runtime.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { checkDestination, type EgressOptions, guardedFetch, type ModelKeys, openEgress } from "./egress.ts";

const run = promisify(execFile);

/** How a session starts its CLI: the machine's own `spawn`, or a worker's. */
export type Launch = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => ChildProcessWithoutNullStreams;

/** The Agent SDK's spawn option for a launch: the CLI runs where `launch` starts it, in `cwd` unless the SDK names one. */
export function spawnIn(launch: Launch | undefined, cwd: string) {
  return launch ? { spawnClaudeCodeProcess: ({ command, args, cwd: at, env, signal }: { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal }) => launch(command, args, { cwd: at ?? cwd, env, signal }) } : {};
}

/** The CLIs a worker runs, by the name they have on its PATH. */
const CLIS = new Set(["claude", "codex"]);
/** Set by the worker itself, never taken from the launch. */
const OWN = new Set(["HOME", "PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"]);
/** Every worker carries it: A4 finds what a previous run left behind by it. */
export const WORKER_LABEL = "dispand.runner.worker";

export type SandboxOptions = {
  /** The worker image, by digest (`DISPAND_WORKER_IMAGE`). */
  image: string;
  /** The OCI runtime each launch names (`runsc`): a missing one fails the launch, never downgrades it. */
  runtime: string;
  /** The supervisor's state directory: every mounted folder is inside it, at the same path in the worker. */
  stateDir: string;
  /**
   * Where `stateDir` comes from on the Docker host: the named volume mounted there (`dispand-runner`),
   * or the host's absolute path for a bind mount. The supervisor's local config, never the server's.
   */
  stateSource: string;
  /** The runner's model keys (D1): the supervisor sends them on the worker's model operations, never to the worker. */
  keys?: ModelKeys;
  /** The host's own addresses (`DISPAND_HOST_ADDRESSES`): a supervisor in a container can't see them. */
  hostAddresses?: string[];
  /** Tests only: an existing network instead of the worker's own route through the supervisor. */
  network?: string;
  /** Tests only: where each provider's operations go. */
  origins?: EgressOptions["origins"];
  /** Tests only: variables the worker gets on top of its own (a model double's address). */
  extraEnv?: Record<string, string>;
  docker?: string;
};

export type Worker = {
  /** The CLI home the conversation's transcripts live in (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` under it). */
  claudeConfigDir: string;
  codexHome: string;
  launch: Launch;
  /** Codex's provider base URL through the supervisor, when the runner has an OpenAI key. */
  openaiBaseUrl?: string;
  /** A probe in this worker, under the same contract: the self-test's and the tests' checks, never a session's. */
  probe(argv: string[], env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
  /** The `docker run` that starts `argv` in this worker, for a caller that starts it itself (a plugin's stdio server). */
  command(argv: string[], cwd: string, env: NodeJS.ProcessEnv): { command: string; args: string[]; env: Record<string, string> };
  /** Removes the container and waits until the runtime says it is gone, with every process it held. */
  remove(): Promise<void>;
};

export class Sandbox {
  private readonly options: SandboxOptions;

  constructor(options: SandboxOptions) {
    this.options = options;
    const uid = process.getuid?.() ?? 0;
    // The worker runs as the supervisor's own user, which owns the folders it mounts: never root.
    if (uid === 0) throw new Error("the runner's supervisor must not run as root: its workers run as its user");
  }

  /** A worker for one session: `workspace` is its run folder, `cliHome` its transcripts' folder. */
  async worker(workspace: string, cliHome: string, readOnly: string[] = [], { model = true }: { model?: boolean } = {}): Promise<Worker> {
    const claudeConfigDir = join(cliHome, "claude");
    const codexHome = join(cliHome, "codex");
    await mkdir(claudeConfigDir, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    // A symlink anywhere on these paths would mount another folder: each must be its own real path.
    for (const dir of [workspace, claudeConfigDir, codexHome, ...readOnly]) {
      if ((await realpath(dir)) !== dir) throw new Error(`${dir} can't be mounted into a worker: its path goes through a symlink`);
    }
    const name = `dispand-worker-${randomUUID()}`;
    const docker = this.options.docker ?? "docker";
    const hostState = await this.hostState(docker);
    // Its only route: the supervisor, on a network of its own (none when a test names one).
    const egress = this.options.network ? undefined : await openEgress({
      network: name, keys: model ? this.options.keys ?? {} : {}, hostAddresses: this.options.hostAddresses ?? [],
      ...(this.options.origins ? { origins: this.options.origins } : {}), ...(this.options.docker ? { docker: this.options.docker } : {}),
    });
    let launched = false;
    let envDir: string | undefined;
    const command = (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => {
      if (launched) throw new Error("a worker runs one process tree");
      launched = true;
      const passed = workerEnv(env);
      // The launch's variables reach the container through a file of the supervisor's own (0600):
      // never on argv, and never in the docker client's environment, which holds the socket.
      if (Object.values(passed).some((value) => value.includes("\n"))) throw new Error("a worker's variable can't hold a line break");
      envDir = mkdtempSync(join(tmpdir(), "dispand-worker-env-"));
      const envFile = join(envDir, "env");
      writeFileSync(envFile, Object.entries(passed).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
      // The worker's own: paths, no secret, so on the command line.
      const own = { HOME: "/tmp", CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_HOME: codexHome, ...egress?.env, ...this.options.extraEnv };
      const flags = [
        "run", "-i", "--rm", "--name", name, "--label", `${WORKER_LABEL}=1`,
        "--runtime", this.options.runtime,
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", `${process.getuid!()}:${process.getgid!()}`,
        "--network", this.options.network ?? name,
        "--tmpfs", "/tmp",
        "--mount", this.mount(workspace, hostState), "--mount", this.mount(cliHome, hostState),
        ...readOnly.flatMap((dir) => ["--mount", `${this.mount(dir, hostState)},readonly`]),
        "--workdir", cwd,
        "--env-file", envFile,
        // The worker's own, last: no launch variable replaces its route or paths.
        ...Object.entries(own).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        this.options.image, ...argv,
      ];
      return { command: docker, args: flags, env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...dockerEnv() } };
    };
    const start = (argv: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
      const run = command(argv, cwd, env);
      const child = spawn(run.command, run.args, { env: run.env, stdio: ["pipe", "pipe", "pipe"] });
      // The session's end confirms the removal (and retries it): this one only starts it sooner.
      signal?.addEventListener("abort", () => void this.removeContainer(docker, name).catch(() => undefined), { once: true });
      return child;
    };
    const launch: Launch = (command, args, { cwd, env, signal }) => {
      const cli = basename(command);
      if (!CLIS.has(cli)) throw new Error(`a worker runs only claude or codex, not ${cli}`);
      return start([cli, ...args], cwd, env, signal);
    };
    const probe = (argv: string[], env: NodeJS.ProcessEnv = {}) => start(argv, workspace, env);
    const openaiBaseUrl = egress?.baseUrl("openai");
    return {
      claudeConfigDir, codexHome, launch, probe, command, ...(openaiBaseUrl ? { openaiBaseUrl } : {}),
      // The route closes only after the runtime confirms the worker is gone.
      remove: async () => {
        await this.removeContainer(docker, name);
        await egress?.close();
        if (envDir) rmSync(envDir, { recursive: true, force: true });
      },
    };
  }

  /** A tool URL the supervisor would connect to: refused as a worker's CONNECT would be, then fetched only through checked sockets. */
  async fetchFor(url: URL): Promise<typeof fetch> {
    await checkDestination(url, this.options.hostAddresses ?? []);
    return guardedFetch(this.options.hostAddresses ?? []);
  }

  /** `--mount` binding a folder of the state directory, at the same path, from `hostState`, the state's folder on the Docker host. */
  private mount(dir: string, hostState: string): string {
    const rel = relative(this.options.stateDir, dir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${dir} isn't inside the runner's state directory ${this.options.stateDir}`);
    // Each part is a `key=value` of a comma-separated list: a comma or quote would add options.
    if (/[,"=]/.test(dir) || /[,"=]/.test(hostState)) throw new Error(`${dir} can't be mounted into a worker: its path holds , " or =`);
    return `type=bind,src=${join(hostState, rel)},dst=${dir}`;
  }

  /**
   * The state's folder on the Docker host, read at each worker: a bind mount's own path, or the
   * named volume's. A folder of it is then bound, never the volume (`volume-subpath` is ignored
   * by older engines, which would mount the whole state, and its root isn't writable under gVisor).
   */
  private async hostState(docker: string): Promise<string> {
    const source = this.options.stateSource;
    if (isAbsolute(source)) return source;
    const { stdout } = await run(docker, ["volume", "inspect", "-f", "{{.Mountpoint}}", source], { env: { PATH: process.env.PATH, ...dockerEnv() } });
    const path = stdout.trim();
    if (!isAbsolute(path)) throw new Error(`the state volume ${source} has no folder on the Docker host`);
    return path;
  }

  private async removeContainer(docker: string, name: string): Promise<void> {
    const env = { PATH: process.env.PATH, ...dockerEnv() };
    await run(docker, ["rm", "-f", name], { env }).catch(() => undefined);
    for (let i = 0; i < 300; i++) {
      const gone = await run(docker, ["container", "inspect", name], { env }).then(() => false, (err: { stderr?: string }) => /no such (container|object)/i.test(err.stderr ?? ""));
      if (gone) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the worker ${name} is still there after 30 s`);
  }
}

/**
 * What the worker gets of a launch's environment: only what the runner set itself (a value
 * the supervisor didn't inherit), never the supervisor's own variables (its keys, tokens,
 * paths), nor what the worker sets itself.
 */
export function workerEnv(env: NodeJS.ProcessEnv, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || OWN.has(key) || inherited[key] === value) continue;
    out[key] = value;
  }
  return out;
}

/** The docker client's own settings, from the supervisor's environment: which daemon, which config. */
function dockerEnv(): Record<string, string> {
  return Object.fromEntries(["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "HOME"].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
}
