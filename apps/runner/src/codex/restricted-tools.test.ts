// The real Codex on this machine (skipped without one ≥ RESTRICTED_CODEX; run it again after every Codex update): what a restricted session's model is
// offered, read from the requests Codex sends to a stand-in Responses API, what its file tool does, and
// what its code-mode isolate can reach.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { atLeast } from "../sessions.ts";
import { type CodexSessionStart, startCodexSession } from "./session.ts";
import { RESTRICTED_CODEX } from "./version.ts";

const codexPath = (() => {
  try {
    const path = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
    return atLeast(/(\d+\.\d+\.\d+)/.exec(execFileSync(path, ["--version"], { encoding: "utf8" }))?.[1], RESTRICTED_CODEX) ? path : undefined;
  } catch {
    return undefined;
  }
})();

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** What the model may reach in a restricted session, besides code mode's own `exec` and `wait`. */
const ALLOWED = ["apply_patch", "clock__curr_time", "list_mcp_resource_templates", "list_mcp_resources", "read_mcp_resource", "submit_outputs", "mcp__job__echo"];
const PROBE = 'text(JSON.stringify(ALL_TOOLS.map((t) => t.name)));\ntry { await tools.apply_patch("*** Begin Patch\\n*** Add File: probe.txt\\n+hi\\n*** End Patch\\n"); text("written"); } catch (e) { text(String(e)); }\ntext("net:" + typeof fetch + "/" + typeof XMLHttpRequest + "/" + typeof WebSocket + "/" + typeof require + "/" + typeof process);';

type Tool = { type: string; name?: string; tools?: Tool[] };
const names = (tools: Tool[]): string[] => tools.flatMap((t) => (t.tools ? names(t.tools) : t.name ? [t.name] : []));

test.skipIf(!codexPath)("a restricted session on the real Codex offers only the Job's tools, and apply_patch reaches no file", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "codex-restricted-")));
  made.push(dir);
  const cwd = join(dir, "work");
  await mkdir(cwd);
  // The model's first answer runs PROBE in code mode, its second ends the turn.
  const bodies: { tools?: Tool[]; input: { type: string; tools?: Tool[]; output?: unknown }[] }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.url?.endsWith("/responses")) return void res.writeHead(404).end();
      bodies.push(JSON.parse(body));
      const n = bodies.length;
      const item = n === 1
        ? { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: PROBE }
        : { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: "Done" }] };
      const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(event("response.created", { response: { id: `r${n}` } }) + event("response.output_item.done", { item }) + event("response.completed", { response: { id: `r${n}`, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  // A Codex home of its own: the stand-in provider, and a server of the user's that must stay off.
  const home = join(dir, "codex-home");
  await mkdir(home);
  await writeFile(join(home, "config.toml"), `model = "gpt-6.1-sol"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n[mcp_servers.mine]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(resolve("src/fixtures/echo-mcp.ts"))}]\n`);
  const start: CodexSessionStart = {
    sessionId: "ses_1", harness: "codex", cwd: { mode: "per-run", runKey: "run_1" }, systemPrompt: "Decide.", prompt: "Decide.",
    expectedOutputs: [], interactive: false, permissionMode: "default", skills: [], mcpServers: [], restricted: true, jobToken: "dj_test",
  };
  try {
    const session = startCodexSession(start, cwd, () => {}, {
      codexPath: codexPath!,
      env: { ...process.env, CODEX_HOME: home },
      secrets: [],
      jobServer: "job",
      mcp: { servers: { job: { command: process.execPath, args: [resolve("src/fixtures/echo-mcp.ts")], default_tools_approval_mode: "prompt" } }, env: {} },
    });
    await session.done;
  } finally {
    server.close();
  }
  expect(bodies.length).toBeGreaterThanOrEqual(2);
  const offered = names([...(bodies[0]!.tools ?? []), ...bodies[0]!.input.flatMap((i) => (i.type === "additional_tools" ? (i.tools ?? []) : []))]);
  expect(offered.filter((name) => !["exec", "wait", ...ALLOWED].includes(name))).toEqual([]);
  const texts = (bodies[1]!.input.find((i) => i.type === "custom_tool_call_output")?.output ?? []) as { text?: string }[];
  const all = JSON.parse(texts.find((t) => t.text?.startsWith("["))!.text!) as string[];
  const output = JSON.stringify(texts);
  expect(all.filter((name) => !ALLOWED.includes(name))).toEqual([]);
  expect(all).toEqual(expect.arrayContaining(["submit_outputs", "mcp__job__echo"]));
  expect(output).toContain("No usable execution environment");
  expect(output).not.toContain("written");
  // Code mode's isolate itself: no network or Node API.
  expect(output).toContain("net:undefined/undefined/undefined/undefined/undefined");
});
