// The runner's command line: `pair` once (install.sh runs it), then `run` (the systemd user unit).
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { accessSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { claudeEnv, codexEnv, configDir, loadConfig, loadToken, machineConfigPaths, preparePairing, type RunnerConfig, runnerStateDir, serverUrl, stateDir } from "./config.ts";
import { callTool, credentialValues, discoverTool } from "./mcp.ts";
import { codexDenied } from "./boundary.ts";
import { clearSessions } from "./skills.ts";
import { Connection } from "./connection.ts";
import { ID } from "@dispand/runner-protocol";
import { protocolString } from "./sanitize.ts";
import { atLeast, MIN_CLAUDE, Sessions } from "./sessions.ts";
import { codexRequired, codexStatus } from "./codex/version.ts";
import { shutdown } from "./shutdown.ts";

const USAGE = `Usage:
  DISPAND_PAIRING_CODE=<code> dispand-runner pair [--config <dir>] --server <url> --root <dir> [--root <dir>...]
  dispand-runner run [--config <dir>]`;

function fail(message: string): never {
  console.error(`dispand-runner: ${message}`);
  process.exit(1);
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

async function pair(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { config: { type: "string" }, server: { type: "string" }, root: { type: "string", multiple: true } },
  });
  // From the environment, never argv: another local user could read it in `ps`.
  const code = process.env.DISPAND_PAIRING_CODE;
  delete process.env.DISPAND_PAIRING_CODE;
  if (!values.server || !code || !values.root?.length) fail(USAGE);
  let server: string;
  try {
    server = serverUrl(values.server);
  } catch (err) {
    fail((err as Error).message);
  }
  const roots = values.root.map((root) => resolve(root));
  const dir = values.config ? resolve(values.config) : configDir();
  // A re-pair keeps what the machine's owner set by hand.
  let kept: Pick<RunnerConfig, "allowBypass" | "mcpServers"> = { allowBypass: false };
  try {
    const { allowBypass, mcpServers } = loadConfig(join(dir, "config.json"));
    kept = { allowBypass, ...(mcpServers ? { mcpServers } : {}) };
  } catch {
    // First pairing.
  }
  // Every local check first: the code is single-use, so it is spent only once nothing else can fail here.
  let pairing: ReturnType<typeof preparePairing>;
  try {
    pairing = preparePairing(dir, { server, roots, ...kept });
  } catch (err) {
    fail((err as Error).message);
  }
  let res: Response;
  try {
    res = await fetch(new URL("/runner/pair", server), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    pairing.abort();
    fail(`can't reach ${server}: ${(err as Error).message}`);
  }
  if (!res.ok) pairing.abort();
  if (res.status === 401) fail("the pairing code is unknown, used or expired: create a new one in Dispand");
  if (!res.ok) fail(`pairing failed: HTTP ${res.status}`);
  const { runnerId, token } = (await res.json()) as { runnerId: string; token: string };
  pairing.commit(token, runnerId);
  console.log(`Paired as runner ${runnerId}. Config: ${join(dir, "config.json")}`);
}

async function run(args: string[]) {
  const { values } = parseArgs({ args, options: { config: { type: "string" } } });
  const dir = values.config ? resolve(values.config) : configDir();
  // One CLAUDE_CONFIG_DIR and one CODEX_HOME, absolute, for the CLIs and every check.
  let env: NodeJS.ProcessEnv;
  try {
    env = codexEnv(claudeEnv());
  } catch (err) {
    fail((err as Error).message);
  }
  const config = loadConfig(join(dir, "config.json"), env);
  const token = loadToken(dir);
  // This pairing's own state (seq, backlog, resume map): a new pairing never sees another's.
  const state = stateDir(dir);
  const claudePath = findOnPath("claude");
  if (!claudePath) console.error("dispand-runner: no claude on PATH, Claude Code sessions will fail");
  const claude = claudePath
    ? await promisify(execFile)(claudePath, ["--version"]).then(
        ({ stdout }) => protocolString(stdout.trim().split(/\s+/)[0] ?? "", ID),
        () => undefined,
      )
    : undefined;

  if (claudePath && !atLeast(claude, MIN_CLAUDE)) {
    console.error(`dispand-runner: Claude Code ${claude ?? "?"} found, ≥ ${MIN_CLAUDE} required: sessions will be refused`);
  }
  // Codex: its version and whether it is signed in, never the account itself (`hello.clis.codex`).
  const codexPath = findOnPath("codex");
  const codex = codexPath ? await codexStatus(codexPath, env) : undefined;
  if (codexPath && !codex) console.error("dispand-runner: codex on PATH doesn't run, Codex sessions will fail");
  if (codex) {
    const problem = codexRequired(codex.version);
    if (problem) console.error(`dispand-runner: ${problem}`);
    else if (!codex.signedIn) console.error(`dispand-runner: Codex ${codex.version} isn't signed in: run \`codex login\``);
    else console.log(`dispand-runner: Codex ${codex.version}, signed in`);
  }

  // Skill files of sessions a crash left behind: no session runs yet.
  const skillsState = runnerStateDir(env);
  await clearSessions(skillsState).catch((err: unknown) => console.error("dispand-runner: can't clear old skill files:", (err as Error).message));

  // The machine's own MCP servers (runner tools): the only commands started for a session's tools.
  const local = config.mcpServers ?? {};
  /** Tools being listed: one listing per tool at a time, so the server can't pile up processes. */
  const listing = new Set<string>();
  const discover = (requestId: string, tool: string) => {
    const server = Object.hasOwn(local, tool) ? local[tool] : undefined;
    if (!server) return conn.reply({ type: "tool.discovered", requestId, error: `this runner has no MCP server ${tool} in its config` });
    if (listing.has(tool)) return conn.reply({ type: "tool.discovered", requestId, error: `the MCP server ${tool} is already being listed` });
    listing.add(tool);
    void discoverTool(tool, server).then(
      (actions) => conn.reply({ type: "tool.discovered", requestId, actions }),
      (err: unknown) => conn.reply({ type: "tool.discovered", requestId, error: (err as Error).message }),
    ).finally(() => listing.delete(tool));
  };

  /** Tools being called for a poll: one call per tool at a time. */
  const calling = new Set<string>();
  const call = (requestId: string, tool: string, action: string, args: Record<string, unknown>) => {
    const server = Object.hasOwn(local, tool) ? local[tool] : undefined;
    if (!server) return conn.reply({ type: "tool.called", requestId, error: `this runner has no MCP server ${tool} in its config` });
    if (calling.has(tool)) return conn.reply({ type: "tool.called", requestId, error: `the MCP server ${tool} is already being called` });
    calling.add(tool);
    // The machine's config and every link out of it, and the credentials' values, read now.
    const machine = machineConfigPaths(dir, env);
    const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const credentials = [join(dir, "config.json"), join(claudeDir, ".credentials.json"), join(claudeDir, "settings.json"), join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json")];
    const guard = { forbidden: codexDenied([...machine, ...credentials]), secrets: [token, ...credentialValues(credentials)] };
    void callTool(tool, server, action, args, guard).then(
      ({ content, isError }) => conn.reply({ type: "tool.called", requestId, content, isError }),
      (err: unknown) => conn.reply({ type: "tool.called", requestId, error: (err as Error).message }),
    ).finally(() => calling.delete(tool));
  };

  const conn: Connection = new Connection({
    server: config.server,
    token,
    seqPath: join(state, "state.json"),
    backlogPath: join(state, "backlog.jsonl"),
    hello: () => {
      sessions.connected();
      const clis = { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) };
      return { type: "hello", runnerVersion: pkg.version, clis, tools: Object.keys(local), liveSessions: sessions.ids() };
    },
    onMessage: (msg) => {
      if (msg.type === "tool.discover") return discover(msg.requestId, msg.tool);
      if (msg.type === "tool.call") return call(msg.requestId, msg.tool, msg.action, msg.arguments);
      // In order per session (`Sessions.handle`): one session's slow start holds up no other.
      sessions.handle(msg).catch((err: unknown) => console.error("dispand-runner:", err));
    },
    // Dispand has been unreachable too long: stop working rather than keep piling up events.
    onBacklogFull: () => sessions.stopAll("Dispand unreachable: the runner's backlog is full"),
  });
  const sessions = new Sessions(config, (sessionId, event) => conn.emit(sessionId, event), {
    claude: { claudePath, env },
    ...(codexPath && codex ? { codex: { codexPath, env, version: codex.version } } : {}),
    forbidden: machineConfigPaths(dir, env),
    resumeMap: join(state, "sessions.json"),
    accepting: () => !conn.backlogFull,
    claudeVersion: claude,
    skills: { server: config.server, token, stateDir: skillsState },
  });
  // Stopping (within 10 s, well inside systemd's stop timeout): live CLIs are
  // aborted without errors, so Dispand resumes them once the runner is back.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void shutdown(sessions, conn, 10_000).finally(() => process.exit(0));
    });
  }
  // Printed once the handlers are in place: from this line on, a signal stops the runner cleanly.
  conn.start();
  console.log(`dispand-runner ${pkg.version}: connecting to ${config.server}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "pair") await pair(rest);
else if (command === "run") await run(rest);
else fail(USAGE);
