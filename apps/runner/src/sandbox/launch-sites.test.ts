// Every place the runner starts a process, and where it runs in the container image: a new
// launch site fails here until it is classified, and a site meant for a worker must pass the
// worker's launch (or command) along.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

/** Node's process spawners: a call to one, or a method or function of that name, starts a process. */
const SPAWNERS = ["spawn", "spawnSync", "execFile", "execFileSync", "execSync", "fork"];

/** One site each: its file, the class member or top-level declaration it is in, and how its code starts. */
type Site = { file: string; in: string; code: string; where: "worker" | "supervisor"; why: string };

const SITES: Site[] = [
  {
    file: "src/claude.ts",
    in: "startClaudeSession",
    code: "(deps.query ?? query)({",
    where: "worker",
    why: "a session's Claude Code, through `spawnIn(deps.launch)`",
  },
  { file: "src/codex/session.ts", in: "startCodexSession", code: "CodexRpc.spawn(", where: "worker", why: "a session's Codex, through `deps.launch`" },
  {
    file: "src/commands.ts",
    in: "discoverCommands",
    code: "CodexRpc.spawn(",
    where: "worker",
    why: "command discovery (Codex), in a scratch worker in the image",
  },
  {
    file: "src/commands.ts",
    in: "discoverCommands",
    code: "query({",
    where: "worker",
    why: "command discovery (Claude Code), in a scratch worker in the image",
  },
  { file: "src/models.ts", in: "discoverModels", code: "CodexRpc.spawn(", where: "worker", why: "model discovery (Codex), in a scratch worker in the image" },
  { file: "src/models.ts", in: "discoverModels", code: "query({", where: "worker", why: "model discovery (Claude Code), in a scratch worker in the image" },
  { file: "src/codex/rpc.ts", in: "spawn", code: "static async spawn(", where: "worker", why: "the app-server primitive: a worker's launch when one is given" },
  {
    file: "src/codex/rpc.ts",
    in: "spawn",
    code: "launch ? launch(",
    where: "supervisor",
    why: "the app-server primitive: a worker's launch when its caller gives one, the machine otherwise (the bare install, the start-up checks)",
  },
  {
    file: "src/mcp-proxy.ts",
    in: "runProxy",
    code: "spawn(spec.command",
    where: "supervisor",
    why: "a tool server: the machine's own (its config), or a plugin's `docker run` into its worker (`serveInWorker`)",
  },
  {
    file: "src/mcp.ts",
    in: "discoverTool",
    code: "new StdioClientTransport(",
    where: "supervisor",
    why: "a poll's tool server: the machine's own, or a plugin's `docker run` into its worker",
  },
  {
    file: "src/mcp.ts",
    in: "callTool",
    code: "new StdioClientTransport(",
    where: "supervisor",
    why: "a poll's tool server: the machine's own, or a plugin's `docker run` into its worker",
  },
  {
    file: "src/sandbox/tools.ts",
    in: "connectTools",
    code: "new StdioClientTransport(",
    where: "supervisor",
    why: "a session's tool servers through `mcp-proxy`, the supervisor's relay",
  },
  { file: "src/sandbox/worker.ts", in: "worker", code: "spawn(run.command", where: "supervisor", why: "the docker client starting a worker" },
  { file: "src/sandbox/worker.ts", in: "run", code: "promisify(execFile)", where: "supervisor", why: "the docker client: volume, removal and inspection" },
  { file: "src/sandbox/egress.ts", in: "run", code: "promisify(execFile)", where: "supervisor", why: "the docker client: a worker's network" },
  {
    file: "src/sandbox/egress.ts",
    in: "hostAddressesFrom",
    code: "spawn(docker, [",
    where: "supervisor",
    why: "the docker client starting the host-address helper: the runner's own code, on the host's network, no capability",
  },
  {
    file: "src/attachments.ts",
    in: "writeAnchored",
    code: "spawn(process.execPath",
    where: "supervisor",
    why: "the runner's own writer of an attachment into a run folder, no code of the server's",
  },
  {
    file: "src/main.ts",
    in: "detectClis",
    code: "promisify(execFile)(claudePath",
    where: "supervisor",
    why: "`claude --version` at start, the machine's own CLI",
  },
  {
    file: "src/codex/version.ts",
    in: "codexStatus",
    code: "promisify(execFile)",
    where: "supervisor",
    why: "`codex --version` at start, the machine's own CLI",
  },
  {
    file: "src/codex/version.ts",
    in: "codexStatus",
    code: "CodexRpc.spawn(",
    where: "supervisor",
    why: "whether the machine's own Codex is signed in, at start",
  },
  {
    file: "src/main.ts",
    in: "signIn",
    code: "spawn(cli, argv",
    where: "supervisor",
    why: "`dispand-runner sign-in`: the CLI's own login into the supervisor's store, typed on the machine",
  },
  {
    file: "src/subscriptions/supervisor.ts",
    in: "codexIdentity",
    code: "CodexRpc.spawn(",
    where: "supervisor",
    why: "the personal subscription's status and renewal, on the supervisor's own login store",
  },
  {
    file: "src/subscriptions/supervisor.ts",
    in: "codexRenew",
    code: "CodexRpc.spawn(",
    where: "supervisor",
    why: "the personal subscription's status and renewal, on the supervisor's own login store",
  },
  {
    file: "src/codex/personal.ts",
    in: "fetch",
    code: "CodexRpc.spawn(",
    where: "supervisor",
    why: "a personal subscription's credential for the relay, read from the supervisor's own login store",
  },
  {
    file: "src/updates.ts",
    in: "startUpdates",
    code: "promisify(execFile)",
    where: "supervisor",
    why: "the bare install's updater (systemd), never in the image",
  },
  {
    file: "src/plugins.ts",
    in: "skillshareExec",
    code: "spawn(binary",
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

/** Code with its layout taken out (whitespace, trailing commas), so a reformatted site still matches its entry. */
const flat = (code: string) => code.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");

/**
 * What a node that starts a process is given (its arguments, or a declaration's parameters): node's spawners and
 * `promisify(execFile)`, Codex's app-server (`CodexRpc.spawn`), the Agent SDK's CLI (`query({`), MCP's stdio client.
 */
function launch(node: ts.Node): ts.NodeArray<ts.Node> | undefined {
  if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) return SPAWNERS.includes(node.name?.getText() ?? "") ? node.parameters : undefined;
  if (ts.isNewExpression(node)) return node.expression.getText() === "StdioClientTransport" ? node.arguments : undefined;
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  const [first] = node.arguments;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText();
  const spawns = SPAWNERS.includes(name) || (name === "promisify" && first?.getText() === "execFile");
  return spawns || (/\bquery\)?$/.test(callee.getText()) && first && ts.isObjectLiteralExpression(first)) ? node.arguments : undefined;
}

/** The class member (or top-level declaration) a node is in. */
function member(node: ts.Node): string {
  while (!ts.isClassLike(node.parent) && !ts.isSourceFile(node.parent)) node = node.parent;
  if (ts.isVariableStatement(node)) node = node.declarationList.declarations[0]!;
  return ts.isConstructorDeclaration(node) ? "constructor" : (ts.getNameOfDeclaration(node as ts.Declaration)?.getText() ?? "(top level)");
}

test("every process the runner starts is classified, and each worker site passes a worker's launch", () => {
  const found = sources("src").flatMap((path) => {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const sites: { file: string; line: number; in: string; code: string; given: string }[] = [];
    const visit = (node: ts.Node) => {
      const given = launch(node);
      if (given) {
        // Read with what decides it: the call it is the callee of (`promisify(execFile)(…)`), the condition it is a branch of.
        let site = node;
        if (ts.isCallExpression(site.parent) && site.parent.expression === site) site = site.parent;
        if (ts.isConditionalExpression(site.parent)) site = site.parent;
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        sites.push({ file: relative(".", path), line, in: member(node), code: site.getText(), given: file.text.slice(given.pos, given.end) });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return sites;
  });
  const classifies = (s: Site, f: (typeof found)[number]) => s.file === f.file && s.in === f.in && flat(f.code).startsWith(flat(s.code));
  const unclassified = found.filter((f) => !SITES.some((s) => classifies(s, f)));
  expect(
    unclassified.map((f) => `${f.file}:${f.line} ${f.in}: ${f.code.replace(/\s+/g, " ").slice(0, 120)}`),
    "a new launch site: classify it in SITES",
  ).toEqual([]);
  const stale = SITES.filter((s) => found.filter((f) => classifies(s, f)).length !== 1);
  expect(
    stale.map((s) => `${s.file} ${s.in}: ${s.code}`),
    "a classified site that no longer exists, or that stands for more than one",
  ).toEqual([]);
  for (const site of found.filter((f) => SITES.find((s) => classifies(s, f))!.where === "worker")) {
    // What the call is given (or the declaration takes): a worker's launch passed along.
    expect(site.given, `${site.file}:${site.line} runs in a worker: it must pass a launch`).toMatch(/launch/i);
  }
});
