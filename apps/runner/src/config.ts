import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { McpServerName } from "@dispand/runner-protocol";
import { z } from "zod";
import { inside, isConfigPath, realOf } from "./boundary.ts";
import { moveDurable, writeDurable } from "./durable.ts";

const HTTPS_ONLY = "the server must use https (plain http only on localhost, 127.0.0.0/8 or ::1)";

/** The token goes out with every connection: plain http only to this machine. */
function isAllowedServer(server: string): boolean {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  const host = url.hostname;
  return url.protocol === "http:" && (host === "localhost" || host === "[::1]" || (isIPv4(host) && host.startsWith("127.")));
}

/** The server URL without trailing slashes; throws unless it passes `isAllowedServer`. */
export function serverUrl(server: string): string {
  if (!isAllowedServer(server)) throw new Error(HTTPS_ONLY);
  return server.replace(/\/+$/, "");
}

/**
 * The machine's own rules for the runner, edited on the machine only: the server never changes
 * them. Sessions may only work under `roots`, and `bypassPermissions` needs `allowBypass`.
 */
const RunnerConfig = z.object({
  server: z.string().refine(isAllowedServer, HTTPS_ONLY),
  roots: z.array(z.string().refine(isAbsolute, "must be an absolute path")).min(1),
  allowBypass: z.boolean().default(false),
  /** The runner's token, in the same file so pairing writes both at once (mode 0600). */
  token: z.string().min(1).optional(),
  /** Which runner this machine is paired as: its state lives in `state/<runnerId>/`. One path segment. */
  runnerId: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  /**
   * The MCP servers this machine runs for Dispand (runner tools), by name. The only commands
   * the runner ever starts for a session's tools: the server names one, never sends one.
   */
  mcpServers: z
    .record(
      McpServerName,
      z.strictObject({ command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
    )
    // `hello` lists them all, up to the protocol's limit.
    .refine((servers) => Object.keys(servers).length <= 100, "at most 100 MCP servers")
    .optional(),
});
export type RunnerConfig = z.infer<typeof RunnerConfig>;

/** `~/.config/dispand-runner` (or under `$XDG_CONFIG_HOME`). */
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dispand-runner");
}

/**
 * The environment the CLI runs with: `env`, with `CLAUDE_CONFIG_DIR` (when set) resolved once
 * to an absolute real path. The CLI would resolve a relative one against each session's cwd and
 * the runner against its own, so both get this one value. Throws if it doesn't exist.
 */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!env.CLAUDE_CONFIG_DIR) return env;
  let dir: string;
  try {
    dir = realpathSync(resolve(env.CLAUDE_CONFIG_DIR));
  } catch {
    throw new Error(`CLAUDE_CONFIG_DIR ${env.CLAUDE_CONFIG_DIR} does not exist`);
  }
  return { ...env, CLAUDE_CONFIG_DIR: dir };
}

/**
 * `env`, with `CODEX_HOME` (when set) resolved once to an absolute real path, as `claudeEnv`
 * does for `CLAUDE_CONFIG_DIR`: Codex and every check then see one value. Throws if it doesn't exist.
 */
export function codexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!env.CODEX_HOME) return env;
  let dir: string;
  try {
    dir = realpathSync(resolve(env.CODEX_HOME));
  } catch {
    throw new Error(`CODEX_HOME ${env.CODEX_HOME} does not exist`);
  }
  return { ...env, CODEX_HOME: dir };
}

/**
 * What no session's working directory may contain or sit inside: the runner's own config dir,
 * Claude Code's user config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`), `~/.claude.json` and
 * Codex's home (`CODEX_HOME`, else `~/.codex`). File edits stay inside the working directory
 * (`boundary.ts`), so these stay out of reach.
 */
export function machineConfigPaths(runnerConfigDir: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  return [runnerConfigDir, env.CLAUDE_CONFIG_DIR || join(home, ".claude"), join(home, ".claude.json"), env.CODEX_HOME || join(home, ".codex")];
}

/** The first of `paths` that `dir` contains or sits inside (real paths), or undefined. */
export function overlapping(dir: string, paths: string[]): string | undefined {
  const real = realOf(dir);
  return paths.find((p) => {
    const other = realOf(p);
    return inside(other, real) || inside(real, other);
  });
}

/**
 * Where the runner keeps what sessions need outside their run folder (skill packages, written
 * read-only per session): `$XDG_STATE_HOME/dispand-runner` (when absolute), else
 * `~/.local/state/dispand-runner`. It must stay apart from the roots and the machine's config.
 */
export function runnerStateDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const base = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(base, "dispand-runner");
}

function checkRoots(config: RunnerConfig, runnerConfigDir: string, env: NodeJS.ProcessEnv, home: string): RunnerConfig {
  const machine = machineConfigPaths(runnerConfigDir, env, home);
  const state = runnerStateDir(env, home);
  const stateClash = overlapping(state, machine);
  if (stateClash) throw new Error(`the runner's state dir ${state} must not contain or be inside ${stateClash}`);
  for (const root of config.roots) {
    if (isConfigPath(realOf(root))) throw new Error(`root ${root} must not be a project's .claude or .mcp.json, nor inside one`);
    const clash = overlapping(root, [...machine, state]);
    if (clash) throw new Error(`root ${root} must not contain or be inside ${clash}`);
  }
  return config;
}

/** The config at `path`; refused when a root contains (or is inside) the machine's config, see `machineConfigPaths`. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): RunnerConfig {
  return checkRoots(RunnerConfig.parse(JSON.parse(readFileSync(path, "utf8"))), dirname(resolve(path)), env, home);
}

/** A pairing's own state: the seq checkpoint, the unacked events, the resume map. */
const RUN_STATE = ["state.json", "backlog.jsonl", "sessions.json"];

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The folder holding the state of the pairing in `config.json`: `state/<runnerId>/` (0700),
 * created if needed, or `state/unpaired/` for a config from before runner ids were saved. State
 * files an older runner kept next to the config move in there (with a runner id), or are dropped.
 */
export function stateDir(dir: string): string {
  const { runnerId } = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { runnerId?: unknown };
  const id = typeof runnerId === "string" && /^[A-Za-z0-9_-]+$/.test(runnerId) ? runnerId : undefined;
  const state = join(dir, "state", id ?? "unpaired");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  for (const file of RUN_STATE) {
    const old = join(dir, file);
    if (!list(dir).includes(file)) continue;
    if (id && !list(state).includes(file)) moveDurable(old, join(state, file));
    else rmSync(old, { force: true });
  }
  return state;
}

/**
 * Everything pairing can check or prepare on this machine, done before the single-use code is
 * spent: `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, the roots (checked as `loadConfig` does, then created), the config
 * dir (created 0700, its writability proven by a durable test write). Throws on any problem.
 * `commit(token, runnerId)` then saves the config with the token and runner id in it: one
 * `writeDurable` (0600), so a failure leaves the previous pairing, and its state, untouched. The
 * state of other runner ids is then removed, best effort: it belongs to pairings that are gone. `abort()` is there for symmetry: nothing is left to undo.
 */
export function preparePairing(dir: string, config: RunnerConfig): { commit(token: string, runnerId: string): void; abort(): void } {
  const parsed = checkRoots(RunnerConfig.parse(config), resolve(dir), codexEnv(claudeEnv()), homedir());
  for (const root of parsed.roots) mkdirSync(root, { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const probe = join(dir, ".write-check");
  writeDurable(probe, "");
  rmSync(probe);
  return {
    commit(token, runnerId) {
      const config = RunnerConfig.parse({ ...parsed, token, runnerId });
      writeDurable(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, 0o600);
      for (const other of list(join(dir, "state"))) {
        if (other !== runnerId) rmSync(join(dir, "state", other), { recursive: true, force: true });
      }
    },
    abort: () => {},
  };
}

/**
 * The runner's token, from `config.json`. An older runner kept it in a separate `token` file:
 * it is moved into `config.json` (one durable write, 0600) and the old file removed.
 */
export function loadToken(dir: string): string {
  const path = join(dir, "config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (typeof raw.token === "string" && raw.token) return raw.token;
  const legacy = join(dir, "token");
  const token = readFileSync(legacy, "utf8").trim();
  writeDurable(path, `${JSON.stringify({ ...raw, token }, null, 2)}\n`, 0o600);
  rmSync(legacy);
  return token;
}
