// Every place the runner starts a process, and where it runs in the container image: a new
// launch site fails here until it is classified, and a site meant for a worker must pass the
// worker's launch (or command) along.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

/** Starts a process: node's spawners, Codex's app-server, the Agent SDK's CLI, MCP's stdio client. */
const LAUNCH = /\b(spawn|spawnSync|execFile|execFileSync|execSync|fork)\(|promisify\(execFile\)|CodexRpc\.spawn\(|\bquery\)?\(\{|new StdioClientTransport\(/;

type Site = { file: string; line: RegExp; where: "worker" | "supervisor"; why: string };

const SITES: Site[] = [
  { file: "src/claude.ts", line: /\(deps\.query \?\? query\)\(\{/, where: "worker", why: "a session's Claude Code, through `spawnIn(deps.launch)`" },
  { file: "src/codex/session.ts", line: /CodexRpc\.spawn\(/, where: "worker", why: "a session's Codex, through `deps.launch`" },
  { file: "src/commands.ts", line: /CodexRpc\.spawn\(/, where: "worker", why: "command discovery (Codex), in a scratch worker in the image" },
  { file: "src/commands.ts", line: /\bquery\(\{/, where: "worker", why: "command discovery (Claude Code), in a scratch worker in the image" },
  { file: "src/models.ts", line: /CodexRpc\.spawn\(/, where: "worker", why: "model discovery (Codex), in a scratch worker in the image" },
  { file: "src/models.ts", line: /\bquery\(\{/, where: "worker", why: "model discovery (Claude Code), in a scratch worker in the image" },
  { file: "src/codex/rpc.ts", line: /static async spawn\(/, where: "worker", why: "the app-server primitive: a worker's launch when one is given" },
  { file: "src/codex/rpc.ts", line: /launch \? launch\(/, where: "supervisor", why: "the app-server primitive: a worker's launch when its caller gives one, the machine otherwise (the bare install, the start-up checks)" },
  { file: "src/mcp-proxy.ts", line: /spawn\(spec\.command/, where: "supervisor", why: "a tool server: the machine's own (its config), or a plugin's `docker run` into its worker (`serveInWorker`)" },
  { file: "src/mcp.ts", line: /new StdioClientTransport\(/, where: "supervisor", why: "a poll's tool server: the machine's own, or a plugin's `docker run` into its worker" },
  { file: "src/sandbox/tools.ts", line: /new StdioClientTransport\(/, where: "supervisor", why: "a session's tool servers through `mcp-proxy`, the supervisor's relay" },
  { file: "src/sandbox/worker.ts", line: /spawn\(run\.command/, where: "supervisor", why: "the docker client starting a worker" },
  { file: "src/sandbox/worker.ts", line: /promisify\(execFile\)/, where: "supervisor", why: "the docker client: volume, removal and inspection" },
  { file: "src/sandbox/egress.ts", line: /promisify\(execFile\)/, where: "supervisor", why: "the docker client: a worker's network" },
  { file: "src/sandbox/egress.ts", line: /spawn\(docker, \[/, where: "supervisor", why: "the docker client starting the host-address helper: the runner's own code, on the host's network, no capability" },
  { file: "src/attachments.ts", line: /spawn\(process\.execPath/, where: "supervisor", why: "the runner's own writer of an attachment into a run folder, no code of the server's" },
  { file: "src/main.ts", line: /promisify\(execFile\)\(claudePath/, where: "supervisor", why: "`claude --version` at start, the machine's own CLI" },
  { file: "src/codex/version.ts", line: /promisify\(execFile\)/, where: "supervisor", why: "`codex --version` at start, the machine's own CLI" },
  { file: "src/codex/version.ts", line: /CodexRpc\.spawn\(/, where: "supervisor", why: "whether the machine's own Codex is signed in, at start" },
  { file: "src/main.ts", line: /spawn\(cli, argv/, where: "supervisor", why: "`dispand-runner sign-in`: the CLI's own login into the supervisor's store, typed on the machine" },
  { file: "src/subscriptions/supervisor.ts", line: /CodexRpc\.spawn\(/, where: "supervisor", why: "the personal subscription's status and renewal, on the supervisor's own login store" },
  { file: "src/updates.ts", line: /promisify\(execFile\)/, where: "supervisor", why: "the bare install's updater (systemd), never in the image" },
  { file: "src/plugins.ts", line: /spawn\(binary/, where: "supervisor", why: "native plugin management (Skillshare): refused by the image's gate" },
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return path.endsWith(join("codex", "protocol")) || e.name === "fixtures" ? [] : sources(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path] : [];
  });
}

test("every process the runner starts is classified, and each worker site passes a worker's launch", () => {
  const found = sources("src").flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    return lines.flatMap((text, i) => {
      if (!LAUNCH.test(text)) return [];
      // The whole call: from the match to the parenthesis that closes it.
      const match = LAUNCH.exec(text)!;
      const from = lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0) + match.index + match[0].lastIndexOf("(");
      let depth = 0;
      let end = from;
      for (; end < source.length; end++) {
        if (source[end] === "(") depth++;
        else if (source[end] === ")" && --depth === 0) break;
      }
      return [{ file: relative(".", file), line: i + 1, text: text.trim(), call: source.slice(from, end + 1) }];
    });
  });
  const unclassified = found.filter((f) => !SITES.some((s) => s.file === f.file && s.line.test(f.text)));
  expect(unclassified, "a new launch site: classify it in SITES").toEqual([]);
  const stale = SITES.filter((s) => !found.some((f) => s.file === f.file && s.line.test(f.text)));
  expect(stale.map((s) => `${s.file} ${s.line}`), "a classified site that no longer exists").toEqual([]);
  for (const site of found.filter((f) => SITES.find((s) => s.file === f.file && s.line.test(f.text))!.where === "worker")) {
    // The call itself (its first lines): a worker's launch passed along.
    expect(site.call, `${site.file}:${site.line} runs in a worker: it must pass a launch`).toMatch(/launch/i);
  }
});
