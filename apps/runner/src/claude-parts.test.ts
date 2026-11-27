import type { CanUseTool, HookCallback, McpServerConfig, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSessionStart } from "@dispand/runner-protocol";
import { expect, test, vi } from "vitest";
import { permissionBoundary } from "./boundary.ts";
import { type ClaudeDeps, type ClaudeState, claudeOptions, readToEnd, turnEnded } from "./claude.ts";
import { toolPolicy } from "./tool-policy.ts";
import { PLANS_DIR } from "./workdir.ts";

const start: ClaudeSessionStart = {
  sessionId: "ses_1",
  harness: "claude-code",
  cwd: { mode: "per-run", runKey: "run_1" },
  systemPrompt: "You write summaries.",
  prompt: "Summarize",
  expectedOutputs: [{ name: "summary", description: "One line", type: "string" }],
  interactive: true,
  permissionMode: "default",
  skills: [],
  mcpServers: [],
};
const cwd = "/runs/run_1";

/** The options a session with `over` and `deps` hands the SDK, with what it passed in to compare against. */
function optionsFor(over: Partial<ClaudeSessionStart> = {}, deps: ClaudeDeps = {}, roots: { pluginRoots?: string[]; nativePlugins?: string[] } = {}) {
  const s = { ...start, ...over } as ClaudeSessionStart;
  const tools = toolPolicy(s, { harness: "claude-code", bypass: s.permissionMode === "bypassPermissions", forbidden: [] });
  const given = {
    queryAbort: new AbortController(),
    sdkServers: { dispand: { type: "stdio", command: "true" } } as Record<string, McpServerConfig>,
    canUseTool: vi.fn() as unknown as CanUseTool,
    hook: vi.fn() as unknown as HookCallback,
  };
  const options = claudeOptions({
    start: s,
    cwd,
    deps,
    pluginRoots: roots.pluginRoots ?? [],
    nativePlugins: roots.nativePlugins ?? [],
    boundary: permissionBoundary(cwd, "/nowhere", {}, []),
    tools,
    ...given,
  });
  return { options, given, tools };
}

test.each([
  ["default", "default"],
  ["acceptEdits", "acceptEdits"],
  ["plan", "plan"],
  // Dispand's broker implements bypass itself: the CLI's own would skip the managed MCP checks.
  ["bypassPermissions", "default"],
] as const)("in %s mode the CLI gets permission mode %s, the user's settings and the session's callbacks", (mode, cliMode) => {
  const { options, given, tools } = optionsFor({ permissionMode: mode });
  expect(options.permissionMode).toBe(cliMode);
  expect(options.cwd).toBe(cwd);
  expect(options.abortController).toBe(given.queryAbort);
  expect(options.settingSources).toEqual(["user"]);
  expect(options).not.toHaveProperty("tools");
  expect(options).not.toHaveProperty("strictMcpConfig");
  expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: start.systemPrompt });
  expect(options.includePartialMessages).toBe(true);
  expect(options.mcpServers).toBe(given.sdkServers);
  expect(options.canUseTool).toBe(given.canUseTool);
  expect(options.hooks).toEqual({ PreToolUse: [{ hooks: [given.hook] }] });
  expect(options.disallowedTools).toEqual(tools.disabled());
  expect(options.settings).toMatchObject({ plansDirectory: PLANS_DIR, disableSkillShellExecution: true });
  for (const absent of ["resume", "model", "plugins", "env", "pathToClaudeCodeExecutable"]) expect(options).not.toHaveProperty(absent);
});

test.each(["default", "bypassPermissions"] as const)(
  "a restricted start in %s mode gets no settings of the user's, no built-in tool, only its servers and no advisor",
  (mode) => {
    const { options } = optionsFor({ permissionMode: mode, restricted: true }, { env: { PATH: "/bin" } });
    expect(options.permissionMode).toBe("default");
    expect(options.settingSources).toEqual([]);
    expect(options.tools).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.env).toEqual({ PATH: "/bin", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" });
  },
);

test("a resumed session gets its CLI session and model, the environment given, and the signed-in binary", () => {
  const env = { PATH: "/bin" };
  const { options } = optionsFor({ resumeCliSessionId: "cli-0", model: "claude-model" }, { env, claudePath: "/opt/claude" });
  expect(options.resume).toBe("cli-0");
  expect(options.model).toBe("claude-model");
  expect(options.env).toBe(env);
  expect(options.pathToClaudeCodeExecutable).toBe("/opt/claude");
});

test("skill packages load without their MCP servers, then native plugins whole", () => {
  const { options } = optionsFor({}, {}, { pluginRoots: ["/p/skills"], nativePlugins: ["/p/native"] });
  expect(options.plugins).toEqual([
    { type: "local", path: "/p/skills", skipMcpDiscovery: true },
    { type: "local", path: "/p/native" },
  ]);
});

type Result = Extract<SDKMessage, { type: "result" }>;
const result = (fields: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", result: "done", session_id: "cli-1", ...fields }) as Result;

/** A turn's end with the session in `state`, `waiting` messages unanswered and a steer on its way or not. */
function ending(over: { state?: Partial<ClaudeState>; waiting?: number; steering?: boolean } = {}) {
  const state: ClaudeState = {
    finished: false,
    reportedTurnId: "turn_1",
    interrupted: false,
    turnAbort: new AbortController(),
    askedWhileSteering: false,
    approval: null,
    ...over.state,
  };
  const input = {
    answered: vi.fn(),
    steersTaken: vi.fn(),
    steering: () => over.steering ?? false,
    steersQueued: vi.fn(),
    waiting: () => over.waiting ?? 0,
  };
  const outcome = { turnEnded: vi.fn() };
  return { state, input, outcome, ctx: { state, input, outcome } };
}

test.each([
  ["a result", result(), {}, { interrupted: false, text: "done", queued: false }],
  [
    "a success with is_error",
    result({ is_error: true, result: "API error" }),
    {},
    { interrupted: false, error: "API error", text: "API error", queued: false },
  ],
  [
    "an error result",
    result({ subtype: "error_during_execution", errors: ["one", "two"] }),
    {},
    { interrupted: false, error: "one; two", text: "", queued: false },
  ],
  [
    "an error result without errors",
    result({ subtype: "error_max_turns", errors: [] }),
    {},
    { interrupted: false, error: "error_max_turns", text: "", queued: false },
  ],
  ["a turn interrupted from here", result(), { state: { interrupted: true } }, { interrupted: true, text: "done", queued: false }],
  ["a turn aborted mid-stream", result({ terminal_reason: "aborted_streaming" }), {}, { interrupted: true, text: "done", queued: false }],
  ["a turn with messages still waiting", result(), { waiting: 2 }, { interrupted: false, text: "done", queued: true }],
  [
    "an interrupted turn a steer was on its way to",
    result({ terminal_reason: "aborted_tools" }),
    { state: { interrupted: true }, steering: true },
    { interrupted: true, text: "done", queued: false },
  ],
  [
    "a turn a steer cut after a question",
    result({ terminal_reason: "aborted_tools" }),
    { state: { askedWhileSteering: true }, steering: true },
    { interrupted: true, text: "done", queued: false },
  ],
] as const)("%s ends the turn as the outcome's turn end", (_name, msg, over, expected) => {
  const { state, input, outcome, ctx } = ending(over);
  turnEnded(msg, ctx);
  expect(outcome.turnEnded).toHaveBeenCalledExactlyOnceWith(expected);
  expect(input.answered).toHaveBeenCalledWith(msg);
  expect(input.steersQueued).toHaveBeenCalledOnce();
  expect(state).toMatchObject({ reportedTurnId: undefined, interrupted: false, askedWhileSteering: false });
});

test("a turn a steer cut, with no question asked meanwhile, goes on: no turn end, its questions withdrawn", () => {
  const { state, input, outcome, ctx } = ending({ steering: true, waiting: 1 });
  const cut = state.turnAbort;
  turnEnded(result({ terminal_reason: "aborted_tools", user_message_uuids: ["u1"] }), ctx);
  expect(outcome.turnEnded).not.toHaveBeenCalled();
  expect(input.steersQueued).not.toHaveBeenCalled();
  expect(input.steersTaken).toHaveBeenCalledWith(["u1"]);
  expect(cut.signal.aborted).toBe(true);
  expect(state.turnAbort).not.toBe(cut);
  expect(state.turnAbort.signal.aborted).toBe(false);
  expect(state.reportedTurnId).toBe("turn_1");
});

test("a turn's end settles a pending approval as not approved and leaves none for the next turn", async () => {
  const settle = vi.fn();
  const { state, ctx } = ending({ state: { approval: { answered: new Promise<boolean>(() => {}), settle } } });
  turnEnded(result(), ctx);
  expect(settle).toHaveBeenCalledWith(false);
  expect(state.approval).toBeNull();
});

async function* stream(messages: SDKMessage[], end?: unknown): AsyncGenerator<SDKMessage> {
  for (const msg of messages) yield msg;
  if (end !== undefined) throw end;
}

test.each([
  ["once the input is closed, is no error", { closed: true }, null],
  ["with the input still open, is the CLI exiting early", { closed: false }, "the CLI exited before the session finished"],
  ["with an error, ends the session with it", { closed: false, end: new Error("boom") }, "boom"],
  ["with something thrown that isn't an error, ends the session with it", { closed: true, end: "gone" }, "gone"],
] as const)("the CLI's stream ending %s", async (_name, how, message) => {
  const read = vi.fn();
  const finish = vi.fn();
  const input = { isClosed: () => how.closed, close: vi.fn() };
  const questions = { endAll: vi.fn() };
  const messages = [result(), result({ result: "again" })];
  await readToEnd({ q: stream(messages, "end" in how ? how.end : undefined), read, input, questions, finish });
  expect(read.mock.calls).toEqual(messages.map((msg) => [msg]));
  if (message === null) expect(finish).not.toHaveBeenCalled();
  else expect(finish).toHaveBeenCalledExactlyOnceWith({ type: "error", message });
  expect(input.close).toHaveBeenCalledOnce();
  expect(questions.endAll).toHaveBeenCalledOnce();
});
