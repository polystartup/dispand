// Every place the runner starts a process, and where it runs in the container image: a new
// launch site fails here until it is classified, and a site meant for a worker must pass the
// worker's launch (or command) along. The sources are read as code (`test-support-source.ts` in
// the domain package), not lines: what the former line regex matched is found as runs of tokens,
// whatever the formatting (and in a string's text, as it read that too: a script given to
// `node -e`), each is placed in the tree (a call, or a function it declares, in its function), and
// its statement is compared with its entry's by shape.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listed,
  match,
  named,
  optional,
  owner,
  parse,
  shape,
  site,
  statement,
  stringSites,
  tokens,
  unwrap,
  where,
  type Step,
} from "@dispand/domain/test-support-source";
import ts from "typescript";
import { expect, test } from "vitest";

/** A name as the former regex's `\b` read it: an identifier (or `#private`) ending so, after a non-word character (`$spawn`, `#spawn`). */
const ending = (re: RegExp) => (token: ts.Node) => (ts.isIdentifier(token) || ts.isPrivateIdentifier(token)) && re.test(token.text);
const CALL: Step[] = [optional("!"), optional("?."), "("];
/** The former line regex, read as it was in strings: node's spawners, Codex's app-server, the Agent SDK's CLI, MCP's stdio client. */
const LAUNCH = /\b(spawn|spawnSync|execFile|execFileSync|execSync|fork)\(|promisify\(execFile\)|CodexRpc\.spawn\(|\bquery\)?\(\{|new StdioClientTransport\(/;
/**
 * `LAUNCH` in code, as runs of tokens: node's spawners (`CodexRpc.spawn(` among them), `promisify(execFile)`, the
 * Agent SDK's `query(` or `(… ?? query)(` whatever it is given, MCP's stdio client.
 */
const PATTERNS: Step[][] = [
  [ending(/\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)$/), ...CALL],
  [ending(/promisify$/), "(", named("execFile"), ")"],
  [ending(/\bquery$/), optional(")"), ...CALL],
  [named("StdioClientTransport"), ...CALL],
];

/**
 * One site each: its file, the function it is in (`owner`'s path), and its statement (`listed`: a
 * method written in `class _ { … }`, by its signature). `callee` lists the Agent SDK's call in
 * claude.ts by its callee and options given as an object literal instead, as the former `query)({`
 * did: its statement is its options, a hundred lines, which the worker check reads.
 */
type Site = { file: string; in: string; where: "worker" | "supervisor"; why: string } & ({ code: string } | { callee: string });

const SITES: Site[] = [
  {
    file: "src/claude.ts",
    in: "startClaudeSession",
    callee: "deps.query ?? query",
    where: "worker",
    why: "a session's Claude Code, through `spawnIn(deps.launch)`",
  },
  {
    file: "src/codex/session.ts",
    in: "startCodexSession",
    code: "const codex = await CodexRpc.spawn(deps.codexPath, { ...(deps.env ?? process.env), ...deps.mcp?.env }, cwd, stopCodex.signal, deps.launch);",
    where: "worker",
    why: "a session's Codex, through `deps.launch`",
  },
  {
    file: "src/commands.ts",
    in: "discoverCommands",
    code: "const rpc = await CodexRpc.spawn(path, env, cwd, AbortSignal.timeout(20_000), launch);",
    where: "worker",
    why: "command discovery (Codex), in a scratch worker in the image",
  },
  {
    file: "src/commands.ts",
    in: "discoverCommands",
    code: "const session = query({ prompt: input(), options: { pathToClaudeCodeExecutable: path, env, cwd, abortController: controller, persistSession: false, ...spawnIn(launch, cwd) } });",
    where: "worker",
    why: "command discovery (Claude Code), in a scratch worker in the image",
  },
  {
    file: "src/models.ts",
    in: "discoverModels",
    code: "const rpc = await CodexRpc.spawn(path, env, cwd, AbortSignal.timeout(20_000), launch);",
    where: "worker",
    why: "model discovery (Codex), in a scratch worker in the image",
  },
  {
    file: "src/models.ts",
    in: "discoverModels",
    code: "const session = query({ prompt: input(), options: { pathToClaudeCodeExecutable: path, env, cwd, abortController: controller, persistSession: false, ...spawnIn(launch, cwd) } });",
    where: "worker",
    why: "model discovery (Claude Code), in a scratch worker in the image",
  },
  {
    file: "src/codex/rpc.ts",
    in: "CodexRpc.spawn",
    code: "class _ { static async spawn(codexPath: string, env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal, launch?: Launch): Promise<CodexRpc> {} }",
    where: "worker",
    why: "the app-server primitive: a worker's launch when one is given",
  },
  {
    file: "src/codex/rpc.ts",
    in: "CodexRpc.spawn",
    code: 'const rpc = new CodexRpc(launch ? launch(codexPath, ["app-server"], { cwd, env }) : spawn(codexPath, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }));',
    where: "supervisor",
    why: "the app-server primitive: a worker's launch when its caller gives one, the machine otherwise (the bare install, the start-up checks)",
  },
  {
    file: "src/mcp-proxy.ts",
    in: "runProxy",
    code: 'const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...env, ...spec.env }, stdio: ["pipe", "pipe", "inherit"] });',
    where: "supervisor",
    why: "a tool server: the machine's own (its config), or a plugin's `docker run` into its worker (`serveInWorker`)",
  },
  {
    file: "src/mcp.ts",
    in: "discoverTool",
    code: 'const transport = new StdioClientTransport({ command: server.command, args: server.args ?? [], env: { ...getDefaultEnvironment(), ...server.env }, stderr: "ignore", cwd: server.cwd ?? homedir() });',
    where: "supervisor",
    why: "a poll's tool server: the machine's own, or a plugin's `docker run` into its worker",
  },
  {
    file: "src/mcp.ts",
    in: "callTool",
    code: 'const transport = new StdioClientTransport({ command: server.command, args: server.args ?? [], env: { ...getDefaultEnvironment(), ...server.env }, stderr: "ignore", cwd: server.cwd ?? homedir() });',
    where: "supervisor",
    why: "a poll's tool server: the machine's own, or a plugin's `docker run` into its worker",
  },
  {
    file: "src/sandbox/tools.ts",
    in: "connectTools",
    code:
      'if (entry.type === "http") await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers ?? {} }, fetch: fetcher! })); ' +
      'else await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args ?? [], env: { ...getDefaultEnvironment(), ...entry.env }, stderr: "ignore" }));',
    where: "supervisor",
    why: "a session's tool servers through `mcp-proxy`, the supervisor's relay",
  },
  {
    file: "src/sandbox/worker.ts",
    in: "Sandbox.worker",
    code: 'const child = spawn(run.command, run.args, { env: run.env, stdio: ["pipe", "pipe", "pipe"] });',
    where: "supervisor",
    why: "the docker client starting a worker",
  },
  {
    file: "src/sandbox/worker.ts",
    in: "run",
    code: "const run = promisify(execFile);",
    where: "supervisor",
    why: "the docker client: volume, removal and inspection",
  },
  { file: "src/sandbox/egress.ts", in: "run", code: "const run = promisify(execFile);", where: "supervisor", why: "the docker client: a worker's network" },
  {
    file: "src/sandbox/egress.ts",
    in: "hostAddressesFrom",
    code:
      'const child = spawn(docker, ["run", "-i", "--rm", "--runtime", "runc", "--network", "host", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", ' +
      '"--user", `${process.getuid!()}:${process.getgid!()}`, "--label", `${OWNER_LABEL}=${await o.owner()}`, o.image, "node", "-e", HOST_HELPER], { env, stdio: ["pipe", "pipe", "pipe"] });',
    where: "supervisor",
    why: "the docker client starting the host-address helper: the runner's own code, on the host's network, no capability",
  },
  {
    file: "src/attachments.ts",
    in: "writeAnchored",
    code: 'const child = spawn(process.execPath, ["-e", ANCHORED_WRITE], { stdio: ["pipe", "ignore", "ignore"], env: {} });',
    where: "supervisor",
    why: "the runner's own writer of an attachment into a run folder, no code of the server's",
  },
  {
    file: "src/main.ts",
    in: "detectClis",
    code: 'const claude = claudePath ? await promisify(execFile)(claudePath, ["--version"], { env, timeout: 5000 }).then(({ stdout }) => protocolString(stdout.trim().split(/\\s+/)[0] ?? "", ID), () => undefined) : undefined;',
    where: "supervisor",
    why: "`claude --version` at start, the machine's own CLI",
  },
  {
    file: "src/codex/version.ts",
    in: "codexStatus",
    code: 'const { stdout } = await promisify(execFile)(codexPath, ["--version"], { env, timeout: timeoutMs });',
    where: "supervisor",
    why: "`codex --version` at start, the machine's own CLI",
  },
  {
    file: "src/codex/version.ts",
    in: "codexStatus",
    code: "rpc = await CodexRpc.spawn(codexPath, env, tmpdir(), AbortSignal.timeout(timeoutMs));",
    where: "supervisor",
    why: "whether the machine's own Codex is signed in, at start",
  },
  {
    file: "src/main.ts",
    in: "signIn",
    code: 'const code = await new Promise<number>((done) => spawn(cli, argv, { env, stdio: "inherit" }).once("exit", (c) => done(c ?? 1)).once("error", () => done(1)));',
    where: "supervisor",
    why: "`dispand-runner sign-in`: the CLI's own login into the supervisor's store, typed on the machine",
  },
  {
    file: "src/subscriptions/supervisor.ts",
    in: "codexIdentity",
    code: "const rpc = await CodexRpc.spawn(codexPath, env, tmpdir(), AbortSignal.timeout(timeoutMs));",
    where: "supervisor",
    why: "the personal subscription's status and renewal, on the supervisor's own login store",
  },
  {
    file: "src/subscriptions/supervisor.ts",
    in: "codexRenew",
    code: "const rpc = await CodexRpc.spawn(codexPath, env, tmpdir(), AbortSignal.timeout(timeoutMs));",
    where: "supervisor",
    why: "the personal subscription's status and renewal, on the supervisor's own login store",
  },
  {
    file: "src/codex/personal.ts",
    in: "CodexSubscription.fetch",
    code: 'rpc = await CodexRpc.spawn(path, subscriptionEnv(this.o.configDir, "codex", this.o.env), tmpdir(), AbortSignal.timeout(timeoutMs));',
    where: "supervisor",
    why: "a personal subscription's credential for the relay, read from the supervisor's own login store",
  },
  {
    file: "src/updates.ts",
    in: "startUpdates",
    code:
      'await promisify(execFile)("systemd-run", ["--user", "--collect", "--wait", "--unit=dispand-runner-update", ' +
      "...names.flatMap((name) => (environment[name] ? [`--setenv=${name}=${environment[name]}`] : [])), " +
      '"/bin/sh", "-c", `trap \'rm -rf -- "$2"\' EXIT; sh "$1" --update`, "dispand-update", script, dir], { timeout: 150_000 });',
    where: "supervisor",
    why: "the bare install's updater (systemd), never in the image",
  },
  {
    file: "src/plugins.ts",
    in: "skillshareExec",
    code: 'const child = spawn(binary, args, { cwd: homedir(), env, detached: true, stdio: ["ignore", "pipe", "ignore"] });',
    where: "supervisor",
    why: "native plugin management (Skillshare): refused by the image's gate",
  },
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return path.endsWith(join("codex", "protocol")) || e.name === "fixtures" ? [] : sources(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path] : [];
  });
}

const isName = (token: ts.Node) => ts.isIdentifier(token) || ts.isPrivateIdentifier(token);
const expression = (code: string) => (statement(code) as ts.ExpressionStatement).expression;

test("every process the runner starts is classified, and each worker site passes a worker's launch", () => {
  const unplaced: string[] = [];
  const found = sources("src").flatMap((file) => {
    const source = parse(file, readFileSync(file, "utf8"));
    const runs = PATTERNS.flatMap((pattern) => match(source, pattern)).map((run) => {
      const open = run.find((t) => t.kind === ts.SyntaxKind.OpenParenToken)!;
      const name = run.slice(0, run.indexOf(open)).filter(isName).at(-1)!;
      return { name, placed: site(name, open) };
    });
    return [...runs, ...stringSites(source, LAUNCH).map((placed) => ({ name: placed.node, placed }))].flatMap(({ name, placed }) => {
      const path = placed && owner(placed.node)?.path;
      // Neither a call nor a function declared, or outside any declaration: nothing to place it by.
      if (!placed || !path) {
        unplaced.push(where(name));
        return [];
      }
      return [{ file, in: path, ...placed }];
    });
  });
  expect(unplaced, "a match of the former regex that is neither a call, a declaration nor a string in a function").toEqual([]);
  // The exception stays one: every other site is listed by its whole statement.
  expect(SITES.filter((s) => "callee" in s).map((s) => `${s.file}#${s.in}`)).toEqual(["src/claude.ts#startClaudeSession"]);
  const codes = new Map(SITES.map((s) => [s, "code" in s ? listed(s.code) : shape(expression(s.callee))]));
  const classifies = (s: Site, f: (typeof found)[number]) => {
    if (s.file !== f.file || s.in !== f.in) return false;
    if ("code" in s) return f.code === codes.get(s);
    // Its options must be an object literal: a name holding them can't be read here.
    const call = f.node;
    return (
      ts.isCallExpression(call) && shape(call.expression) === codes.get(s) && !!call.arguments[0] && ts.isObjectLiteralExpression(unwrap(call.arguments[0]))
    );
  };
  const unclassified = found.filter((f) => !SITES.some((s) => classifies(s, f)));
  expect(
    unclassified.map((f) => `${f.file}#${f.in} (${where(f.node)}): ${f.at.getText().replace(/\s+/g, " ").slice(0, 160)}`),
    "a new launch site: classify it in SITES",
  ).toEqual([]);
  const stale = SITES.filter((s) => found.filter((f) => classifies(s, f)).length !== 1);
  expect(
    stale.map((s) => `${s.file}#${s.in}: ${"code" in s ? s.code : s.callee}`),
    "a classified site that no longer exists, or that stands for more than one",
  ).toEqual([]);
  for (const f of found.filter((f) => SITES.find((s) => classifies(s, f))!.where === "worker")) {
    // What the call is given (or the declaration takes, or the string holds), comments aside: a worker's launch passed along.
    const given =
      ts.isCallExpression(f.node) || ts.isNewExpression(f.node) ? (f.node.arguments ?? []) : ts.isFunctionLike(f.node) ? f.node.parameters : [f.node];
    expect(
      given.some((g) => tokens(g).some((t) => /launch/i.test(t.getText()))),
      `${where(f.node)} runs in a worker: it must pass a launch`,
    ).toBe(true);
  }
});
