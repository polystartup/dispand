import { describe, expect, test } from "vitest";
import { z } from "zod";
import { bounded } from "./bounds.ts";
import {
  type HarnessEvent,
  OutputField,
  parseRunnerMessage,
  parseServerMessage,
  ProtocolError,
  RunnerToServer,
  ServerToRunner,
  type SessionStart,
} from "./index.ts";

const start: SessionStart = {
  sessionId: "ses_1",
  harness: "claude-code",
  cwd: { mode: "per-run", runKey: "run_01J" },
  systemPrompt: "You are helpful.",
  prompt: "Say hello",
  expectedOutputs: [{ name: "summary", description: "One line", type: "string" }],
  interactive: true,
  resumeCliSessionId: "cli-123",
  permissionMode: "default",
  model: "sonnet",
  skills: [{ packageId: "pkg_1", name: "hello-check" }],
  mcpServers: [
    { name: "github", type: "http", url: "https://api.githubcopilot.com/mcp/", transport: "streamable-http", headers: { Authorization: "Bearer x" } },
    { name: "fetch", type: "runner", tool: "fetch" },
  ],
};

const codexStart: SessionStart = { ...start, harness: "codex", permissionMode: "bypassPermissions", skills: [], mcpServers: [] };

const serverMessages: ServerToRunner[] = [
  { type: "session.start", start },
  { type: "session.start", start: { ...start, expectedOutputs: [] } },
  { type: "session.start", start: codexStart },
  { type: "session.start", start: { ...start, jobToken: "dj_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" } },
  { type: "tool.discover", requestId: "req_1", tool: "fetch" },
  { type: "session.send", sessionId: "ses_1", text: "more" },
  {
    type: "session.answer",
    sessionId: "ses_1",
    questionId: "q1",
    answer: { kind: "choice", answers: { "Which one?": "A", "Which ones?": ["B", "C"] } },
  },
  {
    type: "session.answer",
    sessionId: "ses_1",
    questionId: "q2",
    answer: { kind: "permission", decision: "deny", message: "not now" },
  },
  {
    type: "session.answer",
    sessionId: "ses_1",
    questionId: "q3",
    answer: { kind: "confirm-outputs", confirmed: false, feedback: "shorter" },
  },
  { type: "session.interrupt", sessionId: "ses_1" },
  { type: "session.stop", sessionId: "ses_1" },
  { type: "ack", seq: 42 },
];

const runnerMessages: RunnerToServer[] = [
  {
    type: "hello",
    runnerVersion: "0.1.0",
    clis: { claude: "2.1.0", codex: { version: "0.166.0", signedIn: true } },
    tools: ["fetch"],
    liveSessions: ["ses_1"],
    lastSeq: 3,
  },
  { type: "hello", runnerVersion: "0.1.0", clis: {}, tools: [], liveSessions: [], lastSeq: 0 },
  {
    type: "tool.discovered",
    requestId: "req_1",
    actions: [{ name: "fetch", description: "Fetches a URL", inputSchema: { type: "object", properties: { url: { type: "string" } } } }],
  },
  { type: "tool.discovered", requestId: "req_2", error: "the server didn't start" },
  ...(
    [
      { type: "cli-session", cliSessionId: "cli-123" },
      { type: "text", delta: "Hel" },
      { type: "tool", name: "Bash", status: "started" },
      {
        type: "question",
        questionId: "q1",
        payload: {
          kind: "choice",
          questions: [
            {
              question: "Which one?",
              header: "Pick",
              options: [{ label: "A", description: "first" }, { label: "B" }],
              multiSelect: false,
            },
          ],
        },
      },
      {
        type: "question",
        questionId: "q2",
        payload: { kind: "permission", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: true },
      },
      { type: "question", questionId: "q3", payload: { kind: "confirm-outputs", values: { summary: "hi" } } },
      { type: "turn-end" },
      { type: "outputs-accepted", values: { summary: "hi" } },
      { type: "result", text: "done" },
      { type: "error", message: "boom" },
    ] satisfies HarnessEvent[]
  ).map((event, i): RunnerToServer => ({ type: "event", seq: i + 1, sessionId: "ses_1", event })),
];

describe("server to runner", () => {
  test.each(serverMessages.map((m, i) => [`${m.type} ${i}`, m] as const))("%s round-trips", (_type, msg) => {
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
  });

  test("unknown type throws ProtocolError", () => {
    expect(() => parseServerMessage(JSON.stringify({ type: "session.explode", sessionId: "x" }))).toThrow(ProtocolError);
  });

  test("invalid JSON throws ProtocolError", () => {
    expect(() => parseServerMessage("{not json")).toThrow(ProtocolError);
  });

  test("a fixed cwd throws: sessions run only in fresh per-run folders", () => {
    const msg = { type: "session.start", start: { ...start, cwd: { mode: "fixed", path: "/home/me/work" } } };
    expect(() => parseServerMessage(JSON.stringify(msg))).toThrow(ProtocolError);
  });

  test("duplicate expected output names throw", () => {
    const field = { name: "summary", type: "string" };
    const msg = { type: "session.start", start: { ...start, expectedOutputs: [field, { ...field, description: "again" }] } };
    expect(() => parseServerMessage(JSON.stringify(msg))).toThrow(ProtocolError);
  });

  test("an empty resumeCliSessionId throws", () => {
    const msg = { type: "session.start", start: { ...start, resumeCliSessionId: "" } };
    expect(() => parseServerMessage(JSON.stringify(msg))).toThrow(ProtocolError);
  });

  test("protocol 2: a hello without lastSeq or tools throws", () => {
    const hello = { type: "hello", runnerVersion: "0.1.0", clis: {}, tools: [], liveSessions: [], lastSeq: 0 };
    expect(parseRunnerMessage(JSON.stringify(hello))).toEqual(hello);
    for (const key of ["lastSeq", "tools"]) {
      const old: Record<string, unknown> = { ...hello };
      delete old[key];
      expect(() => parseRunnerMessage(JSON.stringify(old))).toThrow(ProtocolError);
    }
  });

  test("an mcp server named dispand is refused", () => {
    const msg = { type: "session.start", start: { ...start, mcpServers: [{ name: "dispand", type: "runner", tool: "fetch" }] } };
    expect(() => parseServerMessage(JSON.stringify(msg))).toThrow(ProtocolError);
  });

  test.each(["", "has space", "a/b", "x".repeat(65)])("an mcp server named %j is refused", (name) => {
    const msg = { type: "session.start", start: { ...start, mcpServers: [{ name, type: "runner", tool: "fetch" }] } };
    expect(() => parseServerMessage(JSON.stringify(msg))).toThrow(ProtocolError);
  });

  test("21 headers are refused", () => {
    const headers = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"]));
    const server = { name: "github", type: "http", url: "https://example.test/mcp", transport: "sse", headers };
    const msg = { type: "session.start", start: { ...start, mcpServers: [server] } };
    expect(() => parseServerMessage(JSON.stringify(msg))).toThrow(ProtocolError);
    const twenty = { ...server, headers: Object.fromEntries(Object.entries(headers).slice(0, 20)) };
    expect(parseServerMessage(JSON.stringify({ ...msg, start: { ...start, mcpServers: [twenty] } }))).toMatchObject({ type: "session.start" });
  });

  test("a codex start with acceptEdits is refused", () => {
    for (const permissionMode of ["acceptEdits", "plan"]) {
      const msg = { type: "session.start", start: { ...codexStart, permissionMode } };
      expect(() => parseServerMessage(JSON.stringify(msg))).toThrow(ProtocolError);
    }
    expect(parseServerMessage(JSON.stringify({ type: "session.start", start: { ...codexStart, permissionMode: "default" } }))).toMatchObject({
      start: { harness: "codex", permissionMode: "default" },
    });
  });

  test("a start without skills or mcpServers throws", () => {
    for (const key of ["skills", "mcpServers"]) {
      const old: Record<string, unknown> = { ...start };
      delete old[key];
      expect(() => parseServerMessage(JSON.stringify({ type: "session.start", start: old }))).toThrow(ProtocolError);
    }
  });

  test("per-run key with path separators throws", () => {
    const msg = { type: "session.start", start: { ...start, cwd: { mode: "per-run", runKey: "../etc" } } };
    expect(() => parseServerMessage(JSON.stringify(msg))).toThrow(ProtocolError);
  });
});

describe("runner to server", () => {
  test.each(runnerMessages.map((m, i) => [m.type === "event" ? `event ${m.event.type}` : `${m.type} ${i}`, m] as const))(
    "%s round-trips",
    (_type, msg) => {
      expect(parseRunnerMessage(JSON.stringify(msg))).toEqual(msg);
    },
  );

  test("unknown type throws ProtocolError", () => {
    expect(() => parseRunnerMessage(JSON.stringify({ type: "goodbye" }))).toThrow(ProtocolError);
  });

  test("unknown event type throws ProtocolError", () => {
    const msg = { type: "event", seq: 1, sessionId: "ses_1", event: { type: "telepathy" } };
    expect(() => parseRunnerMessage(JSON.stringify(msg))).toThrow(ProtocolError);
  });
});

describe("bounds", () => {
  test("a choice question at its longest can be answered: answers are keyed by question text", () => {
    const question = "q".repeat(4000);
    const raw = JSON.stringify({
      type: "session.answer",
      sessionId: "ses_1",
      questionId: "qst_1",
      answer: { kind: "choice", answers: { [question]: "Yes" } },
    });
    expect(parseServerMessage(raw)).toMatchObject({ type: "session.answer" });
  });

  test("a 1 MB hello with 500,000 live sessions is refused at once", () => {
    const raw = JSON.stringify({
      type: "hello",
      runnerVersion: "0.1.0",
      clis: {},
      tools: [],
      lastSeq: 0,
      liveSessions: Array.from({ length: 500_000 }, (_, i) => i % 10),
    });
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    expect(() => parseRunnerMessage(raw)).toThrow(ProtocolError);
    expect(performance.now() - started).toBeLessThan(500);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(64 * 1024 * 1024);
  });

  test("a record with too many entries is refused before its entries are parsed", () => {
    const values = Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`k${i}`, i]));
    const raw = JSON.stringify({ type: "event", seq: 1, sessionId: "s", event: { type: "outputs-accepted", values } });
    const started = performance.now();
    expect(() => parseRunnerMessage(raw)).toThrow(/at most 100 entries/);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("every string, array, record and free-form value in the protocol has a maximum", () => {
    const unbounded: string[] = [];
    const walk = (schema: z.ZodType, path: string): void => {
      if (bounded.has(schema)) {
        const def = schema._zod.def as { type: string; out?: z.ZodType };
        if (def.type === "pipe") {
          const record = (def.out as unknown as { _zod: { def: { keyType: z.ZodType; valueType: z.ZodType } } })._zod.def;
          walk(record.keyType, `${path}.<key>`);
          walk(record.valueType, `${path}.*`);
        }
        return;
      }
      const def = schema._zod.def as Record<string, unknown> & { type: string; checks?: { _zod: { def: { check: string } } }[] };
      const hasMax = (def.checks ?? []).some((c) => c._zod.def.check === "max_length");
      switch (def.type) {
        case "string": {
          if (!hasMax) unbounded.push(path);
          // Postgres text and JSONB can't hold U+0000 or a lone surrogate: every protocol string must refuse both.
          const sample = ["a", "/a", "https://a"].find((candidate) => schema.safeParse(candidate).success);
          if (sample === undefined) unbounded.push(`${path} (no valid sample)`);
          else if (schema.safeParse(`${sample}\u0000`).success) unbounded.push(`${path} (accepts NUL)`);
          else if (schema.safeParse(`${sample}\ud800`).success) unbounded.push(`${path} (accepts a lone surrogate)`);
          return;
        }
        case "array":
          if (!hasMax) unbounded.push(path);
          return walk(def.element as z.ZodType, `${path}[]`);
        case "object":
          for (const [key, value] of Object.entries(def.shape as Record<string, z.ZodType>)) walk(value, `${path}.${key}`);
          return;
        case "union":
          (def.options as z.ZodType[]).forEach((option, i) => walk(option, `${path}|${i}`));
          return;
        case "optional":
        case "nullable":
          return walk(def.innerType as z.ZodType, path);
        case "literal":
        case "enum":
        case "boolean":
        case "number":
          return;
        default:
          unbounded.push(`${path} (${def.type})`);
      }
    };
    walk(ServerToRunner, "ServerToRunner");
    walk(RunnerToServer, "RunnerToServer");
    expect(unbounded).toEqual([]);
  });
});

test("seq is any safe integer: it can't run out", () => {
  const event = (seq: number) => JSON.stringify({ type: "event", seq, sessionId: "s", event: { type: "turn-end" } });
  expect(parseRunnerMessage(event(2_147_483_648))).toMatchObject({ seq: 2_147_483_648 });
  expect(parseRunnerMessage(event(Number.MAX_SAFE_INTEGER))).toMatchObject({ seq: Number.MAX_SAFE_INTEGER });
  expect(parseServerMessage(JSON.stringify({ type: "ack", seq: 2_147_483_648 }))).toEqual({ type: "ack", seq: 2_147_483_648 });
  expect(() => parseRunnerMessage(event(Number.MAX_SAFE_INTEGER + 1))).toThrow(ProtocolError);
  expect(() => parseRunnerMessage(event(0))).toThrow(ProtocolError);
});

test("strings storage can't hold (NUL, lone surrogates) are refused anywhere in a message", () => {
  const event = (e: unknown) => JSON.stringify({ type: "event", seq: 1, sessionId: "s", event: e });
  expect(() => parseRunnerMessage(event({ type: "text", delta: "a\u0000b" }))).toThrow(ProtocolError);
  expect(() => parseRunnerMessage(event({ type: "outputs-accepted", values: { "k\u0000": "v" } }))).toThrow(ProtocolError);
  const permission = (input: unknown) =>
    event({ type: "question", questionId: "q", payload: { kind: "permission", toolName: "Bash", input, canAlwaysAllow: false } });
  expect(() => parseRunnerMessage(permission({ command: "ls\u0000" }))).toThrow(ProtocolError);
  expect(() => parseRunnerMessage(permission({ ["k\u0000"]: [1] }))).toThrow(ProtocolError);
  // Lone surrogates aren't valid UTF-8 either.
  expect(() => parseRunnerMessage(event({ type: "text", delta: "a\ud800b" }))).toThrow(ProtocolError);
  expect(() => parseRunnerMessage(event({ type: "outputs-accepted", values: { "k\udc00": "v" } }))).toThrow(ProtocolError);
  expect(() => parseRunnerMessage(permission({ command: ["\ud83d"] }))).toThrow(ProtocolError);
  expect(parseRunnerMessage(event({ type: "text", delta: "a pair: \ud83d\ude00" }))).toMatchObject({ type: "event" });
  // A literal backslash-u0000 is ordinary text.
  expect(parseRunnerMessage(permission({ command: "echo \\u0000" }))).toMatchObject({ type: "event" });
});

describe("output names", () => {
  test.each(["summary", "_x", "a1_b2", "A".repeat(64)])("%s is accepted", (name) => {
    expect(OutputField.safeParse({ name, type: "string" }).success).toBe(true);
  });
  test.each(["", "1st", "has space", "dash-ed", "a.b", "A".repeat(65), "__proto__", "constructor", "prototype", "é"])("%s is refused", (name) => {
    expect(OutputField.safeParse({ name, type: "string" }).success).toBe(false);
  });
});

test("a start's Job token is a short token, never a URL or a header", () => {
  const withToken = (jobToken: unknown) => () => parseServerMessage(JSON.stringify({ type: "session.start", start: { ...start, jobToken } }));
  expect(withToken("dj_abc-DEF_123")).not.toThrow();
  for (const bad of ["", "has space", "https://evil.test/mcp/job", "a\nb", "x".repeat(201), 3, { token: "x" }]) expect(withToken(bad)).toThrow(ProtocolError);
  // A server name can't hold `__`: `mcp__job__x__tool` would read as the Job server's tool `x__tool`.
  // Nor start or end with `_`: `job_` would give `mcp__job___tool`.
  for (const name of ["job__external", "a__b", "__job", "job__", "job_", "_job", "_", "a_"]) {
    expect(() => parseServerMessage(JSON.stringify({ type: "session.start", start: { ...start, mcpServers: [{ name, type: "runner", tool: "fetch" }] } }))).toThrow(ProtocolError);
  }
  for (const name of ["github", "my_server", "a-b_c", "jobs", "job-2"]) {
    expect(() => parseServerMessage(JSON.stringify({ type: "session.start", start: { ...start, mcpServers: [{ name, type: "runner", tool: "fetch" }] } }))).not.toThrow();
  }
  // Nor the name of the Job's tools server.
  expect(() => parseServerMessage(JSON.stringify({ type: "session.start", start: { ...start, mcpServers: [{ name: "job_tools", type: "runner", tool: "fetch" }] } }))).toThrow(ProtocolError);
  // The Job server's name is the runner's to give.
  expect(() => parseServerMessage(JSON.stringify({ type: "session.start", start: { ...start, mcpServers: [{ name: "job", type: "runner", tool: "fetch" }] } }))).toThrow(ProtocolError);
});
