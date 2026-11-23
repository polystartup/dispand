import { commandSources, discoverCommands } from "./commands.ts";
import { stagedSources } from "./native-skills.ts";
import { discoverModels } from "./models.ts";
// The runner's command line: `pair` once (install.sh runs it), then `run` (the systemd user unit).
import { startUpdates } from "./updates.ts";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { createInterface } from "node:readline/promises";
import { canonicalEntry, contentDigest } from "@dispand/runner-protocol/digest";
import { checkPluginFiles, type FetchedPlugin, fetchPlugin, launchPluginServer } from "./plugin-servers.ts";
import { claudeEnv, codexEnv, configDir, loadConfig, PLUGIN_NAME, loadToken, machineConfigPaths, preparePairing, type RunnerConfig, runnerStateDir, serverUrl, stateDir } from "./config.ts";
import { callTool, credentialValues, discoverTool } from "./mcp.ts";
import { PROXY_SPEC, PROXY_TOKEN, ProxySpec, runProxy } from "./mcp-proxy.ts";
import { codexDenied } from "./boundary.ts";
import { clearSessions } from "./skills.ts";
import { Connection } from "./connection.ts";
import { ID, type PluginServer } from "@dispand/runner-protocol";
import { protocolString } from "./sanitize.ts";
import { atLeast, MIN_CLAUDE, Sessions } from "./sessions.ts";
import { codexRequired, codexStatus } from "./codex/version.ts";
import { NativePlugins } from "./plugins.ts";
import { prepareSkillshare } from "./skillshare.ts";
import { shutdown } from "./shutdown.ts";
import { writeDurable } from "./durable.ts";
import { refuseLaunch, workerImage } from "./image-gate.ts";

const USAGE = `Usage:
  [DISPAND_PAIRING_CODE=<code>] dispand-runner pair [--config <dir>] --server <url> --root <dir> [--root <dir>...]
    (without DISPAND_PAIRING_CODE, the code is read from stdin)
  dispand-runner run [--config <dir>]
  dispand-runner native-plugins [--config <dir>]
  dispand-runner allow-plugin [--config <dir>] <tool id> <name>@<digest>`;

function fail(message: string): never {
  console.error(`dispand-runner: ${message}`);
  process.exit(1);
}

function findOnPath(name: string): string | undefined {
  for (const dir of process.env.PATH?.split(delimiter) ?? []) {
    try {
      const path = resolve(dir, name);
      accessSync(path, constants.X_OK);
      return path;
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
  if (!values.server || !values.root?.length) fail(USAGE);
  // From the environment or stdin, never argv: another local user could read it in `ps`.
  let code = process.env.DISPAND_PAIRING_CODE;
  delete process.env.DISPAND_PAIRING_CODE;
  if (!code) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    code = (await rl.question("Pairing code: ").catch(() => "")).trim();
    rl.close();
  }
  if (!code) fail(USAGE);
  let server: string;
  try {
    server = serverUrl(values.server);
  } catch (err) {
    fail((err as Error).message);
  }
  const roots = values.root.map((root) => resolve(root));
  const dir = values.config ? resolve(values.config) : configDir();
  // A re-pair keeps what the machine's owner set by hand.
  let kept: Pick<RunnerConfig, "allowBypass" | "mcpServers" | "pluginTargets" | "allowedPlugins"> = { allowBypass: false };
  try {
    const { allowBypass, mcpServers, pluginTargets, allowedPlugins } = loadConfig(join(dir, "config.json"));
    kept = { allowBypass, ...(pluginTargets ? { pluginTargets } : {}), ...(mcpServers ? { mcpServers } : {}), ...(allowedPlugins ? { allowedPlugins } : {}) };
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

/**
 * `allow-plugin <tool id> <name>@<digest>`: fetches the tool's plugin from the server itself,
 * refuses another name or a digest other than the one typed, shows the launch entry and writes
 * the record (`allowedPlugins`, replacing that name's) only after a typed yes. Runs nothing.
 */
async function allowPlugin(args: string[]) {
  const { values, positionals } = parseArgs({ args, options: { config: { type: "string" } }, allowPositionals: true });
  const [toolId, spec, ...extra] = positionals;
  const at = spec?.lastIndexOf("@") ?? -1;
  const name = spec?.slice(0, at) ?? "";
  const typed = spec?.slice(at + 1) ?? "";
  if (!toolId || toolId.length > ID || extra.length || name.length > 64 || !PLUGIN_NAME.test(name) || !/^sha256:[0-9a-f]{64}$/.test(typed)) fail(USAGE);
  const dir = values.config ? resolve(values.config) : configDir();
  const path = join(dir, "config.json");
  // The token first: an older runner's separate token file moves into config.json, which this command then rewrites.
  const token = loadToken(dir);
  const config = loadConfig(path, codexEnv(claudeEnv()));
  let parsed: FetchedPlugin;
  try {
    parsed = await fetchPlugin(config.server, token, toolId);
  } catch (err) {
    fail((err as Error).message);
  }
  if (parsed.name !== name) fail(`tool ${toolId} runs the plugin ${parsed.name}, not ${name}: nothing was written`);
  const { files } = parsed;
  // The runner would refuse to launch these files whatever the record: write none for them.
  try {
    checkPluginFiles(name, files);
  } catch (err) {
    fail(`${(err as Error).message} Nothing was written.`);
  }
  const digest = contentDigest(files);
  if (digest !== typed) fail(`the files Dispand sent for ${name} have the digest ${digest}, not ${typed}: nothing was written`);
  const command = parsed.entry.command;
  console.log(`The plugin ${name} (${digest}) starts its server with this launch entry:\n${JSON.stringify(JSON.parse(canonicalEntry(parsed.entry)), null, 2)}`);
  if (!(command.startsWith("./") && files.some((f) => f.path === command.slice(2)))) {
    console.log(`Its command ${command} isn't a file of the plugin: this record covers the command line, not what it downloads.`);
  }
  const record = { name, digest, entry: parsed.entry };
  const allowedPlugins = [...(config.allowedPlugins ?? []).filter((r) => r.name !== name), record];
  if (allowedPlugins.length > 100) fail("this runner already allows 100 plugins: remove one from allowedPlugins in its config first");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Allow it on this runner? Type yes to write the record: ").catch(() => "");
  rl.close();
  if (answer.trim() !== "yes") fail("nothing was written");
  writeDurable(path, `${JSON.stringify({ ...config, allowedPlugins }, null, 2)}\n`, 0o600);
  console.log(`The plugin ${name} is allowed on this runner with the digest ${digest}; restart the runner to use it.`);
}

async function detectClis(env: NodeJS.ProcessEnv) {
  const claudePath = findOnPath("claude");
  if (!claudePath) console.error("dispand-runner: no claude on PATH, Claude Code sessions will fail");
  const claude = claudePath
    ? await promisify(execFile)(claudePath, ["--version"], { env, timeout: 5000 }).then(
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
  return { claudePath, codexPath, clis: { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) } };
}

async function run(args: string[]) {
  const { values } = parseArgs({ args, options: { config: { type: "string" } } });
  const dir = values.config ? resolve(values.config) : configDir();
  // One CLAUDE_CONFIG_DIR and one CODEX_HOME, absolute, for the CLIs and every check.
  let env: NodeJS.ProcessEnv;
  let image: string | undefined;
  try {
    env = codexEnv(claudeEnv());
    image = workerImage();
  } catch (err) {
    fail((err as Error).message);
  }
  // The image starts unpaired: it waits for `pair` (run in the container) to write the config.
  if (image && !existsSync(join(dir, "config.json"))) {
    console.log(`dispand-runner: not paired yet, waiting for \`dispand-runner pair\` to write ${join(dir, "config.json")}`);
    // Node as PID 1 has no default SIGTERM: `docker stop` must end the wait.
    const stop = () => process.exit(0);
    process.once("SIGTERM", stop).once("SIGINT", stop);
    while (!existsSync(join(dir, "config.json"))) await new Promise((r) => setTimeout(r, 1000));
    process.off("SIGTERM", stop).off("SIGINT", stop);
  }
  const config = loadConfig(join(dir, "config.json"), env);
  const token = loadToken(dir);
  // This pairing's own state (seq, backlog, resume map): a new pairing never sees another's.
  const state = stateDir(dir);
  let detected = await detectClis(env);
  let refreshing: Promise<typeof detected> | undefined;

  // Skill files of sessions a crash left behind: no session runs yet.
  const skillsState = runnerStateDir(env);
  await clearSessions(skillsState).catch((err: unknown) => console.error("dispand-runner: can't clear old skill files:", (err as Error).message));

  // The machine's own MCP servers (runner tools): the only commands started for a session's tools.
  const local = config.mcpServers ?? {};
  /**
   * What a tool message names: one of the machine's own servers, or a plugin's stdio server,
   * launched only as this machine's record allows (`plugin-servers.ts`). Its key, the name its
   * errors give, and how to start it (or why not, in the runner's words).
   */
  const target = (tool: string | PluginServer) => {
    if (typeof tool !== "string") {
      return { key: `plugin:${tool.tool}`, name: tool.plugin, server: () => launchPluginServer(config, skillsState, tool, (id) => fetchPlugin(config.server, token, id)) };
    }
    const server = Object.hasOwn(local, tool) ? local[tool] : undefined;
    return { key: tool, name: tool, server: async () => server ?? Promise.reject(new Error(`this runner has no MCP server ${tool} in its config`)) };
  };
  /** Tools being listed: one listing per tool at a time, so the server can't pile up processes. */
  const listing = new Set<string>();
  const discover = (requestId: string, tool: string | PluginServer) => {
    const { key, name, server } = target(tool);
    if (listing.has(key)) return conn.reply({ type: "tool.discovered", requestId, error: `the MCP server ${name} is already being listed` });
    listing.add(key);
    void server().then((s) => discoverTool(name, s)).then(
      (actions) => conn.reply({ type: "tool.discovered", requestId, actions }),
      (err: unknown) => conn.reply({ type: "tool.discovered", requestId, error: (err as Error).message }),
    ).finally(() => listing.delete(key));
  };

  /** Tools being called for a poll: one call per tool at a time. */
  const calling = new Set<string>();
  const call = (requestId: string, tool: string | PluginServer, action: string, args: Record<string, unknown>) => {
    const { key, name, server } = target(tool);
    if (calling.has(key)) return conn.reply({ type: "tool.called", requestId, error: `the MCP server ${name} is already being called` });
    calling.add(key);
    // The machine's config and every link out of it, and the credentials' values, read now.
    const machine = machineConfigPaths(dir, env);
    const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const credentials = [join(dir, "config.json"), join(claudeDir, ".credentials.json"), join(claudeDir, "settings.json"), join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json")];
    const guard = { forbidden: codexDenied([...machine, ...credentials]), secrets: [token, ...credentialValues(credentials)] };
    void server().then((s) => callTool(name, s, action, args, guard)).then(
      ({ content, isError, hasMore }) => conn.reply({ type: "tool.called", requestId, content, isError, ...(hasMore ? { hasMore } : {}) }),
      (err: unknown) => conn.reply({ type: "tool.called", requestId, error: (err as Error).message }),
    ).finally(() => calling.delete(key));
  };

  const native = prepareSkillshare(dir, config.pluginTargets, env);
  const plugins = new NativePlugins(native.targets, native.env);
  const conn: Connection = new Connection({
    server: config.server,
    token,
    seqPath: join(state, "state.json"),
    backlogPath: join(state, "backlog.jsonl"),
    hello: () => {
      sessions.connected();
      return { type: "hello", runnerVersion: pkg.version, clis: detected.clis, tools: Object.keys(local), liveSessions: sessions.ids() };
    },
    onMessage: (msg) => {
      // shortcut: the image refuses every launch until its sandbox exists; the next slices start each in a worker.
      const refused = image ? refuseLaunch(msg) : undefined;
      if (refused) return "reply" in refused ? conn.reply(refused.reply) : conn.emit(refused.sessionId, refused.event);
      if (msg.type === "clis.request") {
        refreshing ??= detectClis(env).then((result) => detected = result).finally(() => { refreshing = undefined; });
        void refreshing.then(
          ({ clis }) => conn.reply({ type: "clis.replied", requestId: msg.requestId, clis }),
          () => conn.reply({ type: "clis.replied", requestId: msg.requestId, error: "Could not refresh installed CLIs" }),
        );
        return;
      }
      if (msg.type === "commands.request") {
        const catalog = msg.sessionId ? sessions.commands(msg.sessionId) : discoverCommands(msg.harness, msg.harness === "codex" ? detected.codexPath : detected.claudePath, env, config.roots[0]!);
        void Promise.all([catalog, plugins.request({ action: "list" })]).then(([commands, report]) => stagedSources(commandSources(commands, msg.harness, report), msg.sessionId ? sessions.stagedPackages(msg.sessionId) : [])).then(
          (commands) => conn.reply({ type: "commands.replied", requestId: msg.requestId, commands }),
          () => conn.reply({ type: "commands.replied", requestId: msg.requestId, error: "Could not discover commands from the CLI" }),
        );
        return;
      }
      if (msg.type === "models.request") {
        void discoverModels(msg.harness, msg.harness === "codex" ? detected.codexPath : detected.claudePath, env).then(
          (models) => conn.reply({ type: "models.replied", requestId: msg.requestId, models }),
          () => conn.reply({ type: "models.replied", requestId: msg.requestId, error: "Could not discover models from the CLI" }),
        );
        return;
      }
      if (msg.type === "plugin.request") {
        void plugins.request(msg.operation).then((report) => conn.reply({ type: "plugin.replied", requestId: msg.requestId, report }));
        return;
      }
      if (msg.type === "tool.discover") return discover(msg.requestId, msg.tool);
      if (msg.type === "tool.call") return call(msg.requestId, msg.tool, msg.action, msg.arguments);
      // In order per session (`Sessions.handle`): one session's slow start holds up no other.
      sessions.handle(msg).catch((err: unknown) => console.error("dispand-runner:", err));
    },
    // Dispand has been unreachable too long: stop working rather than keep piling up events.
    onBacklogFull: () => sessions.stopAll("Dispand unreachable: the runner's backlog is full"),
  });
  const sessions = new Sessions(config, (sessionId, event) => conn.emit(sessionId, event), {
    nativePlugins: plugins,
    get claude() { return { claudePath: detected.claudePath, env }; },
    get claudeVersion() { return detected.clis.claude; },
    get codex() {
      return detected.codexPath && detected.clis.codex ? { codexPath: detected.codexPath, env, version: detected.clis.codex.version } : undefined;
    },
    forbidden: machineConfigPaths(dir, env),
    resumeMap: join(state, "sessions.json"),
    accepting: () => !conn.backlogFull,
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
  startUpdates(config.server, token, dir);
  conn.start();
  console.log(`dispand-runner ${pkg.version}: connecting to ${config.server}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "pair") await pair(rest);
else if (command === "run") await run(rest);
else if (command === "allow-plugin") await allowPlugin(rest);
// Started by a session's CLI in place of a runner tool (`mcp.ts` `mcpConfigFor`), never by hand.
else if (command === "mcp-proxy") {
  let spec: ProxySpec;
  try {
    spec = ProxySpec.parse(JSON.parse(process.env[PROXY_SPEC] ?? ""));
  } catch {
    fail("mcp-proxy is started by a session, with its spec");
  }
  // Its server gone and every line written out, the proxy goes too, whatever the CLI still holds open.
  process.exit(await runProxy(spec, process.env[PROXY_TOKEN]));
}
else if (command === "native-plugins") {
  const { values } = parseArgs({ args: rest, options: { config: { type: "string" } } });
  const dir = values.config ? resolve(values.config) : configDir();
  const path = join(dir, "config.json");
  const config = loadConfig(path, codexEnv(claudeEnv()));
  writeDurable(path, `${JSON.stringify({ ...config, pluginTargets: "managed" }, null, 2)}\n`);
  console.log("Native plugin support enabled; restart the runner to use it. Each installation requires approval in Dispand.");
}
else fail(USAGE);
