import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent, SessionStart } from "@dispand/runner-protocol";
import { afterEach, expect, test, vi } from "vitest";
import { Connection } from "./connection.ts";
import { Sessions } from "./sessions.ts";
import { shutdown } from "./shutdown.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const start = (sessionId: string, runKey: string): SessionStart => ({
  sessionId,
  harness: "claude-code",
  cwd: { mode: "per-run", runKey },
  systemPrompt: "",
  prompt: "hi",
  expectedOutputs: [],
  interactive: true,
  permissionMode: "default",
  skills: [],
  mcpServers: [],
});

test("shutdown aborts live CLIs without an error, flushes the pending delta, keeps the resume mapping", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "shutdown-")));
  made.push(base);
  const calls: Options[] = [];
  // A CLI that reports its id, streams a delta, then keeps working until aborted.
  const working = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    calls.push(options!);
    async function* script(): AsyncGenerator<SDKMessage> {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "cli-1" } as SDKMessage;
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half a sent" } } } as SDKMessage;
      await new Promise((_resolve, reject) => options!.abortController!.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return Object.assign(script(), { interrupt: vi.fn(async () => undefined) });
  }) as unknown as typeof query;
  const backlogPath = join(base, "backlog.jsonl");
  const conn = new Connection({ server: "http://127.0.0.1:1", token: "t", seqPath: join(base, "state.json"), backlogPath, hello: () => ({ type: "hello", runnerVersion: "0", clis: {}, tools: [], liveSessions: [] }), onMessage: () => {} });
  const emitted: HarnessEvent[] = [];
  const resumeMap = join(base, "sessions.json");
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => {
      emitted.push(event);
      conn.emit(sessionId, event);
    },
    { claude: { query: working }, resumeMap, claudeVersion: "2.1.311" },
  );
  await sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  await vi.waitFor(() => expect(emitted.map((e) => e.type)).toEqual(["cli-session", "text"]));

  await shutdown(sessions, conn, 5000);
  expect(calls[0]!.abortController!.signal.aborted).toBe(true);
  expect(sessions.ids()).toEqual([]);
  // No error: the session is resumable, not failed.
  expect(emitted.map((e) => e.type)).toEqual(["cli-session", "text"]);
  const lines = (await readFile(backlogPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: HarnessEvent });
  expect(lines.map((l) => l.event)).toEqual([{ type: "cli-session", cliSessionId: "cli-1" }, { type: "text", delta: "half a sent" }]);
  expect(JSON.parse(await readFile(resumeMap, "utf8"))).toEqual({ "cli-1": "run_a" });
  // The run folder stays, for the resume.
  expect((await stat(join(base, "root", "runs", "run_a"))).isDirectory()).toBe(true);
  // Starts after shutdown begins don't launch.
  await sessions.handle({ type: "session.start", start: start("ses_2", "run_b") });
  expect(calls).toHaveLength(1);
});

test("the runner exits cleanly on SIGTERM", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sigterm-")));
  made.push(base);
  const config = join(base, "config");
  await mkdir(config);
  await writeFile(join(config, "config.json"), JSON.stringify({ server: "http://127.0.0.1:1", roots: [join(base, "root")], token: "t" }), { mode: 0o600 });
  const child = spawn(process.execPath, ["src/main.ts", "run", "--config", config], { env: { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: "" } });
  let out = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", () => {});
  // Printed after the signal handlers are installed (main.ts).
  await vi.waitFor(() => expect(out).toContain("connecting"), { timeout: 10_000 });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  expect(await exited).toBe(0);
});

test("shutdown waits for a start still preparing its folder, which then cleans up and never launches", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "shutdown-")));
  made.push(base);
  let launched = 0;
  const q = (() => {
    launched++;
    return Object.assign((async function* () {})(), { interrupt: vi.fn(async () => undefined) });
  }) as unknown as typeof query;
  const conn = new Connection({ server: "http://127.0.0.1:1", token: "t", seqPath: join(base, "state.json"), hello: () => ({ type: "hello", runnerVersion: "0", clis: {}, tools: [], liveSessions: [] }), onMessage: () => {} });
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => conn.emit(sessionId, event),
    { claude: { query: q }, resumeMap: join(base, "sessions.json"), claudeVersion: "2.1.311" },
  );
  void sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  await shutdown(sessions, conn, 5000);
  // Right as shutdown returns: the start has finished, cleaned up, and launched nothing.
  expect(launched).toBe(0);
  await expect(stat(join(base, "root", "runs", "run_a"))).rejects.toThrow();
});
