// One worker container per session: the CLI and every process it starts run there, never in
// the supervisor. The sandbox contract (SECURITY.md, runner section) is what this file keeps:
// non-root, read-only image, no capability, no network, only the conversation's own storage
// mounted, nothing of the supervisor's environment, and teardown confirmed by the runtime.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { checkDestination, type EgressOptions, guardedFetch, type HostAddresses, hostAddressesFrom, OWNER_LABEL, selfContainer, type ModelKeys, openEgress } from "./egress.ts";

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
/**
 * The self-test's network checks, from inside a worker: metadata directly, metadata through its
 * route (refused), and each of the host's addresses given as arguments (`host:port`).
 */
const ROUTE_CHECK = `
const net = require("node:net");
const tryConnect = (host, port) => new Promise((done) => { const s = net.connect({ host, port, timeout: 3000 }); const end = (v) => { s.destroy(); done(v); }; s.once("connect", () => end(true)); s.once("timeout", () => end(false)); s.once("error", () => end(false)); });
(async () => {
  if (!(await tryConnect("169.254.169.254", 80))) console.log("pass:no-direct-metadata");
  const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : undefined;
  if (proxy) {
    const status = await new Promise((done) => { const s = net.connect(Number(proxy.port), proxy.hostname, () => s.write("CONNECT 169.254.169.254:80 HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n")); let a = ""; s.on("data", (d) => { a += d; if (a.includes("\\r\\n")) { s.destroy(); done(a.split(" ")[1]); } }); s.on("error", () => done("")); s.setTimeout(5000, () => { s.destroy(); done(""); }); });
    if (status === "403") console.log("pass:metadata-refused-by-the-route");
  }
  let reached = false;
  for (const target of process.argv.slice(1)) { const i = target.lastIndexOf(":"); if (await tryConnect(target.slice(0, i), Number(target.slice(i + 1)))) reached = true; }
  if (!reached) console.log("pass:no-host");
})();`.replace(/'/g, "'\\''");

/**
 * Whether this host runs gVisor: registered with Docker, and a probe actually runs under it.
 * Otherwise runc, whose sessions are only the verified ones (`verified.ts`).
 */
export async function detectRuntime(image: string, docker = "docker"): Promise<"runsc" | "runc"> {
  const env = { PATH: process.env.PATH, ...dockerEnv() };
  const runtimes = await run(docker, ["info", "--format", "{{json .Runtimes}}"], { env }).then(({ stdout }) => JSON.parse(stdout || "{}") as Record<string, unknown>, () => ({}));
  if (!Object.hasOwn(runtimes, "runsc")) return "runc";
  const runs = await run(docker, ["run", "--rm", "--runtime", "runsc", "--network", "none", "--read-only", image, "true"], { env }).then(() => true, () => false);
  return runs ? "runsc" : "runc";
}

/** Every worker carries it. */
export const WORKER_LABEL = "dispand.runner.worker";
/** Each CLI's home in a worker: a tmpfs of its own at each launch, with only its transcripts bound in. */
export const CLI_HOMES = { claude: "/run/cli/claude", codex: "/run/cli/codex" } as const;

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
  /**
   * Extra host addresses (`DISPAND_HOST_ADDRESSES`), on top of those a helper on the host's
   * network reads at each check: needed only where Docker's network isn't the machine's.
   */
  hostAddresses?: string[];
  /** Tests only: an existing network instead of the worker's own route through the supervisor. */
  network?: string;
  /** Tests only: where each provider's operations go. */
  origins?: EgressOptions["origins"];
  /** Tests only: variables the worker gets on top of its own (a model double's address). */
  extraEnv?: Record<string, string>;
  /** Tests only: Codex's model base URL when no route is opened (a model double's address). */
  openaiBaseUrl?: string;
  /** Tests only: the supervisor its workers belong to; otherwise the id kept in its state (`owner()`). */
  owner?: string;
  docker?: string;
};

export type Worker = {
  /** The CLI home the conversation's transcripts live in (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` under it). */
  claudeConfigDir: string;
  codexHome: string;
  launch: Launch;
  /** Codex's provider base URL through the supervisor, when the runner has an OpenAI key. */
  openaiBaseUrl?: string;
  /** A personal worker's one model transport: its grant's relay on the supervisor. */
  relayUrl?: string;
  /** A probe in this worker, under the same contract: the self-test's and the tests' checks, never a session's. */
  probe(argv: string[], env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
  /** The `docker run` that starts `argv` in this worker, for a caller that starts it itself (a plugin's stdio server). */
  command(argv: string[], cwd: string, env: NodeJS.ProcessEnv): { command: string; args: string[]; env: Record<string, string> };
  /** Removes the container and waits until the runtime says it is gone, with every process it held. */
  remove(): Promise<void>;
};

/** Where a worker finds each of its conversation's native plugins: `<this>/<plugin id>`, read-only. */
export const NATIVE_PLUGINS = "/run/plugins";

export class Sandbox {
  private readonly options: SandboxOptions;

  constructor(options: SandboxOptions) {
    this.options = options;
    const uid = process.getuid?.() ?? 0;
    // The worker runs as the supervisor's own user, which owns the folders it mounts: never root.
    if (uid === 0) throw new Error("the runner's supervisor must not run as root: its workers run as its user");
  }

  /**
   * A worker for one session: `workspace` is its run folder, `cliHome` its transcripts' folder.
   * `relay`: a personal worker, whose only route is that relay (no proxy, none of the runner's keys).
   */
  async worker(workspace: string, cliHome: string, readOnly: string[] = [], { model = true, relay, plugins = [] }: { model?: boolean; relay?: (req: IncomingMessage, res: ServerResponse) => void; plugins?: { pluginId: string; dir: string }[] } = {}): Promise<Worker> {
    if (relay && this.options.network) throw new Error("a personal worker needs its own route to its relay");
    // A fresh CLI home at each launch (nothing restored loads as settings, hooks or plugins);
    // only each CLI's transcripts are kept, in the conversation's storage.
    const claudeConfigDir = CLI_HOMES.claude;
    const codexHome = CLI_HOMES.codex;
    const transcripts = { claude: join(cliHome, "claude-projects"), codex: join(cliHome, "codex-sessions") };
    await mkdir(transcripts.claude, { recursive: true, mode: 0o700 });
    await mkdir(transcripts.codex, { recursive: true, mode: 0o700 });
    // A symlink anywhere on these paths would mount another folder: each must be its own real path.
    for (const dir of [workspace, transcripts.claude, transcripts.codex, ...readOnly, ...plugins.map((p) => p.dir)]) {
      if ((await realpath(dir)) !== dir) throw new Error(`${dir} can't be mounted into a worker: its path goes through a symlink`);
    }
    const name = `dispand-worker-${randomUUID()}`;
    const docker = this.options.docker ?? "docker";
    const hostState = await this.hostState(docker);
    // Its only route: the supervisor, on a network of its own (none when a test names one).
    // No conversation's storage is attached before what a previous run left is confirmed gone.
    if (!this.swept) throw new Error("the runner hasn't cleared the workers of its previous run: no worker starts");
    // A failed sweep (Docker down at start) is tried again here: checked at use, never kept failed.
    // One retry per failure, which every start waits for: a second one could sweep a worker the first let start.
    const seen = this.swept;
    const cleared = await seen.then(() => true, () => {
      if (this.swept === seen) void this.sweep();
      return this.swept!.then(() => true, () => false);
    });
    if (!cleared) throw new Error("the runner couldn't clear the workers of its previous run: no worker starts");
    const owner = await this.owner();
    const egress = this.options.network ? undefined : await openEgress({
      network: name, owner, keys: model && !relay ? this.options.keys ?? {} : {}, hostAddresses: this.hostAddresses(), ...(relay ? { relay } : {}),
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
        "run", "-i", "--rm", "--name", name, "--label", `${WORKER_LABEL}=1`, "--label", `${OWNER_LABEL}=${owner}`,
        "--runtime", this.options.runtime,
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", `${process.getuid!()}:${process.getgid!()}`,
        "--network", this.options.network ?? name,
        "--tmpfs", "/tmp",
        ...Object.values(CLI_HOMES).flatMap((dst) => ["--mount", `type=tmpfs,dst=${dst},tmpfs-mode=1777`]),
        "--mount", this.mount(workspace, hostState),
        "--mount", this.mount(transcripts.claude, hostState, `${CLI_HOMES.claude}/projects`),
        "--mount", this.mount(transcripts.codex, hostState, `${CLI_HOMES.codex}/sessions`),
        ...readOnly.flatMap((dir) => ["--mount", `${this.mount(dir, hostState)},readonly`]),
        // The conversation's native plugins, each read-only at a fixed path: nothing else of the store.
        ...plugins.flatMap(({ pluginId, dir }) => ["--mount", `${this.mount(dir, hostState, `${NATIVE_PLUGINS}/${pluginId}`)},readonly`]),
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
    const openaiBaseUrl = egress?.baseUrl("openai") ?? (egress ? undefined : this.options.openaiBaseUrl);
    return {
      claudeConfigDir, codexHome, launch, probe, command, ...(openaiBaseUrl ? { openaiBaseUrl } : {}), ...(relay && egress ? { relayUrl: egress.origin } : {}),
      // The route closes only after the runtime confirms the worker is gone.
      remove: async () => {
        await this.removeContainer(docker, name);
        await egress?.close();
        if (envDir) rmSync(envDir, { recursive: true, force: true });
      },
    };
  }

  /** The runtime every launch names: a missing one fails the launch, never downgrades it. */
  get runtime(): string {
    return this.options.runtime;
  }

  /**
   * The sandbox contract's host-dependent checks, on this host, from a probe worker on its own
   * route: the names of those that fail (none: the host gives what it seems to). `config` is the
   * runner's config file, which no worker may see.
   */
  async selfTest(workspace: string, cliHome: string, config: string): Promise<string[]> {
    // The host's addresses now; if they can't be read, every check refuses, and the self-test says so.
    const hosts = await this.hostAddresses()().then((list) => list.map((a) => `${a}:22`), () => undefined);
    if (!hosts) return ["host-addresses"];
    const script = `
      [ "$(id -u)" != 0 ] && echo pass:non-root
      [ "$(awk '/CapEff/{print $2}' /proc/self/status)" = 0000000000000000 ] && echo pass:no-capability
      [ "$(awk '/NoNewPrivs/{print $2}' /proc/self/status)" = 1 ] && echo pass:no-new-privileges
      touch /etc/.w 2>/dev/null || echo pass:read-only-image
      [ ! -e "${config}" ] && echo pass:no-runner-config
      [ ! -e /var/run/docker.sock ] && echo pass:no-docker-socket
      node -e '${ROUTE_CHECK}' ${hosts.join(" ")}`;
    const expected = ["non-root", "no-capability", "no-new-privileges", "read-only-image", "no-runner-config", "no-docker-socket", "no-direct-metadata", "metadata-refused-by-the-route", "no-host"];
    let out = "";
    let worker: Worker | undefined;
    try {
      worker = await this.worker(workspace, cliHome);
      const child = worker.probe(["sh", "-c", script]);
      child.stdout.on("data", (d: Buffer) => (out += d));
      child.stderr.resume();
      await new Promise((resolve) => child.once("exit", resolve));
    } catch {
      return ["probe-worker"];
    } finally {
      await worker?.remove().catch(() => undefined);
    }
    const passed = new Set([...out.matchAll(/^pass:(\S+)$/gm)].map((m) => m[1]));
    return expected.filter((check) => !passed.has(check));
  }

  /** A tool URL the supervisor would connect to: refused as a worker's CONNECT would be, then fetched only through checked sockets. */
  async fetchFor(url: URL): Promise<typeof fetch> {
    await checkDestination(url, this.hostAddresses());
    return guardedFetch(this.hostAddresses());
  }

  private hosts: HostAddresses | undefined;

  /** The host's own addresses, read at each check by one helper this sandbox starts when first asked. */
  private hostAddresses(): HostAddresses {
    this.hosts ??= hostAddressesFrom({ image: this.options.image, owner: () => this.owner(), fixed: this.options.hostAddresses ?? [], ...(this.options.docker ? { docker: this.options.docker } : {}) });
    return this.hosts;
  }

  /**
   * Removes every worker and network a previous run of this supervisor left, and returns once
   * the runtime confirms each is gone: until then, no conversation's storage is attached again.
   */
  sweep(): Promise<number> {
    this.swept = this.clear();
    return this.swept;
  }

  private swept: Promise<number> | undefined;

  /**
   * Which supervisor its workers and networks belong to: an id kept in its state, so a replaced
   * supervisor on the same state finds what its previous container left, and another
   * supervisor (another state) never takes it.
   */
  private async owner(): Promise<string> {
    if (this.options.owner) return this.options.owner;
    const path = join(this.options.stateDir, ".supervisor-id");
    // Created once, exclusively; one that isn't an id stops every worker (its workers couldn't be swept).
    await writeFile(path, `${randomUUID()}\n`, { mode: 0o600, flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    const id = (await readFile(path, "utf8")).trim();
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`${path} isn't a supervisor id: no worker starts until it is fixed or removed`);
    return id;
  }

  private async clear(): Promise<number> {
    const docker = this.options.docker ?? "docker";
    const env = { PATH: process.env.PATH, ...dockerEnv() };
    const owner = await this.owner();
    const filter = ["--filter", `label=${OWNER_LABEL}=${owner}`];
    const ids = (await run(docker, ["ps", "-aq", ...filter], { env })).stdout.split("\n").filter(Boolean);
    for (const id of ids) await this.removeContainer(docker, id);
    for (const net of (await run(docker, ["network", "ls", "-q", ...filter], { env })).stdout.split("\n").filter(Boolean)) {
      if (!this.options.owner) await run(docker, ["network", "disconnect", "-f", net, await selfContainer()], { env }).catch(() => undefined);
      await run(docker, ["network", "rm", net], { env });
    }
    return ids.length;
  }

  /** `--mount` binding a folder of the state directory from `hostState`, the state's folder on the Docker host, at `dst` (its own path by default). */
  private mount(dir: string, hostState: string, dst = dir): string {
    const rel = relative(this.options.stateDir, dir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${dir} isn't inside the runner's state directory ${this.options.stateDir}`);
    // Each part is a `key=value` of a comma-separated list: a comma or quote would add options.
    if (/[,"=]/.test(dir) || /[,"=]/.test(hostState)) throw new Error(`${dir} can't be mounted into a worker: its path holds , " or =`);
    return `type=bind,src=${join(hostState, rel)},dst=${dst}`;
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
