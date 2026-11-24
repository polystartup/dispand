// One worker container per session: the CLI and every process it starts run there, never in
// the supervisor. The sandbox contract (SECURITY.md, runner section) is what this file keeps:
// non-root, read-only image, no capability, no network, only the conversation's own storage
// mounted, nothing of the supervisor's environment, and teardown confirmed by the runtime.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How a session starts its CLI: the machine's own `spawn`, or a worker's. */
export type Launch = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => ChildProcessWithoutNullStreams;

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
  /** Tests only: the network the worker joins (default `none`). Nothing the server sends can set it. */
  network?: string;
  /** Tests only: variables the worker gets on top of its own (a model double's address). */
  extraEnv?: Record<string, string>;
  docker?: string;
};

export type Worker = {
  /** The CLI home the conversation's transcripts live in (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` under it). */
  claudeConfigDir: string;
  codexHome: string;
  launch: Launch;
  /** A probe in this worker, under the same contract: the self-test's and the tests' checks, never a session's. */
  probe(argv: string[], env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
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
  async worker(workspace: string, cliHome: string): Promise<Worker> {
    const claudeConfigDir = join(cliHome, "claude");
    const codexHome = join(cliHome, "codex");
    await mkdir(claudeConfigDir, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    // A symlink anywhere on these paths would mount another folder: each must be its own real path.
    for (const dir of [workspace, claudeConfigDir, codexHome]) {
      if ((await realpath(dir)) !== dir) throw new Error(`${dir} can't be mounted into a worker: its path goes through a symlink`);
    }
    const name = `dispand-worker-${randomUUID()}`;
    const docker = this.options.docker ?? "docker";
    let launched = false;
    const start = (argv: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
      if (launched) throw new Error("a worker runs one process tree");
      launched = true;
      const passed = workerEnv(env);
      // The worker's own: paths, no secret, so on the command line.
      const own = { HOME: "/tmp", CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_HOME: codexHome, ...this.options.extraEnv };
      const flags = [
        "run", "-i", "--rm", "--name", name, "--label", `${WORKER_LABEL}=1`,
        "--runtime", this.options.runtime,
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", `${process.getuid!()}:${process.getgid!()}`,
        "--network", this.options.network ?? "none",
        "--tmpfs", "/tmp",
        "--mount", this.mount(workspace), "--mount", this.mount(cliHome),
        "--workdir", cwd,
        ...Object.entries(own).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        // The launch's: names only, each value comes from the docker client's environment, never from argv.
        ...Object.keys(passed).flatMap((key) => ["-e", key]),
        this.options.image, ...argv,
      ];
      const child = spawn(docker, flags, { env: { PATH: process.env.PATH, ...dockerEnv(), ...passed }, stdio: ["pipe", "pipe", "pipe"] });
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
    return { claudeConfigDir, codexHome, launch, probe, remove: () => this.removeContainer(docker, name) };
  }

  /** `--mount` for a folder of the state directory, at the same path; its source on the Docker host. */
  private mount(dir: string): string {
    const rel = relative(this.options.stateDir, dir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${dir} isn't inside the runner's state directory ${this.options.stateDir}`);
    // Each part is a `key=value` of a comma-separated list: a comma or quote would add options.
    if (/[,"=]/.test(dir)) throw new Error(`${dir} can't be mounted into a worker: its path holds , " or =`);
    const source = this.options.stateSource;
    return isAbsolute(source)
      ? `type=bind,src=${join(source, rel)},dst=${dir}`
      : `type=volume,src=${source},dst=${dir},volume-subpath=${rel}`;
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
