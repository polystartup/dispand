import type { Options, PermissionUpdate, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Answer, ClaudeSessionStart as SessionStart, HarnessEvent } from "@dispand/runner-protocol";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { BypassRefused, type ClaudeSession, pluginFailure, startClaudeSession } from "./claude.ts";
import { claudeEnv } from "./config.ts";

// Keeps the real SDK but exposes the in-process MCP server's tools, so a fake query can call them.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...sdk,
    createSdkMcpServer: (o: Parameters<typeof sdk.createSdkMcpServer>[0]) => ({ ...sdk.createSdkMcpServer(o), tools: o.tools }),
  };
});

type ToolDef = { name: string; handler: (args: Record<string, string>, extra: unknown) => Promise<{ content: { text: string }[] }> };

type Io = {
  options: Options;
  /** The next user message's text, or null once the runner closed the input. */
  next: () => Promise<string | null>;
  /** Calls the `dispand` MCP server's tool, as the CLI would. */
  callTool: (name: string, args: Record<string, string>) => Promise<string>;
  /** Settles once the runner called `interrupt()`. */
  interrupted: Promise<void>;
  /** The uuids of the user messages read so far, in order. */
  uuids: string[];
  /** For each message read, whether it came marked `client_composed` (delivered as written). */
  composed: boolean[];
};

/** A stand-in for the SDK's `query`: the script plays the CLI's side. */
/** The commands the fake CLI reports, as `supportedCommands()` does (built-ins flagged). */
const COMMANDS = [
  { name: "config", description: "", argumentHint: "", builtin: true },
  { name: "update-config", description: "", argumentHint: "", builtin: true },
  { name: "superpowers:brainstorming", description: "", argumentHint: "" },
  { name: "my-command", description: "", argumentHint: "", aliases: ["mc", "config"] },
  // A custom command that takes a built-in's name.
  { name: "update-config", description: "", argumentHint: "" },
];

function fakeQuery(script: (io: Io) => AsyncGenerator<SDKMessage>, mcp: { errors?: Record<string, string>; set?: Record<string, unknown>[] } = {}) {
  const calls: Options[] = [];
  const fn = ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    calls.push(options!);
    const input = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    let onInterrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => (onInterrupt = resolve));
    const uuids: string[] = [];
    const composed: boolean[] = [];
    const io: Io = {
      interrupted,
      uuids,
      composed,
      options: options!,
      next: async () => {
        const r = await input.next();
        if (!r.done && r.value.uuid) uuids.push(r.value.uuid);
        if (!r.done) composed.push(r.value.client_composed === true);
        return r.done ? null : String(r.value.message.content);
      },
      callTool: async (name, args) => {
        const server = options!.mcpServers!.dispand as unknown as { tools: ToolDef[] };
        const def = server.tools.find((t) => t.name === name)!;
        return (await def.handler(args, {})).content.map((c) => c.text).join("");
      },
    };
    return Object.assign(script(io), {
      supportedCommands: async () => COMMANDS,
      setMcpServers: async (servers: Record<string, unknown>) => {
        mcp.set?.push(servers);
        return { added: Object.keys(servers), removed: [], errors: mcp.errors ?? {} };
      },
      interrupt: vi.fn(async () => {
        onInterrupt();
        return undefined;
      }),
    });
  };
  return { query: fn as unknown as typeof query, calls };
}

const start: SessionStart = {
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

const init = { type: "system", subtype: "init", session_id: "cli-1" } as SDKMessage;
const result = (text = "done") => ({ type: "result", subtype: "success", result: text, session_id: "cli-1" }) as SDKMessage;
const delta = (text: string) =>
  ({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }) as SDKMessage;
/** The third argument of `canUseTool`. */
const ctx = (suggestions?: PermissionUpdate[]) => ({ signal: new AbortController().signal, toolUseID: "tu_1", requestId: "req_1", suggestions });

/** Starts a session whose questions get the given answer. */
function run(s: SessionStart, q: typeof query, answer?: (e: Extract<HarnessEvent, { type: "question" }>) => Answer) {
  const events: HarnessEvent[] = [];
  const session: ClaudeSession = startClaudeSession(s, "/work", (e) => {
    events.push(e);
    if (e.type === "question" && answer) queueMicrotask(() => session.answer(e.questionId, answer(e)));
  }, { query: q });
  return { events, session };
}

test("passes the session's options and streams text", async () => {
  const fake = fakeQuery(async function* ({ next }) {
    expect(await next()).toBe("Summarize");
    yield init;
    yield delta("Hel");
    yield delta("lo");
    yield result();
    // Like the real CLI in streaming mode: it exits once its input is closed.
    await next();
  });
  const { events, session } = run({ ...start, resumeCliSessionId: "cli-0", model: "sonnet" }, fake.query);
  await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "turn-end" }));
  session.close();
  await session.done;
  expect(fake.calls[0]).toMatchObject({
    cwd: "/work",
    // Never the run folder's own settings, hooks or MCP servers (controller ruling R30).
    settingSources: ["user"],
    systemPrompt: { type: "preset", preset: "claude_code", append: "You write summaries." },
    resume: "cli-0",
    model: "sonnet",
    permissionMode: "default",
    includePartialMessages: true,
  });
  expect(fake.calls[0]!.allowDangerouslySkipPermissions).toBeUndefined();
  // Plan mode writes its plans inside the run folder, where the boundary lets it.
  expect((fake.calls[0]!.settings as { plansDirectory?: string }).plansDirectory).toBe(".dispand/plans");
  // No skill or command runs a shell command as it loads: every command goes to the owner.
  expect((fake.calls[0]!.settings as { disableSkillShellExecution?: boolean }).disableSkillShellExecution).toBe(true);
  expect(events).toEqual([
    { type: "cli-session", cliSessionId: "cli-1" },
    { type: "text", delta: "Hel" },
    { type: "text", delta: "lo" },
    { type: "turn-end" },
  ]);
});

test("AskUserQuestion becomes a choice question and the answer is returned as updatedInput.answers", async () => {
  const questions = [
    { question: "Which one?", header: "Pick", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }], multiSelect: false },
    { question: "Which ones?", header: "Many", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }], multiSelect: true },
  ];
  let decision: unknown;
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    yield init;
    decision = await options.canUseTool!("AskUserQuestion", { questions }, ctx());
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "choice", answers: { "Which one?": "A", "Which ones?": ["A", "B"] } }));
  await session.done;
  expect(events).toContainEqual({ type: "question", questionId: expect.any(String), payload: { kind: "choice", questions } });
  expect(decision).toEqual({
    behavior: "allow",
    updatedInput: { questions, answers: { "Which one?": "A", "Which ones?": "A, B" } },
  });
});

test("permission deny returns behavior deny with message", async () => {
  let decision: unknown;
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    decision = await options.canUseTool!("Bash", { command: "rm -rf build" }, ctx([]));
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "permission", decision: "deny", message: "not now" }));
  await session.done;
  expect(events).toContainEqual({
    type: "question",
    questionId: expect.any(String),
    payload: { kind: "permission", toolName: "Bash", input: { command: "rm -rf build" }, canAlwaysAllow: false },
  });
  expect(decision).toEqual({ behavior: "deny", message: "not now" });
});

test("allow-always returns the SDK's suggestions as updatedPermissions, submit_outputs needs no question", async () => {
  const suggestions: PermissionUpdate[] = [
    // Would persist the rule in .claude/settings.local.json: kept to the session instead.
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" },
  ];
  const decisions: unknown[] = [];
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    decisions.push(await options.canUseTool!("Bash", { command: "ls" }, ctx(suggestions)));
    decisions.push(await options.canUseTool!("mcp__dispand__submit_outputs", { summary: "hi" }, ctx()));
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "permission", decision: "allow-always" }));
  await session.done;
  expect(decisions).toEqual([
    { behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: [{ ...suggestions[0]!, destination: "session" }] },
    { behavior: "allow", updatedInput: { summary: "hi" } },
  ]);
  expect(events.filter((e) => e.type === "question")).toHaveLength(1);
});

test("an MCP tool call is approved one at a time: no allow-always, and the hook asks even where a rule would allow it", async () => {
  const suggestions: PermissionUpdate[] = [{ type: "addRules", rules: [{ toolName: "mcp__github__delete_repo" }], behavior: "allow", destination: "session" }];
  const decisions: unknown[] = [];
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    decisions.push(await options.canUseTool!("mcp__github__delete_repo", { repo: "x" }, ctx(suggestions)));
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "permission", decision: "allow-always" }));
  await session.done;
  expect(decisions).toEqual([{ behavior: "allow", updatedInput: { repo: "x" } }]);
  expect(events.find((e) => e.type === "question")).toMatchObject({ payload: { toolName: "mcp__github__delete_repo", canAlwaysAllow: false } });

  for (const mode of ["default", "acceptEdits", "plan"] as const) {
    expect(await hookOutputs(mode, [["mcp__github__delete_repo", { repo: "x" }], ["mcp__dispand__submit_outputs", { summary: "hi" }]])).toEqual([ask, {}]);
  }
  expect(await hookOutputs("bypassPermissions", [["mcp__github__delete_repo", { repo: "x" }]], true)).toEqual([{}]);
});

test("submit_outputs in interactive mode asks confirm-outputs and emits outputs-accepted on confirm", async () => {
  let toolResult = "";
  const fake = fakeQuery(async function* ({ next, callTool }) {
    await next();
    toolResult = await callTool("submit_outputs", { summary: "hi" });
    yield result("All done");
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "confirm-outputs", confirmed: true }));
  await session.done;
  expect(toolResult).toBe("confirmed");
  expect(events).toEqual([
    { type: "question", questionId: expect.any(String), payload: { kind: "confirm-outputs", values: { summary: "hi" } } },
    { type: "outputs-accepted", values: { summary: "hi" } },
    { type: "result", text: "All done" },
  ]);
});

test("feedback is returned to the agent as tool result", async () => {
  let toolResult = "";
  const fake = fakeQuery(async function* ({ next, callTool }) {
    await next();
    toolResult = await callTool("submit_outputs", { summary: "a very long line" });
    yield result();
    await next();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "confirm-outputs", confirmed: false, feedback: "shorter" }));
  // Interactive: the turn ends and the session waits for the owner's next message.
  await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "turn-end" }));
  expect(toolResult).toBe("shorter");
  expect(events.some((e) => e.type === "outputs-accepted")).toBe(false);
  session.close();
  await session.done;
});

test("non-interactive outputs are accepted without a question", async () => {
  const fake = fakeQuery(async function* ({ next, callTool }) {
    await next();
    await callTool("submit_outputs", { summary: "hi" });
    yield result("ok");
  });
  const { events, session } = run({ ...start, interactive: false }, fake.query);
  await session.done;
  expect(events).toEqual([
    { type: "outputs-accepted", values: { summary: "hi" } },
    { type: "result", text: "ok" },
  ]);
});

test("reminds once then fails", async () => {
  const prompts: (string | null)[] = [];
  const fake = fakeQuery(async function* ({ next }) {
    prompts.push(await next());
    yield init;
    yield result();
    prompts.push(await next());
    yield result();
    prompts.push(await next());
  });
  const { events, session } = run({ ...start, interactive: false }, fake.query);
  await session.done;
  expect(prompts).toEqual(["Summarize", "Call submit_outputs with: summary", null]);
  expect(events).toEqual([
    { type: "cli-session", cliSessionId: "cli-1" },
    { type: "error", message: "the agent finished without its outputs" },
  ]);
});

test("bypass refused when allowBypass is false", () => {
  const fake = fakeQuery(async function* () {});
  const bypass: SessionStart = { ...start, permissionMode: "bypassPermissions" };
  expect(() => startClaudeSession(bypass, "/work", () => {}, { query: fake.query })).toThrow(BypassRefused);
  expect(() => startClaudeSession(bypass, "/work", () => {}, { query: fake.query, allowBypass: false })).toThrow(BypassRefused);
  expect(fake.calls).toHaveLength(0);

  startClaudeSession(bypass, "/work", () => {}, { query: fake.query, allowBypass: true });
  expect(fake.calls[0]).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
});

const interruptedResult = { type: "result", subtype: "error_during_execution", errors: [], session_id: "cli-1" } as unknown as SDKMessage;

test("interrupting an interactive turn ends the turn, not the session", async () => {
  const prompts: (string | null)[] = [];
  const fake = fakeQuery(async function* ({ next, interrupted }) {
    prompts.push(await next());
    yield init;
    await interrupted;
    yield interruptedResult;
    prompts.push(await next());
    yield result("second");
    await next();
  });
  const { events, session } = run(start, fake.query);
  await vi.waitFor(() => expect(events).toContainEqual({ type: "cli-session", cliSessionId: "cli-1" }));
  await session.interrupt();
  await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "turn-end" }));
  session.send("go on");
  await vi.waitFor(() => expect(prompts).toEqual(["Summarize", "go on"]));
  await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "turn-end" }));
  expect(events.some((e) => e.type === "error")).toBe(false);
  session.close();
  await session.done;
});

test("interrupting a non-interactive session reports the error", async () => {
  const fake = fakeQuery(async function* ({ next, interrupted }) {
    await next();
    yield init;
    await interrupted;
    yield interruptedResult;
    await next();
  });
  const { events, session } = run({ ...start, interactive: false }, fake.query);
  await vi.waitFor(() => expect(events).toHaveLength(1));
  await session.interrupt();
  await session.done;
  expect(events.at(-1)).toEqual({ type: "error", message: "interrupted" });
});

test("file edits outside the working directory, or in its .claude/ and .mcp.json, are denied without a question", async () => {
  const decisions: unknown[] = [];
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    const edits: [string, Record<string, unknown>][] = [
      ["Edit", { file_path: "/work/.claude/settings.json", old_string: "a", new_string: "b" }],
      ["Write", { file_path: "/work/.claude/settings.local.json", content: "{}" }],
      ["Write", { file_path: "/work/.claude/agents/a.md", content: "" }],
      ["Write", { file_path: "/work/.mcp.json", content: "{}" }],
      ["MultiEdit", { file_path: "/home/me/.claude/settings.json", edits: [] }],
      ["NotebookEdit", { notebook_path: "/srv/n.ipynb", new_source: "" }],
      ["Edit", { file_path: join(homedir(), ".claude.json"), old_string: "a", new_string: "b" }],
      ["Write", { file_path: "/.claude/settings.local.json", content: "{}" }],
    ];
    for (const [name, input] of edits) decisions.push(await options.canUseTool!(name, input, ctx()));
    // Relative paths (canUseTool doesn't know the CLI's current directory) are tested apart.
    // Inside the working directory: the owner decides as usual.
    decisions.push(await options.canUseTool!("Write", { file_path: "/work/src/a.ts", content: "" }, ctx()));
    yield result();
  });
  // Even an owner who would allow everything is not asked.
  const { events, session } = run({ ...start }, fake.query, () => ({ kind: "permission", decision: "allow" }));
  await session.done;
  expect(events.filter((e) => e.type === "question")).toHaveLength(1);
  expect(decisions).toHaveLength(9);
  for (const d of decisions.slice(0, 8)) {
    expect(d).toEqual({ behavior: "deny", message: expect.stringContaining("inside the session's working directory") });
  }
  expect(decisions[8]).toMatchObject({ behavior: "allow" });
});

test("every session gets the boundary's settings, and bypass disabled unless allowed", () => {
  const fake = fakeQuery(async function* () {});
  startClaudeSession(start, "/work", () => {}, { query: fake.query });
  startClaudeSession(start, "/work", () => {}, { query: fake.query, allowBypass: true });
  const [locked, allowed] = fake.calls.map((o) => (o.settings as { permissions: Record<string, unknown> }).permissions);
  for (const p of [locked!, allowed!]) {
    expect(p.deny).toContain("Write(//work/.claude/**)");
    expect(p.deny).toContain("Edit(//work/.mcp.json)");
    expect(p.blockWritesOutsideWorkingDirectories).toBe(true);
  }
  expect(locked!.disableBypassPermissionsMode).toBe("disable");
  expect(allowed!.disableBypassPermissionsMode).toBeUndefined();
});

test("an interrupt while no turn runs doesn't turn the next error into a turn end", async () => {
  const fake = fakeQuery(async function* ({ next }) {
    await next();
    yield result();
    await next();
    yield { type: "result", subtype: "error_max_turns", errors: ["too many turns"], session_id: "cli-1" } as unknown as SDKMessage;
    await next();
  });
  const { events, session } = run(start, fake.query);
  await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "turn-end" }));
  await session.interrupt();
  session.send("go on");
  await session.done;
  expect(events.at(-1)).toEqual({ type: "error", message: "too many turns" });
});

test("a question too long for the protocol is answered under its original text", async () => {
  const long = `${"Q".repeat(5000)}?`;
  const questions = [{ question: long, header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false }];
  let decision: unknown;
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    decision = await options.canUseTool!("AskUserQuestion", { questions }, ctx());
    yield result();
  });
  // The owner answers the question as it was shown.
  const { events, session } = run(start, fake.query, (e) => {
    const shown = e.payload.kind === "choice" ? e.payload.questions[0]!.question : "";
    return { kind: "choice", answers: { [shown]: "A" } };
  });
  await session.done;
  const question = events.find((e) => e.type === "question");
  expect(question?.type === "question" && question.payload.kind === "choice" && question.payload.questions[0]!.question.length).toBe(4000);
  expect(decision).toEqual({ behavior: "allow", updatedInput: { questions, answers: { [long]: "A" } } });
});

test("outputs the protocol can't carry are refused back to the agent; unstorable characters are replaced", async () => {
  const results: string[] = [];
  const fields = ["a", "b", "c"].map((name) => ({ name, type: "string" as const }));
  const fake = fakeQuery(async function* ({ next, callTool }) {
    await next();
    const huge = "é".repeat(199_000);
    results.push(await callTool("submit_outputs", { a: huge, b: huge, c: huge }));
    results.push(await callTool("submit_outputs", { a: "x".repeat(200_001), b: "", c: "" }));
    results.push(await callTool("submit_outputs", { a: "ok\u0000", b: "\ud800", c: "fine" }));
    yield result();
  });
  const { events, session } = run({ ...start, expectedOutputs: fields }, fake.query, () => ({ kind: "confirm-outputs", confirmed: true }));
  await session.done;
  expect(results[0]).toContain("too large");
  expect(results[1]).toContain("too large");
  expect(results[2]).toBe("confirmed");
  const clean = { a: "ok�", b: "�", c: "fine" };
  expect(events.filter((e) => e.type === "question")).toEqual([
    { type: "question", questionId: expect.any(String), payload: { kind: "confirm-outputs", values: clean } },
  ]);
  expect(events).toContainEqual({ type: "outputs-accepted", values: clean });
});

test("an interrupt during a queued follow-up turn is passed on", async () => {
  let firstTurnDone = false;
  const fake = fakeQuery(async function* ({ next, interrupted, uuids }) {
    await next();
    await next();
    // The first turn ends; the follow-up sent during it runs next.
    yield { ...result(), user_message_uuids: [uuids[0]] } as SDKMessage;
    firstTurnDone = true;
    await interrupted;
    yield { ...(interruptedResult as object), user_message_uuids: [uuids[1]] } as SDKMessage;
    await next();
  });
  const { events, session } = run(start, fake.query);
  session.send("and then?");
  await vi.waitFor(() => expect(firstTurnDone).toBe(true));
  // The follow-up was still to run: no turn end yet.
  expect(events).toEqual([]);
  await session.interrupt();
  await vi.waitFor(() => expect(events).toEqual([{ type: "turn-end" }]));
  session.close();
  await session.done;
});

test("an interrupt withdraws a pending outputs confirmation: a late answer is ignored", async () => {
  let toolResult = "";
  const fake = fakeQuery(async function* ({ next, callTool, interrupted }) {
    await next();
    const call = callTool("submit_outputs", { summary: "hi" });
    await interrupted;
    toolResult = await call;
    yield interruptedResult;
    await next();
  });
  const { events, session } = run(start, fake.query);
  await vi.waitFor(() => expect(events.some((e) => e.type === "question")).toBe(true));
  const question = events.find((e) => e.type === "question")!;
  await session.interrupt();
  await vi.waitFor(() => expect(toolResult).not.toBe(""));
  session.answer(question.type === "question" ? question.questionId : "", { kind: "confirm-outputs", confirmed: true });
  await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "turn-end" }));
  expect(toolResult).not.toBe("confirmed");
  expect(events.some((e) => e.type === "outputs-accepted")).toBe(false);
  session.close();
  await session.done;
});

/** Runs every PreToolUse hook of a session in `mode` on each call, as the CLI would; returns their outputs. */
async function hookOutputs(mode: SessionStart["permissionMode"], calls: [string, unknown][], allowBypass = false) {
  const outputs: unknown[] = [];
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    const hooks = options.hooks!.PreToolUse!.flatMap((m) => m.hooks);
    for (const [tool_name, tool_input] of calls) {
      for (const hook of hooks) {
        outputs.push(await hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "tu", session_id: "s", transcript_path: "", cwd: "/work" } as never, "tu", { signal: new AbortController().signal }));
      }
    }
    yield result();
  });
  const session = startClaudeSession({ ...start, permissionMode: mode }, "/work", () => {}, {
    query: fake.query,
    allowBypass,
  });
  await session.done;
  return outputs;
}

const ask = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("asks the owner") } };

test("a PreToolUse hook denies protected edits in every permission mode, and lets the rest through", async () => {
  expect(
    await hookOutputs("acceptEdits", [
      ["Write", { file_path: "/work/.claude/settings.json", content: "{}" }],
      ["Write", { file_path: "/work/notes.txt", content: "hi" }],
      ["Read", { file_path: "/work/notes.txt" }],
    ]),
  ).toEqual([
    {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("inside the session's working directory") },
    },
    {},
    // Reads are decided by the read allowlist.
    { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
  ]);
});

test.each(["default", "acceptEdits", "plan"] as const)("in %s mode, every shell command asks the owner, even one the CLI would auto-approve", async (mode) => {
  expect(
    await hookOutputs(mode, [
      ["Bash", { command: "cp a b" }],
      ["Monitor", { command: "tail -f log" }],
      ["PowerShell", { command: "Copy-Item a b" }],
      ["Workflow", { script: "run.js" }],
    ]),
  ).toEqual([ask, ask, ask, ask]);
});

test("bypassPermissions, where the machine allows it, asks for nothing", async () => {
  expect(await hookOutputs("bypassPermissions", [["Bash", { command: "cp a b" }]], true)).toEqual([{}]);
});

test("a result with is_error is a failure, whatever its subtype", async () => {
  for (const interactive of [true, false]) {
    const fake = fakeQuery(async function* ({ next }) {
      await next();
      yield { type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded", session_id: "cli-1" } as SDKMessage;
      await next();
    });
    const { events, session } = run({ ...start, interactive }, fake.query);
    await session.done;
    expect(events).toEqual([{ type: "error", message: "API Error: 529 overloaded" }]);
  }
});

test("once the session is done, queued turns are dropped, the query is aborted and nothing more runs or is emitted", async () => {
  let afterDone: string | null = "unread";
  const ranAfterAbort: string[] = [];
  const fake = fakeQuery(async function* ({ next, callTool, options }) {
    await next();
    await callTool("submit_outputs", { summary: "hi" });
    yield result("done");
    // A CLI that had already taken the follow-up in would run its tool call now, unless aborted.
    if (!options.abortController!.signal.aborted) ranAfterAbort.push("Bash");
    yield delta("late text");
    afterDone = await next();
  });
  const { events, session } = run({ ...start, interactive: false }, fake.query);
  // A follow-up queued while the outputs are being handed back.
  session.send("and one more thing");
  await session.done;
  expect(events).toEqual([
    { type: "outputs-accepted", values: { summary: "hi" } },
    { type: "result", text: "done" },
  ]);
  expect(fake.calls[0]!.abortController!.signal.aborted).toBe(true);
  expect(ranAfterAbort).toEqual([]);
  expect(afterDone).toBeNull();
});

test("a turn end with queued messages still to run is not the session's turn end", async () => {
  const prompts: (string | null)[] = [];
  const fake = fakeQuery(async function* ({ next, uuids }) {
    prompts.push(await next());
    prompts.push(await next());
    yield { ...result(), user_message_uuids: [uuids[0]] } as SDKMessage;
    yield { ...result(), user_message_uuids: [uuids[1]] } as SDKMessage;
    prompts.push(await next());
    yield result();
    prompts.push(await next());
  });
  const { events, session } = run({ ...start, interactive: false }, fake.query);
  session.send("also this");
  await session.done;
  expect(prompts).toEqual(["Summarize", "also this", "Call submit_outputs with: summary", null]);
  expect(events).toEqual([{ type: "error", message: "the agent finished without its outputs" }]);
});

test("a permission request too large to show whole is denied without asking", async () => {
  let decision: unknown;
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    // A huge description would push the command itself out of a truncated view.
    decision = await options.canUseTool!("Bash", { description: "x".repeat(300_000), command: "rm -rf ~" }, ctx());
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "permission", decision: "allow" }));
  await session.done;
  expect(events.filter((e) => e.type === "question")).toEqual([]);
  expect(decision).toEqual({ behavior: "deny", message: expect.stringContaining("too large to show for approval") });
});

test("the owner approves exactly the input the question showed", async () => {
  const input = { command: "ls -la", description: "List files" };
  let decision: unknown;
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    decision = await options.canUseTool!("Bash", input, ctx());
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "permission", decision: "allow" }));
  await session.done;
  const question = events.find((e) => e.type === "question");
  expect(question?.type === "question" && question.payload).toEqual({ kind: "permission", toolName: "Bash", input, canAlwaysAllow: false });
  expect(decision).toEqual({ behavior: "allow", updatedInput: input });
});

test("a relative CLAUDE_CONFIG_DIR is resolved once: the CLI gets the absolute path and the boundary uses it", async () => {
  const { mkdir, mkdtemp, realpath, rm, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { relative } = await import("node:path");
  const base = await realpath(await mkdtemp(join(tmpdir(), "ccd-")));
  try {
    const work = join(base, "work");
    const config = join(base, "claude-config");
    await mkdir(join(config, "hooks"), { recursive: true });
    await mkdir(join(work, "scripts"), { recursive: true });
    await symlink(join(work, "scripts", "pre.sh"), join(config, "hooks", "pre.sh"));
    const env = claudeEnv({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: relative(process.cwd(), config) });
    expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: config });
    expect(() => claudeEnv({ CLAUDE_CONFIG_DIR: "missing-config-dir" })).toThrow(/CLAUDE_CONFIG_DIR/);

    let decision: unknown;
    const fake = fakeQuery(async function* ({ next, options }) {
      await next();
      decision = await options.canUseTool!("Write", { file_path: join(work, "scripts", "pre.sh"), content: "" }, ctx());
      yield result();
    });
    const session = startClaudeSession(start, work, () => {}, { query: fake.query, env });
    await session.done;
    expect(fake.calls[0]!.env).toEqual(env);
    expect(decision).toMatchObject({ behavior: "deny" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

const abortedSuccess = { type: "result", subtype: "success", is_error: false, result: "", terminal_reason: "aborted_streaming", session_id: "cli-1" } as unknown as SDKMessage;

test.each([
  ["an error result", interruptedResult],
  ["a success result with terminal_reason aborted_streaming", abortedSuccess],
])("an interrupt ending in %s is an interruption", async (_name, cut) => {
  for (const interactive of [true, false]) {
    const prompts: (string | null)[] = [];
    const fake = fakeQuery(async function* ({ next, interrupted }) {
      prompts.push(await next());
      yield init;
      await interrupted;
      yield cut;
      prompts.push(await next());
    });
    const { events, session } = run({ ...start, interactive }, fake.query);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await session.interrupt();
    if (interactive) {
      await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "turn-end" }));
      session.close();
    }
    await session.done;
    if (!interactive) expect(events.at(-1)).toEqual({ type: "error", message: "interrupted" });
    // No reminder, no outputs: the turn was cut, not finished.
    expect(prompts).toEqual(["Summarize", null]);
    expect(events.some((e) => e.type === "result" || e.type === "outputs-accepted")).toBe(false);
  }
});

test("a turn aborted mid-stream without an interrupt from Dispand is an interruption too", async () => {
  const fake = fakeQuery(async function* ({ next }) {
    await next();
    yield abortedSuccess;
    await next();
  });
  const { events, session } = run({ ...start, interactive: false }, fake.query);
  await session.done;
  expect(events).toEqual([{ type: "error", message: "interrupted" }]);
});

test("an interrupted turn with a follow-up still queued doesn't report the session idle", async () => {
  const fake = fakeQuery(async function* ({ next, interrupted, uuids }) {
    await next();
    await next();
    await interrupted;
    yield { ...(interruptedResult as object), user_message_uuids: [uuids[0]] } as SDKMessage;
    yield { ...result(), user_message_uuids: [uuids[1]] } as SDKMessage;
    await next();
  });
  const { events, session } = run(start, fake.query);
  session.send("then this");
  await session.interrupt();
  await vi.waitFor(() => expect(events).toEqual([{ type: "turn-end" }]));
  session.close();
  await session.done;
  // One turn end, after the follow-up's turn: none for the cut turn while the follow-up was queued.
  expect(events).toEqual([{ type: "turn-end" }]);
});

test("messages waiting for the agent are capped per session: past it, the session stops with an error", async () => {
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    yield init;
    // Busy: reads nothing more until stopped.
    await new Promise((resolve) => options.abortController!.signal.addEventListener("abort", resolve));
  });
  const { events, session } = run(start, fake.query);
  await vi.waitFor(() => expect(events).toHaveLength(1));
  for (let i = 0; i < 25; i++) session.send(`m${i}`);
  // The 22nd ends the session; the ones after it go nowhere.
  expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: expect.stringContaining("waiting for the agent") }]);
  session.stop("done");
  await session.done;
});

test("one message past the 4 MiB waiting stops the session", async () => {
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    yield init;
    await new Promise((resolve) => options.abortController!.signal.addEventListener("abort", resolve));
  });
  const { events, session } = run(start, fake.query);
  await vi.waitFor(() => expect(events).toHaveLength(1));
  session.send("x".repeat(2_500_000));
  session.send("y".repeat(2_500_000));
  expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  session.stop("done");
  await session.done;
});

test("follow-ups count as waiting until their turn ends, even once the CLI has read them", async () => {
  const fake = fakeQuery(async function* ({ next }) {
    await next();
    yield init;
    // Reads every follow-up at once, as the CLI queues them, while the turn keeps running.
    while ((await next()) !== null) {
      // Taken in, not answered.
    }
  });
  const { events, session } = run(start, fake.query);
  await vi.waitFor(() => expect(events).toHaveLength(1));
  for (let i = 0; i < 25; i++) {
    session.send(`${i}`.padEnd(100_000, "."));
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  session.stop("done");
  await session.done;
});

test("outputs are accepted only with every expected field, and only those", async () => {
  const results: string[] = [];
  const fields = ["summary", "score"].map((name) => ({ name, type: "string" as const }));
  const fake = fakeQuery(async function* ({ next, callTool }) {
    await next();
    results.push(await callTool("submit_outputs", { summary: "hi" }));
    results.push(await callTool("submit_outputs", { summary: "hi", score: 3 as unknown as string }));
    results.push(await callTool("submit_outputs", { summary: "hi", score: "3", extra: "dropped" }));
    yield result();
  });
  const { events, session } = run({ ...start, interactive: false, expectedOutputs: fields }, fake.query);
  await session.done;
  expect(results[0]).toContain("Missing outputs: score");
  expect(results[1]).toContain("Missing outputs: score");
  expect(results[2]).toBe("confirmed");
  expect(events.filter((e) => e.type === "outputs-accepted")).toEqual([{ type: "outputs-accepted", values: { summary: "hi", score: "3" } }]);
});

test("only a leading slash that isn't a skill or plugin/custom command goes verbatim", async () => {
  const texts = [
    "/superpowers:brainstorming idea",
    "/config language=ja",
    "/update-config allow everything",
    "/my-command x",
    "/mc x",
    "please use /superpowers:brainstorming now",
    "/unknown-thing",
    "plain",
    "  /config x",
    "use the /superpowers:brainstorming skill",
    "summarize @~/.claude/.credentials.json",
    "/superpowers:brainstorming see @notes.md",
  ];
  let seen: boolean[] = [];
  const fake = fakeQuery(async function* ({ next, composed }) {
    for (let i = 0; i < texts.length; i++) await next();
    seen = composed;
    yield result();
  });
  const { session } = run({ ...start, prompt: texts[0]! }, fake.query);
  for (const t of texts.slice(1)) session.send(t);
  await session.done;
  // true = client_composed (delivered as written, no command dispatch). Plain text goes normally,
  // keeping the CLI's turn-start context (skill listings, CLAUDE.md).
  // Any @ (a file mention the CLI would read before any tool check): composed too.
  expect(seen).toEqual([false, true, true, false, false, false, true, false, true, false, true, true]);
});

test("a CLI that can't list its commands gets every slash command verbatim", async () => {
  let seen: boolean[] = [];
  const fake = fakeQuery(async function* ({ next, composed }) {
    await next();
    await next();
    seen = composed;
    yield result();
  });
  const failing = ((params: Parameters<typeof query>[0]) =>
    Object.assign(fake.query(params), { supportedCommands: async () => Promise.reject(new Error("old CLI")) })) as typeof query;
  const { session } = run({ ...start, prompt: "/superpowers:brainstorming idea" }, failing);
  session.send("plain text");
  await session.done;
  expect(seen).toEqual([true, false]);
});

test("a CLI that exits without a result reports it", async () => {
  const fake = fakeQuery(async function* ({ next }) {
    await next();
    yield init;
  });
  const { events, session } = run(start, fake.query);
  await session.done;
  expect(events).toEqual([
    { type: "cli-session", cliSessionId: "cli-1" },
    { type: "error", message: "the CLI exited before the session finished" },
  ]);
});

test("a CLI that exits because the session was closed is no error", async () => {
  const fake = fakeQuery(async function* ({ next }) {
    await next();
    yield init;
    await next();
  });
  const { events, session } = run(start, fake.query);
  await vi.waitFor(() => expect(events).toHaveLength(1));
  session.close();
  await session.done;
  expect(events).toEqual([{ type: "cli-session", cliSessionId: "cli-1" }]);
});

test("a custom command or alias spelled like a built-in never dispatches", async () => {
  let seen: boolean[] = [];
  const fake = fakeQuery(async function* ({ next, composed }) {
    for (let i = 0; i < 4; i++) await next();
    seen = composed;
    yield result();
  });
  const { session } = run({ ...start, prompt: "/config language=ja" }, fake.query);
  session.send("/update-config x");
  session.send("/my-command x");
  session.send("/mc x");
  await session.done;
  expect(seen).toEqual([true, true, false, false]);
});

test("without built-in markers, only namespaced spellings dispatch, aliases included", async () => {
  let seen: boolean[] = [];
  const fake = fakeQuery(async function* ({ next, composed }) {
    for (let i = 0; i < 3; i++) await next();
    seen = composed;
    yield result();
  });
  const unflagged = ((params: Parameters<typeof query>[0]) =>
    Object.assign(fake.query(params), {
      supportedCommands: async () => [
        { name: "plugin:helper", description: "", argumentHint: "", aliases: ["config", "plugin:h"] },
        { name: "plain", description: "", argumentHint: "" },
      ],
    })) as typeof query;
  const { session } = run({ ...start, prompt: "/config x" }, unflagged);
  session.send("/plugin:h x");
  session.send("/plain x");
  await session.done;
  expect(seen).toEqual([true, false, true]);
});

test.each([
  ["two questions", [{ question: `${"Q".repeat(4000)} A?`, header: "a", options: [{ label: "x", description: "" }, { label: "y", description: "" }], multiSelect: false }, { question: `${"Q".repeat(4000)} B?`, header: "b", options: [{ label: "x", description: "" }, { label: "y", description: "" }], multiSelect: false }]],
  ["two options", [{ question: "Which?", header: "h", options: [{ label: `${"L".repeat(4000)}1`, description: "" }, { label: `${"L".repeat(4000)}2`, description: "" }], multiSelect: false }]],
])("%s the protocol's cut makes identical are denied, not asked", async (_name, questions) => {
  let decision: unknown;
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    decision = await options.canUseTool!("AskUserQuestion", { questions }, ctx());
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "choice", answers: {} }));
  await session.done;
  expect(events.filter((e) => e.type === "question")).toEqual([]);
  expect(decision).toEqual({ behavior: "deny", message: expect.stringContaining("too long to tell apart") });
});

test("the hook lets file tools read only inside the session folder (and the CLI's plugin code and skills/)", async () => {
  const home = homedir();
  const outputs = await hookOutputs("default", [
    ["Read", { file_path: join(home, ".claude", ".credentials.json") }],
    ["Grep", { pattern: "token", path: "~/.claude" }],
    ["Glob", { pattern: "/home/*/.claude/*.json" }],
    ["Read", { file_path: join(home, ".codex", "auth.json") }],
    ["Read", { file_path: "/work/notes.md" }],
    ["Glob", { pattern: "{a,/etc}/*" }],
    ["LSP", { operation: "hover", filePath: "/work/a.ts", line: 1, character: 1 }],
  ]);
  const denied = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("read files only inside the session folder") } };
  const asked = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("can't tell") } };
  const allowed = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  expect(outputs).toEqual([denied, denied, denied, denied, allowed, asked, asked]);
});

test("a read the allowlist allows is never turned into an owner question", async () => {
  let decision: unknown;
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    const skill = join(homedir(), ".claude", "plugins", "cache", "x", "skills", "s", "ref.md");
    decision = await options.canUseTool!("Read", { file_path: skill }, ctx());
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "permission", decision: "deny" }));
  await session.done;
  expect(events.filter((e) => e.type === "question")).toEqual([]);
  expect(decision).toMatchObject({ behavior: "allow" });
});

test("a non-canonical path reaches the owner as a question, for reads and edits", async () => {
  const outputs = await hookOutputs("default", [
    ["Read", { file_path: " ~/.ssh/id_ed25519" }],
    ["Write", { file_path: "a/../b", content: "" }],
  ]);
  const asked = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("not plain") } };
  expect(outputs).toEqual([asked, asked]);
  const decisions: unknown[] = [];
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    decisions.push(await options.canUseTool!("Read", { file_path: " ~/.ssh/id_ed25519" }, ctx()));
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "permission", decision: "deny", message: "no" }));
  await session.done;
  expect(events.filter((e) => e.type === "question")).toHaveLength(1);
  expect(decisions).toEqual([{ behavior: "deny", message: "no" }]);
});

test("a chosen option shown cut is answered under the agent's own label", async () => {
  const long = `${"L".repeat(4001)}`;
  const questions = [{ question: "Which?", header: "h", options: [{ label: long, description: "" }, { label: "short", description: "" }], multiSelect: true }];
  let decision: unknown;
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    decision = await options.canUseTool!("AskUserQuestion", { questions }, ctx());
    yield result();
  });
  const { session } = run(start, fake.query, (e) => {
    const shown = e.payload.kind === "choice" ? e.payload.questions[0]!.options.map((o) => o.label) : [];
    expect(shown[0]!.length).toBe(4000);
    return { kind: "choice", answers: { "Which?": [shown[0]!, "short", "my own words"] } };
  });
  await session.done;
  expect(decision).toEqual({ behavior: "allow", updatedInput: { questions, answers: { "Which?": `${long}, short, my own words` } } });
});

test("canUseTool, which doesn't know the CLI's current directory, asks about a relative path", async () => {
  const decisions: unknown[] = [];
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    decisions.push(await options.canUseTool!("Read", { file_path: "notes.md" }, ctx()));
    yield result();
  });
  const { events, session } = run(start, fake.query, () => ({ kind: "permission", decision: "allow" }));
  await session.done;
  expect(events.filter((e) => e.type === "question")).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ behavior: "allow" });
});

test("the hook resolves relative paths against the cwd the CLI reports", async () => {
  const outputs: unknown[] = [];
  const fake = fakeQuery(async function* ({ next, options }) {
    await next();
    const hooks = options.hooks!.PreToolUse!.flatMap((m) => m.hooks);
    for (const cwd of ["/work/sub", "/elsewhere"]) {
      for (const hook of hooks) {
        outputs.push(await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.md" }, tool_use_id: "tu", session_id: "s", transcript_path: "", cwd } as never, "tu", { signal: new AbortController().signal }));
      }
    }
    yield result();
  });
  const session = startClaudeSession(start, "/work", () => {}, { query: fake.query });
  await session.done;
  expect(outputs).toEqual([
    { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
    { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.any(String) } },
  ]);
});

test("a CLI that exits after a result, with outputs still expected, is a terminal error too", async () => {
  const prompts: (string | null)[] = [];
  const fake = fakeQuery(async function* ({ next }) {
    prompts.push(await next());
    // A success result without outputs: the runner sends the reminder, and the CLI exits.
    yield result();
  });
  const { events, session } = run({ ...start, interactive: false }, fake.query);
  await session.done;
  expect(events).toEqual([{ type: "error", message: "the CLI exited before the session finished" }]);
});

test("finished tool calls leave nothing behind", async () => {
  const fake = fakeQuery(async function* ({ next }) {
    await next();
    for (let i = 0; i < 50; i++) {
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: `tu_${i}`, name: "Read", input: {} }] } } as unknown as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: "ok" }] } } as unknown as SDKMessage;
    }
    yield result();
    await next();
  });
  const { events, session } = run(start, fake.query);
  await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "turn-end" }));
  expect(events.filter((e) => e.type === "tool")).toHaveLength(100);
  expect(session.toolsInFlight()).toBe(0);
  session.close();
  await session.done;
});

/** An init message from Claude Code 2.1.316 (superpowers installed for the user) with a Dispand plugin also named superpowers, another one, and a missing path. */
const recordedInit = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "init-duplicate-plugin.json"), "utf8")) as {
  plugins: unknown[];
  plugin_errors: { plugin: string; type: string; message: string; path?: string }[];
};

function withPlugins(roots: string[], initMessage: Record<string, unknown>) {
  const fake = fakeQuery(async function* (io) {
    await io.next();
    yield { ...initMessage, type: "system", subtype: "init", session_id: "cli-1" } as SDKMessage;
    yield result();
  });
  const events: HarnessEvent[] = [];
  const session = startClaudeSession({ ...start, interactive: false, expectedOutputs: [] }, "/work", (e) => events.push(e), { query: fake.query, pluginRoots: roots });
  return { fake, events, session };
}

test("plugins lists every package root, without their MCP servers; reads of them are allowed", async () => {
  const { fake, session } = withPlugins(["/STATE/plugins/superpowers", "/STATE/plugins/hello"], {});
  await session.done;
  expect(fake.calls[0]!.plugins).toEqual([
    { type: "local", path: "/STATE/plugins/superpowers", skipMcpDiscovery: true },
    { type: "local", path: "/STATE/plugins/hello", skipMcpDiscovery: true },
  ]);
  const none = withPlugins([], {});
  await none.session.done;
  expect(none.fake.calls[0]!.plugins).toBeUndefined();
});

test("duplicate plugin name doesn't fail the session", async () => {
  const { events, session } = withPlugins(["/STATE/plugins/superpowers", "/STATE/plugins/hello"], recordedInit);
  await session.done;
  expect(events.filter((e) => e.type === "error")).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "result" });
  expect(pluginFailure([{ plugin: "superpowers@inline", type: "duplicate-plugin", message: "already loaded" }], ["/STATE/plugins/superpowers"])).toBeNull();
});

test("a plugin error at init fails the session", async () => {
  const { events, session } = withPlugins(["/STATE/plugins/hello", "/STATE/plugins/missing"], recordedInit);
  await session.done;
  expect(events.at(-1)).toEqual({ type: "error", message: "skill package missing didn't load: Path not found: /STATE/plugins/missing" });
  expect(pluginFailure([{ plugin: "hello@inline", type: "manifest-validation-error", message: "bad" }], ["/STATE/plugins/hello"])).toBe("skill package hello didn't load: bad");
  // The machine's own plugins' errors aren't the session's.
  expect(pluginFailure([{ plugin: "other@market", type: "generic-error", message: "x" }], ["/STATE/plugins/hello"])).toBeNull();
});

test("the session's MCP servers are set before the first turn, dispand last", async () => {
  const set: Record<string, unknown>[] = [];
  const fake = fakeQuery(async function* ({ next }) {
    expect(set).toHaveLength(1);
    expect(await next()).toBe("Summarize");
    yield init;
    yield result();
    await next();
  }, { set });
  const events: HarnessEvent[] = [];
  const session = startClaudeSession(start, "/work", (e) => events.push(e), {
    query: fake.query,
    mcpServers: { github: { type: "http", url: "https://api.example.test/mcp", headers: { authorization: "Bearer s3cret" } } },
  });
  await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "turn-end" }));
  session.close();
  await session.done;
  // Never in the CLI's options, which become its command line.
  expect(Object.keys(fake.calls[0]!.mcpServers!)).toEqual(["dispand"]);
  expect(Object.keys(set[0]!)).toEqual(["github", "dispand"]);
  expect(set[0]!.dispand).toBe(fake.calls[0]!.mcpServers!.dispand);
});

test("an MCP server that doesn't connect ends the session before the first turn, without the CLI's message", async () => {
  let read = false;
  const fake = fakeQuery(async function* ({ next }) {
    read = (await next()) !== null;
    if (read) yield init;
  }, { errors: { github: "connect ECONNREFUSED https://api.example.test/mcp?key=s3cret" } });
  const events: HarnessEvent[] = [];
  const session = startClaudeSession(start, "/work", (e) => events.push(e), {
    query: fake.query,
    mcpServers: { github: { type: "http", url: "https://api.example.test/mcp?key=s3cret" } },
  });
  await session.done;
  expect(read).toBe(false);
  expect(events).toEqual([{ type: "error", message: "the MCP server github didn't connect" }]);
});
