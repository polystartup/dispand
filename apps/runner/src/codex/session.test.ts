import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Answer, HarnessEvent } from "@dispand/runner-protocol";
import { afterEach, expect, test, vi } from "vitest";
import { machineConfigPaths } from "../config.ts";
import { fakeCodex } from "../fixtures/fake-codex-bin.ts";
import { BypassRefused, type HarnessSession } from "../outcome.ts";
import { type CodexDeps, type CodexSessionStart, PROFILE_REFUSED, startCodexSession } from "./session.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const base: CodexSessionStart = {
  sessionId: "ses_1",
  harness: "codex",
  cwd: { mode: "per-run", runKey: "run_1" },
  systemPrompt: "You write summaries.",
  prompt: "Summarize",
  expectedOutputs: [],
  interactive: false,
  permissionMode: "default",
  skills: [],
  mcpServers: [],
};

type Step = { notify?: string; request?: string; params?: unknown; waitInterrupt?: boolean; fail?: string };
const message = (text: string): Step => ({ notify: "item/completed", params: { threadId: "$THREAD", item: { type: "agentMessage", id: `m_${text}`, text } } });
const request = (method: string, params: Record<string, unknown>): Step => ({ request: method, params: { threadId: "$THREAD", turnId: "$TURN", ...params } });

/** Runs a session on the fake Codex, whose turns play `turns`; questions get `answer`'s reply. */
async function run(o: {
  turns?: Step[][];
  start?: Partial<CodexSessionStart>;
  deps?: Partial<CodexDeps>;
  env?: Record<string, string>;
  answer?: (e: Extract<HarnessEvent, { type: "question" }>) => Answer | undefined;
}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "codex-session-")));
  made.push(dir);
  const cwd = join(dir, "work");
  await mkdir(cwd);
  const codex = await fakeCodex(made, { FAKE_CODEX_TURNS: JSON.stringify(o.turns ?? []), ...o.env });
  const events: HarnessEvent[] = [];
  const session: HarnessSession = startCodexSession({ ...base, ...o.start } as CodexSessionStart, cwd, (e) => {
    events.push(e);
    const reply = e.type === "question" ? o.answer?.(e) : undefined;
    if (e.type === "question" && reply) queueMicrotask(() => session.answer(e.questionId, reply));
  }, { codexPath: codex.path, env: codex.env, secrets: [], ...o.deps });
  const sent = async (method: string) => (await codex.received()).filter((m) => m.method === method);
  /** The runner's reply to server request `id`. */
  const replyTo = async (id: string) => vi.waitFor(async () => (await codex.received()).find((m) => m.id === id && m.method === undefined)!.result as Record<string, unknown>);
  const ended = () => vi.waitFor(() => expect(events.some((e) => e.type === "result" || e.type === "error")).toBe(true));
  return { dir, cwd, events, session, sent, replyTo, ended, received: codex.received };
}

const questions = (events: HarnessEvent[]) => events.filter((e): e is Extract<HarnessEvent, { type: "question" }> => e.type === "question");

test("a session starts a thread with Dispand's profile and instructions, streams its turn and ends with its last message", async () => {
  const s = await run({
    turns: [
      [
        { notify: "item/agentMessage/delta", params: { threadId: "$THREAD", turnId: "$TURN", itemId: "m", delta: "Hel" } },
        { notify: "item/started", params: { threadId: "$THREAD", item: { type: "commandExecution", id: "c1", command: "ls" } } },
        { notify: "item/completed", params: { threadId: "$THREAD", item: { type: "commandExecution", id: "c1", command: "ls" } } },
        // A subagent's own items stay inside it.
        { notify: "item/agentMessage/delta", params: { threadId: "thr_sub", turnId: "x", itemId: "m", delta: "sub" } },
        message("Hello"),
      ],
    ],
    start: { model: "gpt-5.5-codex" },
  });
  await s.ended();
  expect(s.events).toEqual([
    { type: "cli-session", cliSessionId: "thr_1" },
    { type: "text", delta: "Hel" },
    { type: "tool", name: "Shell", status: "started" },
    { type: "tool", name: "Shell", status: "done" },
    { type: "result", text: "Hello" },
  ]);
  const [thread] = await s.sent("thread/start");
  expect(thread!.params).toMatchObject({
    cwd: s.cwd,
    model: "gpt-5.5-codex",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    developerInstructions: "You write summaries.",
    config: { default_permissions: "dispand", shell_environment_policy: { exclude: ["DISPAND_*"] } },
    dynamicTools: [{ type: "function", name: "submit_outputs" }],
  });
  expect(JSON.stringify(thread)).not.toContain("trust_level");
  const [turn] = await s.sent("turn/start");
  expect(turn!.params).toEqual({ threadId: "thr_1", input: [{ type: "text", text: "Summarize", text_elements: [] }] });
  await s.session.done;
});

test("thread/start denies every machine config path", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "codex-home-")));
  made.push(home);
  const secrets = machineConfigPaths(join(home, ".config", "dispand-runner"), {}, home);
  expect(secrets).toContain(join(home, ".codex"));
  const s = await run({ deps: { secrets } });
  await s.ended();
  const [thread] = await s.sent("thread/start");
  const filesystem = (thread!.params as { config: { permissions: { dispand: { filesystem: Record<string, unknown> } } } }).config.permissions.dispand.filesystem;
  for (const path of secrets) expect(filesystem[path], path).toBe("deny");
});

test("where a symlink inside a machine config path leads is denied too", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "codex-home-")));
  made.push(home);
  await mkdir(join(home, ".codex"));
  await mkdir(join(home, "vault"));
  await writeFile(join(home, "vault", "auth.json"), "{}");
  await symlink(join(home, "vault", "auth.json"), join(home, ".codex", "auth.json"));
  const s = await run({ deps: { secrets: [join(home, ".codex")] } });
  await s.ended();
  const [thread] = await s.sent("thread/start");
  const filesystem = (thread!.params as { config: { permissions: { dispand: { filesystem: Record<string, unknown> } } } }).config.permissions.dispand.filesystem;
  expect(filesystem[join(home, "vault", "auth.json")]).toBe("deny");
});

test("profile not active → refused, before any turn", async () => {
  const s = await run({ env: { FAKE_CODEX_PROFILE: "" } });
  await s.ended();
  expect(s.events).toEqual([{ type: "error", message: PROFILE_REFUSED }]);
  expect(PROFILE_REFUSED).toContain("sandbox_mode");
  expect(await s.sent("turn/start")).toEqual([]);
  await s.session.done;
});

test("bypass refused without allowBypass; with it, Codex runs unsandboxed and asks nothing", async () => {
  expect(() => startCodexSession({ ...base, permissionMode: "bypassPermissions" }, "/work", () => {}, { codexPath: "/nonexistent", secrets: [] })).toThrow(BypassRefused);
  const s = await run({ start: { permissionMode: "bypassPermissions" }, deps: { allowBypass: true }, env: { FAKE_CODEX_PROFILE: ":danger-full-access" } });
  await s.ended();
  expect(s.events.at(-1)).toEqual({ type: "result", text: "" });
  const [thread] = await s.sent("thread/start");
  expect(thread!.params).toMatchObject({ approvalPolicy: "never", config: { default_permissions: ":danger-full-access" } });
});

test("command approval asks and maps allow-always to acceptForSession; an execpolicy amendment is never sent", async () => {
  const offered = ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm", "x"] } }, "cancel"];
  const approval = (itemId: string) =>
    request("item/commandExecution/requestApproval", { itemId, kind: "command", command: "rm x", cwd: "/work", reason: null, availableDecisions: offered, proposedExecpolicyAmendment: ["rm", "x"] });
  const decisions = ["allow-always", "allow", "deny"] as const;
  let i = 0;
  const s = await run({
    turns: [[approval("c1"), approval("c2"), approval("c3")]],
    answer: () => ({ kind: "permission", decision: decisions[i++]! }),
  });
  await s.ended();
  expect(questions(s.events)[0]!.payload).toEqual({ kind: "permission", toolName: "Shell", input: { command: "rm x", cwd: "/work", reason: "" }, canAlwaysAllow: true });
  expect((await s.replyTo("r0")).decision).toBe("acceptForSession");
  expect((await s.replyTo("r1")).decision).toBe("accept");
  expect((await s.replyTo("r2")).decision).toBe("decline");
});

test("a command asked about again (retry without sandbox), with more permissions, not named or for a terminal's stdin is declined without a question", async () => {
  const approval = (itemId: string, extra: Record<string, unknown> = {}) =>
    request("item/commandExecution/requestApproval", { itemId, kind: "command", command: "cat ~/.codex/auth.json", ...extra });
  const s = await run({
    turns: [
      [
        approval("c1"),
        approval("c1", { reason: "command failed; retry without sandbox?" }),
        approval("c2", { additionalPermissions: { network: null, fileSystem: { write: ["/"] } } }),
        approval("c3", { command: null }),
        approval("c4", { kind: "writeStdin", approvalId: "stdin_1" }),
      ],
    ],
    answer: () => ({ kind: "permission", decision: "allow" }),
  });
  await s.ended();
  expect(questions(s.events)).toHaveLength(1);
  expect((await s.replyTo("r0")).decision).toBe("accept");
  expect((await s.replyTo("r1")).decision).toBe("decline");
  expect((await s.replyTo("r2")).decision).toBe("decline");
  expect((await s.replyTo("r3")).decision).toBe("decline");
  expect((await s.replyTo("r4")).decision).toBe("decline");
});

test("file changes outside the folder or into .codex are declined without a question; others ask with their paths and diff", async () => {
  const change = (itemId: string, path: string): Step[] => [
    { notify: "item/started", params: { threadId: "$THREAD", item: { type: "fileChange", id: itemId, changes: [{ path, kind: { type: "add" }, diff: "hi\n" }] } } },
    request("item/fileChange/requestApproval", { itemId }),
  ];
  const outside = await realpath(await mkdtemp(join(tmpdir(), "codex-outside-")));
  made.push(outside);
  const s = await run({
    turns: [
      [
        ...change("f1", join(outside, "x.txt")),
        ...change("f2", "$CWD/.codex/config.toml"),
        ...change("f3", "$CWD/../escape.txt"),
        ...change("f4", "$CWD/notes.md"),
        // An approval for changes the runner never saw.
        request("item/fileChange/requestApproval", { itemId: "unknown" }),
      ],
    ],
    answer: () => ({ kind: "permission", decision: "allow-always" }),
  });
  await s.ended();
  expect(questions(s.events).map((q) => q.payload)).toEqual([
    {
      kind: "permission",
      toolName: "FileChange",
      input: { changes: [{ path: join(s.cwd, "notes.md"), kind: { type: "add" }, diff: "hi\n" }], reason: "" },
      canAlwaysAllow: false,
    },
  ]);
  expect((await s.replyTo("r0")).decision).toBe("decline");
  expect((await s.replyTo("r1")).decision).toBe("decline");
  expect((await s.replyTo("r2")).decision).toBe("decline");
  expect((await s.replyTo("r3")).decision).toBe("accept");
  expect((await s.replyTo("r4")).decision).toBe("decline");
});

test("a permissions request gets an empty grant, without a question", async () => {
  const s = await run({ turns: [[request("item/permissions/requestApproval", { itemId: "p1", cwd: "/", reason: "need it", permissions: { fileSystem: { write: ["/"] } } })]] });
  await s.ended();
  expect(questions(s.events)).toEqual([]);
  expect(await s.replyTo("r0")).toEqual({ permissions: {}, scope: "turn" });
});

test("requestUserInput becomes a choice question, answered by question id; a secret question isn't asked", async () => {
  const q = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    header: "Pick",
    question: `Which ${id}?`,
    isOther: true,
    isSecret: false,
    options: [{ label: "A", description: "first" }],
    ...extra,
  });
  const s = await run({
    turns: [
      [
        request("item/tool/requestUserInput", { itemId: "u1", questions: [q("color"), q("size", { isOther: false, options: null })], isBlocking: true, autoResolutionMs: null }),
        request("item/tool/requestUserInput", { itemId: "u2", questions: [q("token", { isSecret: true })], isBlocking: true, autoResolutionMs: null }),
      ],
    ],
    answer: () => ({ kind: "choice", answers: { "Which color?": "A", "Which size?": "big" } }),
  });
  await s.ended();
  expect(questions(s.events).map((e) => e.payload)).toEqual([
    {
      kind: "choice",
      questions: [
        { question: "Which color?", header: "Pick", options: [{ label: "A", description: "first" }, { label: "Other" }], multiSelect: false },
        { question: "Which size?", header: "Pick", options: [], multiSelect: false },
      ],
    },
  ]);
  expect(await s.replyTo("r0")).toEqual({ answers: { color: { answers: ["A"] }, size: { answers: ["big"] } } });
  expect(await s.replyTo("r1")).toEqual({ answers: {} });
});

test.each([
  ["url", { mode: "url", message: "Sign in", url: "https://example.invalid", elicitationId: "e1", _meta: null }],
  ["form", { mode: "form", message: "Name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } }, _meta: null }],
])("%s elicitation declined", async (_mode, params) => {
  const s = await run({ turns: [[{ request: "mcpServer/elicitation/request", params: { threadId: "$THREAD", turnId: "$TURN", serverName: "x", ...params } }]] });
  await s.ended();
  expect(questions(s.events)).toEqual([]);
  expect(await s.replyTo("r0")).toEqual({ action: "decline", content: null, _meta: null });
});

test("an MCP tool call's approval becomes a permission question, asked each time", async () => {
  const approval = (tool: string, params: Record<string, unknown>) => ({
    request: "mcpServer/elicitation/request",
    params: {
      threadId: "$THREAD",
      turnId: "$TURN",
      serverName: "github",
      mode: "form",
      message: `Allow the github MCP server to run tool "${tool}"?`,
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_name: tool, tool_params: params },
    },
  });
  const answers: Answer[] = [
    { kind: "permission", decision: "allow-always" },
    { kind: "permission", decision: "deny" },
  ];
  const s = await run({ turns: [[approval("create_issue", { title: "Bug" }), approval("delete_repo", { repo: "x" }), message("Done")]], answer: () => answers.shift() });
  await s.ended();
  expect(questions(s.events).map((q) => q.payload)).toEqual([
    { kind: "permission", toolName: "mcp__github__create_issue", input: { title: "Bug" }, canAlwaysAllow: false },
    { kind: "permission", toolName: "mcp__github__delete_repo", input: { repo: "x" }, canAlwaysAllow: false },
  ]);
  // Never "for the session" or "always": the next call asks again.
  expect(await s.replyTo("r0")).toEqual({ action: "accept", content: {}, _meta: null });
  expect(await s.replyTo("r1")).toEqual({ action: "decline", content: null, _meta: null });
});

test("header not in thread/start: its value only in the app-server's environment", async () => {
  const envLog = join(await realpath(await mkdtemp(join(tmpdir(), "codex-env-"))), "env.json");
  made.push(dirname(envLog));
  const s = await run({
    turns: [[message("Done")]],
    env: { FAKE_CODEX_ENV_LOG: envLog },
    deps: { mcp: { servers: { github: { url: "https://api.example.test/mcp", env_http_headers: { authorization: "DISPAND_MCP_0_0" } } }, env: { DISPAND_MCP_0_0: "Bearer s3cret" } } },
  });
  await s.ended();
  const [thread] = await s.sent("thread/start");
  expect(JSON.stringify(thread)).not.toContain("s3cret");
  expect((thread!.params as { config: { mcp_servers: unknown } }).config.mcp_servers).toEqual({
    github: { url: "https://api.example.test/mcp", env_http_headers: { authorization: "DISPAND_MCP_0_0" } },
  });
  expect(JSON.parse(readFileSync(envLog, "utf8"))).toEqual({ DISPAND_MCP_0_0: "Bearer s3cret" });
});

test("submit_outputs confirm flow: feedback goes back as the tool's output, a confirmation ends the session", async () => {
  const submit = (summary: string) => request("item/tool/call", { callId: `c_${summary}`, namespace: null, tool: "submit_outputs", arguments: { summary } });
  const answers: Answer[] = [
    { kind: "confirm-outputs", confirmed: false, feedback: "Shorter please" },
    { kind: "confirm-outputs", confirmed: true },
  ];
  const s = await run({
    turns: [[submit("A long summary"), submit("Short"), message("Done")]],
    start: { interactive: true, expectedOutputs: [{ name: "summary", description: "One line", type: "string" }] },
    answer: () => answers.shift(),
  });
  await s.ended();
  expect(await s.replyTo("r0")).toEqual({ contentItems: [{ type: "inputText", text: "Shorter please" }], success: true });
  expect(await s.replyTo("r1")).toEqual({ contentItems: [{ type: "inputText", text: "confirmed" }], success: true });
  expect(s.events.slice(-2)).toEqual([
    { type: "outputs-accepted", values: { summary: "Short" } },
    { type: "result", text: "Done" },
  ]);
  const [thread] = await s.sent("thread/start");
  expect((thread!.params as { dynamicTools: unknown[] }).dynamicTools).toEqual([
    {
      type: "function",
      name: "submit_outputs",
      description: expect.any(String),
      inputSchema: { type: "object", properties: { summary: { type: "string", description: "One line" } }, required: ["summary"], additionalProperties: false },
    },
  ]);
});

test("a non-interactive agent without its outputs is reminded once, then fails", async () => {
  const s = await run({ start: { expectedOutputs: [{ name: "summary", type: "string" }] } });
  await s.ended();
  expect(s.events.at(-1)).toEqual({ type: "error", message: "the agent finished without its outputs" });
  expect((await s.sent("turn/start")).map((m) => (m.params as { input: { text: string }[] }).input[0]!.text)).toEqual(["Summarize", "Call submit_outputs with: summary"]);
});

test("an interrupt cuts the running turn: an interactive session waits for the next message", async () => {
  const s = await run({ turns: [[{ waitInterrupt: true }], [message("Again")]], start: { interactive: true } });
  await vi.waitFor(async () => expect(await s.sent("turn/start")).toHaveLength(1));
  await vi.waitFor(() => expect(s.events).toContainEqual({ type: "cli-session", cliSessionId: "thr_1" }));
  await s.session.interrupt();
  await vi.waitFor(() => expect(s.events.at(-1)).toEqual({ type: "turn-end" }));
  expect((await s.sent("turn/interrupt"))[0]!.params).toEqual({ threadId: "thr_1", turnId: "turn_0" });
  s.session.send("Go on");
  await vi.waitFor(async () => expect(await s.sent("turn/start")).toHaveLength(2));
  s.session.stop("test over");
  await s.session.done;
});

test("an interrupt before Codex names the turn is sent once it does", async () => {
  const s = await run({ turns: [[{ waitInterrupt: true }]], start: { interactive: true }, env: { FAKE_CODEX_TURN_START_DELAY: "300" } });
  await vi.waitFor(async () => expect(await s.sent("turn/start")).toHaveLength(1));
  await s.session.interrupt();
  await vi.waitFor(() => expect(s.events.at(-1)).toEqual({ type: "turn-end" }));
  expect((await s.sent("turn/interrupt"))[0]!.params).toEqual({ threadId: "thr_1", turnId: "turn_0" });
  s.session.stop("test over");
  await s.session.done;
});

test("an interrupt reaches the running turn, not one whose turn/start reply came with its end", async () => {
  // The fake sends turn 0's reply, turn/started and turn/completed together: "Next" is queued by then.
  const s = await run({ turns: [[], [{ waitInterrupt: true }]], start: { interactive: true }, env: { FAKE_CODEX_BATCH: "1" } });
  s.session.send("Next");
  await vi.waitFor(async () => expect(await s.sent("turn/start")).toHaveLength(2));
  await s.session.interrupt();
  await vi.waitFor(async () => expect((await s.sent("turn/interrupt")).map((m) => m.params)).toEqual([{ threadId: "thr_1", turnId: "turn_1" }]));
  s.session.stop("test over");
  await s.session.done;
});

test("the prompt runs first, even when a message arrives while the thread opens", async () => {
  const s = await run({ turns: [[message("One")], [message("Two")]], start: { interactive: true } });
  s.session.send("And then this");
  await vi.waitFor(async () => expect(await s.sent("turn/start")).toHaveLength(2));
  expect((await s.sent("turn/start")).map((m) => (m.params as { input: { text: string }[] }).input[0]!.text)).toEqual(["Summarize", "And then this"]);
  s.session.stop("test over");
  await s.session.done;
});

test("a failed turn ends the session with its error", async () => {
  const s = await run({ turns: [[{ fail: "usage limit reached" }]] });
  await s.ended();
  expect(s.events.at(-1)).toEqual({ type: "error", message: "usage limit reached" });
});

test("a session resumes only the thread it is given, with the same overrides", async () => {
  const s = await run({ start: { resumeCliSessionId: "thr_old" } });
  await s.ended();
  expect(await s.sent("thread/start")).toEqual([]);
  const [resume] = await s.sent("thread/resume");
  expect(resume!.params).toMatchObject({ threadId: "thr_old", approvalPolicy: "untrusted", config: { default_permissions: "dispand" } });
  expect(s.events[0]).toEqual({ type: "cli-session", cliSessionId: "thr_old" });
});

test("skill packages are set as extra skill roots before the thread starts, readable in the profile", async () => {
  const s = await run({ deps: { pluginsDir: "/state/plugins", pluginRoots: ["/state/plugins/hello"] } });
  await s.ended();
  const methods = (await s.received()).map((m) => m.method).filter(Boolean);
  expect(methods.indexOf("skills/extraRoots/set")).toBeLessThan(methods.indexOf("thread/start"));
  expect((await s.sent("skills/extraRoots/set"))[0]!.params).toEqual({ extraRoots: ["/state/plugins/hello/skills"] });
  const [thread] = await s.sent("thread/start");
  expect(JSON.stringify(thread)).toContain('"/state/plugins":"read"');
});

test("a Codex that exits mid-session ends it with an error", async () => {
  const s = await run({ env: { FAKE_CODEX_EXIT_ON: "turn/start" } });
  await s.ended();
  expect(s.events.at(-1)).toMatchObject({ type: "error" });
  await s.session.done;
});

test("Codex's approval request for the Job server's tool is accepted without a question; another server's is asked", async () => {
  const approval = (serverName: string, tool: string) => ({
    request: "mcpServer/elicitation/request",
    params: {
      threadId: "$THREAD",
      turnId: "$TURN",
      serverName,
      mode: "form",
      message: `Allow the ${serverName} MCP server to run tool "${tool}"?`,
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_name: tool, tool_params: {} },
    },
  });
  const s = await run({
    turns: [[approval("job", "rows_create"), approval("github", "delete_repo"), message("Done")]],
    deps: { jobServer: "job" },
    answer: () => ({ kind: "permission", decision: "deny" }),
  });
  await s.ended();
  expect(questions(s.events).map((q) => (q.payload as { toolName: string }).toolName)).toEqual(["mcp__github__delete_repo"]);
  expect(await s.replyTo("r0")).toEqual({ action: "accept", content: {}, _meta: null });
  expect(await s.replyTo("r1")).toEqual({ action: "decline", content: null, _meta: null });
});
