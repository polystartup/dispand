import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type HarnessEvent, MAX_LIVE_SESSIONS, type SessionStart } from "@dispand/runner-protocol";
import { afterEach, expect, test, vi } from "vitest";
import { Sessions, type SessionsOptions } from "./sessions.ts";
import { clearSessions, SkillsRefused, sessionPluginsDir } from "./skills.ts";
import { fakeCodex } from "./fixtures/fake-codex-bin.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    // A session's skill folders are read-only (0555) until the session removes them, which may
    // still be under way when its test ends: unlock them first, as the runner does on start.
    await clearSessions(dir).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

/** A fake CLI that reports session id `cli-1` for a new session (or the one it resumes), then ends its turn. `onStart` sees each start. */
function fakeQuery(onStart?: (options: Options) => void) {
  const calls: Options[] = [];
  const inputs: string[] = [];
  /** What each session's `setMcpServers` got. */
  const servers: Record<string, unknown>[] = [];
  const fn = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    calls.push(options!);
    onStart?.(options!);
    async function* script(): AsyncGenerator<SDKMessage> {
      const input = await prompt[Symbol.asyncIterator]().next();
      if (!input.done) inputs.push(String(input.value.message.content));
      yield { type: "system", subtype: "init", session_id: options!.resume ?? "cli-1" } as SDKMessage;
      yield { type: "result", subtype: "success", result: "ok", session_id: "cli-1" } as SDKMessage;
    }
    return Object.assign(script(), {
      interrupt: vi.fn(async () => undefined),
      setMcpServers: vi.fn(async (set: Record<string, unknown>) => {
        servers.push(set);
        return { added: Object.keys(set), removed: [], errors: {} };
      }),
    });
  };
  return { query: fn as unknown as typeof query, calls, servers, inputs };
}

async function setup(skills?: SessionsOptions["skills"], mcpServers?: Record<string, { command: string }>, onStart?: (options: Options) => void) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const events: [string, HarnessEvent][] = [];
  const fake = fakeQuery(onStart);
  const resumeMap = join(base, "state", "sessions.json");
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false, ...(mcpServers ? { mcpServers } : {}) },
    (sessionId, event) => events.push([sessionId, event]),
    { claude: { query: fake.query }, resumeMap, claudeVersion: "2.1.311", ...(skills ? { skills } : {}) },
  );
  return { base, events, fake, sessions, resumeMap };
}

const start = (sessionId: string, runKey: string, resumeCliSessionId?: string): SessionStart => ({
  sessionId,
  harness: "claude-code",
  cwd: { mode: "per-run", runKey },
  systemPrompt: "",
  prompt: "hi",
  expectedOutputs: [],
  interactive: false,
  permissionMode: "default",
  skills: [],
  mcpServers: [],
  ...(resumeCliSessionId === undefined ? {} : { resumeCliSessionId }),
});

const ended = (events: [string, HarnessEvent][], sessionId: string) =>
  vi.waitFor(() => expect(events.some(([id, e]) => id === sessionId && (e.type === "result" || e.type === "error"))).toBe(true));

test("a known session id resumes in the folder it ran in", async () => {
  const { base, events, fake, sessions, resumeMap } = await setup();
  await sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  await ended(events, "ses_1");
  expect(((await stat(resumeMap)).mode & 0o777).toString(8)).toBe("600");

  await sessions.handle({ type: "session.start", start: start("ses_2", "run_a", "cli-1") });
  await ended(events, "ses_2");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]).toMatchObject({ resume: "cli-1", cwd: join(base, "root", "runs", "run_a") });
});

test.each([
  ["an empty id", ""],
  ["an unknown id", "cli-unknown"],
])("resuming with %s is refused", async (_name, id) => {
  const { events, fake, sessions } = await setup();
  await sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  await ended(events, "ses_1");
  await sessions.handle({ type: "session.start", start: start("ses_2", "run_a", id) });
  expect(events.at(-1)).toEqual(["ses_2", { type: "error", message: expect.stringContaining("resume") }]);
  expect(fake.calls).toHaveLength(1);
});

test("an id mapped to another run's folder is refused", async () => {
  const { base, events, fake, sessions } = await setup();
  await sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  await ended(events, "ses_1");
  await sessions.handle({ type: "session.start", start: start("ses_2", "run_b", "cli-1") });
  expect(events.at(-1)).toEqual(["ses_2", { type: "error", message: expect.stringContaining("resume") }]);
  expect(fake.calls).toHaveLength(1);
  await expect(stat(join(base, "root", "runs", "run_b"))).rejects.toThrow();
});

test("stopAll ends every live session with the error and stops its CLI; new sessions wait while not accepting", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const events: [string, HarnessEvent][] = [];
  const calls: Options[] = [];
  // A CLI that keeps running until it is aborted.
  const hanging = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    calls.push(options!);
    async function* script(): AsyncGenerator<SDKMessage> {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "cli-h" } as SDKMessage;
      await new Promise((resolve) => options!.abortController!.signal.addEventListener("abort", resolve));
    }
    return Object.assign(script(), { interrupt: vi.fn(async () => undefined) });
  }) as unknown as typeof query;
  let accepting = true;
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => events.push([sessionId, event]),
    { claude: { query: hanging }, resumeMap: join(base, "sessions.json"), claudeVersion: "2.1.311", accepting: () => accepting },
  );
  await sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  await sessions.handle({ type: "session.start", start: start("ses_2", "run_b") });
  await vi.waitFor(() => expect(events.filter(([, e]) => e.type === "cli-session")).toHaveLength(2));

  accepting = false;
  sessions.stopAll("Dispand unreachable: the runner's backlog is full");
  await vi.waitFor(() => expect(sessions.ids()).toEqual([]));
  for (const id of ["ses_1", "ses_2"]) {
    expect(events).toContainEqual([id, { type: "error", message: "Dispand unreachable: the runner's backlog is full" }]);
  }
  expect(calls.every((o) => o.abortController!.signal.aborted)).toBe(true);

  await sessions.handle({ type: "session.start", start: start("ses_3", "run_c") });
  expect(events.at(-1)).toEqual(["ses_3", { type: "error", message: expect.stringContaining("backlog") }]);
  expect(calls).toHaveLength(2);
});

test("a start still preparing its folder when the backlog fills never launches the CLI", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const events: [string, HarnessEvent][] = [];
  const fake = fakeQuery();
  let accepting = true;
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => events.push([sessionId, event]),
    { claude: { query: fake.query }, resumeMap: join(base, "sessions.json"), claudeVersion: "2.1.311", accepting: () => accepting },
  );
  const starting = sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  // The backlog fills while the folder is being made.
  accepting = false;
  sessions.stopAll("Dispand unreachable: the runner's backlog is full");
  await starting;
  expect(fake.calls).toHaveLength(0);
  expect(events).toEqual([["ses_1", { type: "error", message: "Dispand unreachable: the runner's backlog is full" }]]);
  expect(sessions.ids()).toEqual([]);
});

test("past the protocol's live-session limit, a start is refused", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const events: [string, HarnessEvent][] = [];
  let launched = 0;
  const hanging = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    launched++;
    async function* script(): AsyncGenerator<SDKMessage> {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: `cli-${launched}` } as SDKMessage;
      await new Promise((resolve) => options!.abortController!.signal.addEventListener("abort", resolve));
    }
    return Object.assign(script(), { interrupt: vi.fn(async () => undefined) });
  }) as unknown as typeof query;
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => events.push([sessionId, event]),
    { claude: { query: hanging }, resumeMap: join(base, "sessions.json"), claudeVersion: "2.1.311" },
  );
  await Promise.all(Array.from({ length: MAX_LIVE_SESSIONS + 1 }, (_, i) => sessions.handle({ type: "session.start", start: start(`ses_${i}`, `run_${i}`) })));
  expect(launched).toBe(MAX_LIVE_SESSIONS);
  expect(sessions.ids()).toHaveLength(MAX_LIVE_SESSIONS);
  expect(events.filter(([, e]) => e.type === "error")).toEqual([[`ses_${MAX_LIVE_SESSIONS}`, { type: "error", message: expect.stringContaining("at most 1000") }]]);
  sessions.stopAll("test over");
});

test.each([
  ["2.1.247", false],
  [undefined, false],
  ["2.1.248", true],
  ["2.2.0", true],
  ["3.0.0", true],
  ["2.1.1000", true],
])("Claude Code %s: sessions start: %s", async (claudeVersion, starts) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const events: [string, HarnessEvent][] = [];
  const fake = fakeQuery();
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => events.push([sessionId, event]),
    { claude: { query: fake.query }, resumeMap: join(base, "sessions.json"), claudeVersion },
  );
  await sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  if (starts) {
    await ended(events, "ses_1");
    expect(fake.calls).toHaveLength(1);
  } else {
    expect(events).toEqual([["ses_1", { type: "error", message: expect.stringContaining("Claude Code ≥ 2.1.248 required") }]]);
    expect(fake.calls).toHaveLength(0);
  }
});

test("a start refused for its permission mode creates no folder; the same run key works once fixed", async () => {
  const { base, events, fake, sessions } = await setup();
  await sessions.handle({ type: "session.start", start: { ...start("ses_1", "run_a"), permissionMode: "bypassPermissions" } });
  expect(events).toEqual([["ses_1", { type: "error", message: expect.stringContaining("bypassPermissions") }]]);
  await expect(stat(join(base, "root", "runs", "run_a"))).rejects.toThrow();
  expect(fake.calls).toHaveLength(0);
  await sessions.handle({ type: "session.start", start: start("ses_2", "run_a") });
  await ended(events, "ses_2");
  expect(fake.calls).toHaveLength(1);
});

test("a CLI that fails before reporting its session id leaves no folder behind", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const events: [string, HarnessEvent][] = [];
  const failing = (() => {
    // Fails on its first read, before any message: like a CLI that can't start.
    const script = (): AsyncGenerator<SDKMessage> => ({
      next: () => Promise.reject(new Error("spawn claude ENOENT")),
      return: async () => ({ done: true, value: undefined }),
      throw: async (e: unknown) => Promise.reject(e),
      [Symbol.asyncIterator]() {
        return this;
      },
      [Symbol.asyncDispose]: async () => {},
    });
    return Object.assign(script(), { interrupt: vi.fn(async () => undefined) });
  }) as unknown as typeof query;
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => events.push([sessionId, event]),
    { claude: { query: failing }, resumeMap: join(base, "sessions.json"), claudeVersion: "2.1.311" },
  );
  await sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  await vi.waitFor(() => expect(sessions.ids()).toEqual([]));
  expect(events).toEqual([["ses_1", { type: "error", message: "spawn claude ENOENT" }]]);
  await vi.waitFor(async () => expect(await stat(join(base, "root", "runs", "run_a")).catch(() => null)).toBeNull());
});

test("the resume mapping is on disk before the CLI session id is reported", async () => {
  const { events, sessions, resumeMap } = await setup();
  const seenOnDisk: boolean[] = [];
  const emitSpy = events.push.bind(events);
  events.push = (...items) => {
    for (const [, e] of items) if (e.type === "cli-session") seenOnDisk.push(readFileSync(resumeMap, "utf8").includes(e.cliSessionId));
    return emitSpy(...items);
  };
  await sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  await ended(events, "ses_1");
  expect(seenOnDisk).toEqual([true]);
});

test("a message for a session that isn't running gets one \"not running\" error per connection; none while the backlog is full", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const events: [string, HarnessEvent][] = [];
  let accepting = true;
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => events.push([sessionId, event]),
    { claude: { query: fakeQuery().query }, resumeMap: join(base, "sessions.json"), claudeVersion: "2.1.311", accepting: () => accepting },
  );
  const flood = async (id: string) => {
    for (let i = 0; i < 5000; i++) {
      await sessions.handle({ type: "session.send", sessionId: id, text: `m${i}` });
      await sessions.handle({ type: "session.answer", sessionId: id, questionId: "q", answer: { kind: "permission", decision: "allow" } });
    }
  };
  const notRunning = (id: string) => [id, { type: "error", message: "the session is not running on this runner" }];
  await flood("ses_gone");
  await flood("ses_other");
  expect(events).toEqual([notRunning("ses_gone"), notRunning("ses_other")]);
  // A new connection: the server may have missed it, so it is said once more.
  sessions.connected();
  await flood("ses_gone");
  expect(events).toEqual([notRunning("ses_gone"), notRunning("ses_other"), notRunning("ses_gone")]);
  // Backlog full: nothing at all.
  accepting = false;
  sessions.connected();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await flood("ses_third");
  expect(events).toHaveLength(3);
  log.mockRestore();
});

test.each([
  ["skills", { skills: [{ packageId: "pkg_1", name: "hello-check" }] }, "this runner can't load skills"],
  ["an unknown runner tool", { mcpServers: [{ name: "fetch", type: "runner" as const, tool: "fetch" }] }, "this runner has no MCP server fetch in its config"],
])("%s ends the start before the CLI starts or any folder is made", async (_name, extra, message) => {
  const { base, events, fake, sessions } = await setup();
  await sessions.handle({ type: "session.start", start: { ...start("ses_1", "run_a"), ...extra } as SessionStart });
  expect(events).toEqual([["ses_1", { type: "error", message }]]);
  expect(fake.calls).toHaveLength(0);
  await expect(stat(join(base, "root", "runs", "run_a"))).rejects.toThrow();
});

test("token absent from state dir: a session's MCP servers reach the CLI, and nothing of them is kept", async () => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "mcp-state-")));
  made.push(stateDir);
  const { base, events, fake, sessions } = await setup({ server: "https://dispand.test", token: "t0ken", stateDir, fetch: vi.fn() }, { echo: { command: "echo-mcp" } });
  const mcpServers = [
    { name: "github", type: "http" as const, url: "https://api.example.test/mcp", transport: "streamable-http" as const, headers: { authorization: "Bearer s3cret" } },
    { name: "local", type: "runner" as const, tool: "echo" },
  ];
  await sessions.handle({ type: "session.start", start: { ...start("ses_1", "run_a"), mcpServers } });
  await ended(events, "ses_1");
  // Through the SDK's control channel, never the CLI's options (its command line).
  expect(Object.keys(fake.calls[0]!.mcpServers!)).toEqual(["dispand"]);
  expect(fake.servers[0]).toMatchObject({
    github: { type: "http", url: "https://api.example.test/mcp", headers: { authorization: "Bearer s3cret" } },
    local: { type: "stdio", command: "/bin/sh", args: expect.arrayContaining(["echo-mcp"]), env: {} },
  });
  expect(Object.keys(fake.servers[0]!).at(-1)).toBe("dispand");
  // A failed start too.
  await sessions.handle({ type: "session.start", start: { ...start("ses_2", "run_b"), mcpServers: [mcpServers[0]!, { name: "x", type: "runner", tool: "gone" }] } });
  await ended(events, "ses_2");
  expect(JSON.stringify(events)).not.toContain("s3cret");
  const files = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  const written = [...(await files(join(base, "state"))), ...(await files(stateDir))];
  expect(written.length).toBeGreaterThan(0);
  for (const file of written) expect(readFileSync(file, "utf8"), file).not.toContain("s3cret");
});

test("a session's skills are fetched, loaded as plugins, readable during it, and gone after it", async () => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "skills-state-")));
  made.push(stateDir);
  const fetch = vi.fn(async () => [{ name: "hello-check", files: [{ path: "hello-check/SKILL.md", content: Buffer.from("---\nname: hello-check\n---\n") }] }]);
  const { events, fake, sessions } = await setup({ server: "https://dispand.test", token: "t0ken", stateDir, fetch });
  const seen: string[] = [];
  const query = fake.query;
  (sessions as unknown as { options: SessionsOptions }).options.claude = {
    query: ((args: Parameters<typeof query>[0]) => {
      const root = args.options!.plugins![0]!.path;
      seen.push(readFileSync(join(root, "skills", "hello-check", "SKILL.md"), "utf8"));
      return query(args);
    }) as typeof query,
  };
  await sessions.handle({ type: "session.start", start: { ...start("ses_1", "run_a"), skills: [{ packageId: "pkg_1", name: "hello-check" }] } });
  await ended(events, "ses_1");
  expect(fetch).toHaveBeenCalledWith("https://dispand.test", "t0ken", [{ packageId: "pkg_1", name: "hello-check" }]);
  const dir = sessionPluginsDir(stateDir, "ses_1");
  expect(fake.calls[0]!.plugins).toEqual([{ type: "local", path: join(dir, "hello-check"), skipMcpDiscovery: true }]);
  expect(seen).toEqual(['---\nname: hello-check\ndescription: ""\n---\n\n']);
  // The session folder is gone after the session ends. It is removed after the result is sent,
  // its files before the folder itself: wait for the folder, not only for a file in it.
  await vi.waitFor(() => expect(stat(join(dir, ".."))).rejects.toThrow());
});

test("a skill package that can't be fetched ends the start before any folder is made", async () => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "skills-state-")));
  made.push(stateDir);
  const fetch = vi.fn(async () => {
    throw new SkillsRefused("Dispand refused skill package hello-check (404)");
  });
  const { base, events, fake, sessions } = await setup({ server: "https://dispand.test", token: "t", stateDir, fetch });
  await sessions.handle({ type: "session.start", start: { ...start("ses_1", "run_a"), skills: [{ packageId: "pkg_1", name: "hello-check" }] } });
  expect(events).toEqual([["ses_1", { type: "error", message: "Dispand refused skill package hello-check (404)" }]]);
  expect(fake.calls).toHaveLength(0);
  await expect(stat(join(base, "root", "runs", "run_a"))).rejects.toThrow();
});

test("a start still fetching its skills holds up only its own session's messages", async () => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "skills-state-")));
  made.push(stateDir);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fetch = vi.fn(async () => {
    await gate;
    return [{ name: "hello-check", files: [{ path: "hello-check/SKILL.md", content: Buffer.from("x") }] }];
  });
  const { events, fake, sessions } = await setup({ server: "https://dispand.test", token: "t", stateDir, fetch });
  const slow = sessions.handle({ type: "session.start", start: { ...start("ses_1", "run_a"), skills: [{ packageId: "pkg_1", name: "hello-check" }] } });
  // Queued behind its own start: handled once it is live, not refused as "not running".
  const interrupt = sessions.handle({ type: "session.interrupt", sessionId: "ses_1" });
  // Another session starts and ends meanwhile.
  await sessions.handle({ type: "session.start", start: start("ses_2", "run_b") });
  await ended(events, "ses_2");
  expect(fake.calls).toHaveLength(1);
  release();
  await slow;
  await interrupt;
  await ended(events, "ses_1");
  // The interrupt reached the live session (not "not running").
  expect(events.filter(([id, e]) => id === "ses_1" && e.type === "error")).toEqual([["ses_1", { type: "error", message: "interrupted" }]]);
});

/** Sessions whose Codex is the fake one, version `version` (null: no Codex on the machine). */
async function codexSetup(version: string | null = "0.166.0", env?: Record<string, string>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const codex = await fakeCodex(made, env);
  const events: [string, HarnessEvent][] = [];
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => events.push([sessionId, event]),
    { resumeMap: join(base, "sessions.json"), claudeVersion: undefined, forbidden: [join(base, "secret")], ...(version === null ? {} : { codex: { codexPath: codex.path, env: codex.env, version } }) },
  );
  const codexStart = (sessionId: string, runKey: string, resumeCliSessionId?: string): SessionStart => ({ ...start(sessionId, runKey, resumeCliSessionId), harness: "codex" } as SessionStart);
  return { base, codex, events, sessions, codexStart };
}

test("a Codex start runs on Codex, with the machine's config denied; resume only for a recorded thread", async () => {
  const { base, codex, events, sessions, codexStart } = await codexSetup();
  await sessions.handle({ type: "session.start", start: codexStart("ses_1", "run_a") });
  await ended(events, "ses_1");
  expect(events.filter(([id]) => id === "ses_1").map(([, e]) => e)).toEqual([
    { type: "cli-session", cliSessionId: "thr_1" },
    { type: "result", text: "" },
  ]);
  const thread = (await codex.received()).find((m) => m.method === "thread/start")!;
  expect(JSON.stringify(thread)).toContain(`"${join(base, "secret")}":"deny"`);

  await sessions.handle({ type: "session.start", start: codexStart("ses_2", "run_a", "thr_1") });
  await ended(events, "ses_2");
  expect((await codex.received()).find((m) => m.method === "thread/resume")).toMatchObject({ params: { threadId: "thr_1", cwd: join(base, "root", "runs", "run_a") } });

  await sessions.handle({ type: "session.start", start: codexStart("ses_3", "run_b", "thr_unknown") });
  expect(events.at(-1)).toEqual(["ses_3", { type: "error", message: expect.stringContaining("can't resume") }]);
});

test.each([
  ["no Codex", null, "Codex isn't installed"],
  ["an old Codex", "0.165.0", "Codex ≥ 0.166.0 required"],
])("%s refuses Codex sessions before any folder is made", async (_name, version, message) => {
  const { base, events, sessions, codexStart } = await codexSetup(version);
  await sessions.handle({ type: "session.start", start: codexStart("ses_1", "run_a") });
  expect(events).toEqual([["ses_1", { type: "error", message: expect.stringContaining(message) }]]);
  await expect(stat(join(base, "root", "runs", "run_a"))).rejects.toThrow();
});

test("session.stop acknowledges exit only after the process finishes, including an absent session", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const events: [string, HarnessEvent][] = [];
  const calls: Options[] = [];
  let exit!: () => void;
  const exiting = new Promise<void>((resolve) => (exit = resolve));
  // A CLI that keeps running until it is aborted.
  const hanging = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    calls.push(options!);
    async function* script(): AsyncGenerator<SDKMessage> {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "cli-h" } as SDKMessage;
      await new Promise((resolve) => options!.abortController!.signal.addEventListener("abort", resolve));
      if (options!.cwd!.endsWith("run_a")) await exiting;
    }
    return Object.assign(script(), { interrupt: vi.fn(async () => undefined) });
  }) as unknown as typeof query;
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
    (sessionId, event) => events.push([sessionId, event]),
    { claude: { query: hanging }, resumeMap: join(base, "sessions.json"), claudeVersion: "2.1.311" },
  );
  await sessions.handle({ type: "session.start", start: start("ses_1", "run_a") });
  await sessions.handle({ type: "session.start", start: start("ses_2", "run_b") });
  await vi.waitFor(() => expect(events.filter(([, e]) => e.type === "cli-session")).toHaveLength(2));

  await sessions.handle({ type: "session.stop", sessionId: "ses_1" });
  expect(events.filter(([, e]) => e.type === "session-ended")).toEqual([]);
  expect(sessions.ids()).toContain("ses_1");
  exit();
  await vi.waitFor(() => expect(sessions.ids()).toEqual(["ses_2"]));
  expect(events.filter(([id, e]) => id === "ses_1" && e.type === "session-ended")).toHaveLength(1);
  expect(events.filter(([id, e]) => id === "ses_1" && e.type === "error")).toEqual([["ses_1", { type: "error", message: "Stopped" }]]);
  expect(calls.map((o) => o.abortController!.signal.aborted)).toEqual([true, false]);

  // Stopped already, or never here: acknowledge absence without another error.
  const before = events.length;
  await sessions.handle({ type: "session.stop", sessionId: "ses_1" });
  await sessions.handle({ type: "session.stop", sessionId: "ses_never" });
  expect(events.slice(before)).toEqual([["ses_1", { type: "session-ended" }], ["ses_never", { type: "session-ended" }]]);
  await sessions.shutdown();
});

test("a start with a Job token gives the CLI the Job server at the runner's own server, and lets its tools run", async () => {
  const { events, fake, sessions } = await setup();
  await sessions.handle({ type: "session.start", start: { ...start("ses_1", "run_a"), jobToken: "dj_token" } });
  await ended(events, "ses_1");
  expect(fake.servers[0]).toMatchObject({ job: { type: "http", url: "https://dispand.test/mcp/job", headers: { authorization: "Bearer dj_token" } } });
  // A start without one gets none.
  await sessions.handle({ type: "session.start", start: start("ses_2", "run_b") });
  await ended(events, "ses_2");
  expect(Object.keys(fake.servers[1] ?? {})).not.toContain("job");
});

test("a consult waits across a reconnection to Dispand, and its answer then reaches the session's tool call", async () => {
  const call = { request: "item/tool/call", params: { threadId: "$THREAD", turnId: "$TURN", callId: "c1", namespace: null, tool: "consult", arguments: { agent: "agt_arch", question: "May it add a table?" } } };
  const done = { notify: "item/completed", params: { threadId: "$THREAD", item: { type: "agentMessage", id: "m1", text: "Done" } } };
  const { codex, events, sessions, codexStart } = await codexSetup("0.166.0", { FAKE_CODEX_TURNS: JSON.stringify([[call, done]]) });
  const consults = [{ agentId: "agt_arch", name: "Architect", description: "" }];
  await sessions.handle({ type: "session.start", start: { ...codexStart("ses_1", "run_a"), consults } });
  const question = await vi.waitFor(() => {
    const found = events.find(([, e]) => e.type === "question")?.[1];
    expect(found).toBeDefined();
    return found as Extract<HarnessEvent, { type: "question" }>;
  });
  expect(question.payload).toEqual({ kind: "consult", agentId: "agt_arch", question: "May it add a table?" });
  // The connection drops and comes back: the session keeps waiting, and Dispand sends the answer then.
  sessions.connected();
  expect(sessions.ids()).toEqual(["ses_1"]);
  await sessions.handle({ type: "session.answer", sessionId: "ses_1", questionId: question.questionId, answer: { kind: "consult", outcome: "answered", text: "Yes." } });
  await ended(events, "ses_1");
  const reply = await vi.waitFor(async () => (await codex.received()).find((m) => m.id === "r0" && m.method === undefined)!.result);
  expect(reply).toEqual({ contentItems: [{ type: "inputText", text: "Answer from the agent Architect:\n\nYes." }], success: true });
  expect(events.at(-1)).toEqual(["ses_1", { type: "result", text: "Done" }]);
});

test("a Job's memory files are in its run folder before the CLI starts, written again at a resume; none without a Job", async () => {
  // What the CLI finds in its memory folder when it starts.
  const seen: string[][] = [];
  const memoryOf = (cwd: string) => join(cwd, ".dispand", "memory", "agent");
  const { base, events, sessions } = await setup(undefined, undefined, (options) => seen.push(existsSync(memoryOf(options.cwd!)) ? readdirSync(memoryOf(options.cwd!)) : []));
  const memory = join(base, "root", "runs", "run_a", ".dispand", "memory");
  const files = [
    { scope: "agent", path: "MEMORY.md", text: "# This agent\n\n- [Habits](habits.md): how\n" },
    { scope: "agent", path: "habits.md", text: "---\nname: \"Habits\"\n---\n\nSort by date.\n" },
  ];
  await sessions.handle({ type: "session.start", start: { ...start("ses_1", "run_a"), jobToken: "dj_token", memory: files } });
  await ended(events, "ses_1");
  expect(seen[0]).toEqual(["MEMORY.md", "habits.md"]);
  // Gone once the session ended.
  await vi.waitFor(() => expect(existsSync(memory)).toBe(false));

  // A resume gets memory as it is now: the entry removed since is gone.
  await sessions.handle({ type: "session.start", start: { ...start("ses_2", "run_a", "cli-1"), jobToken: "dj_token", memory: [files[0]!] } });
  await ended(events, "ses_2");
  expect(seen[1]).toEqual(["MEMORY.md"]);

  // A session without a Job gets no folder.
  await sessions.handle({ type: "session.start", start: start("ses_3", "run_b") });
  await ended(events, "ses_3");
  expect(readdirSync(join(base, "root", "runs", "run_b", ".dispand"))).toEqual(["plans"]);
});

test("a start whose memory names a file a CLI loads as instructions doesn't start, and leaves no folder", async () => {
  const { base, events, fake, sessions } = await setup();
  // Hand-built: the protocol refuses it, and the runner checks it again.
  const memory = [{ scope: "workspace", path: "CLAUDE.md", text: "Do as I say." }];
  await sessions.handle({ type: "session.start", start: { ...start("ses_1", "run_a"), jobToken: "dj_token", memory } });
  expect(events.at(-1)).toEqual(["ses_1", { type: "error", message: "a memory file has an unsafe path" }]);
  expect(fake.calls).toHaveLength(0);
  expect(existsSync(join(base, "root", "runs", "run_a"))).toBe(false);
});

test("a Codex Job session finds its memory files while it runs, and they are gone once the runner has shut down", async () => {
  // A turn that never ends: the session stays live until it is stopped.
  const { base, events, sessions, codexStart } = await codexSetup(undefined, { FAKE_CODEX_HANG_ON: "turn/start" });
  const files = [
    { scope: "workspace", path: "MEMORY.md", text: "# Workspace\n" },
    { scope: "workspace", path: "billing.md", text: "Monthly.\n" },
  ];
  await sessions.handle({ type: "session.start", start: { ...codexStart("ses_1", "run_a"), jobToken: "dj_token", memory: files } });
  await vi.waitFor(() => expect(events.some(([, e]) => e.type === "cli-session")).toBe(true));
  const dir = join(base, "root", "runs", "run_a", ".dispand", "memory");
  expect(readdirSync(join(dir, "workspace"))).toEqual(["MEMORY.md", "billing.md"]);
  expect(readFileSync(join(dir, "workspace", "billing.md"), "utf8")).toBe("Monthly.\n");
  // Shutting down waits until they are removed, not only until the CLI is stopped.
  await sessions.shutdown();
  expect(existsSync(dir)).toBe(false);
});

test("revoking a grant during skill fetching narrows the start before the CLI launches", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-permissions-")));
  made.push(base);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetch = vi.fn(async () => { await gate; return []; });
  const fake = fakeQuery();
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false, mcpServers: { gmail: { command: process.execPath } } },
    () => undefined,
    { claude: { query: fake.query }, resumeMap: join(base, "sessions.json"), claudeVersion: "2.1.311", skills: { server: "https://dispand.test", token: "t", stateDir: join(base, "state"), fetch } },
  );
  const message = { ...start("ses_1", "run_a"), jobToken: "token", skills: [{ packageId: "pkg_1", name: "hello" }], mcpServers: [{ name: "mail", type: "runner" as const, tool: "gmail", unasked: ["draft_email"] }] };
  const slow = sessions.handle({ type: "session.start", start: message });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await sessions.handle({ type: "session.permissions", sessionId: "ses_1", servers: [{ name: "mail", unasked: [] }] });
  // A later update cannot restore the removed grant while the start is still preparing.
  await sessions.handle({ type: "session.permissions", sessionId: "ses_1", servers: [{ name: "mail", unasked: ["draft_email", "send_email"] }] });
  release();
  await slow;
  expect(fake.calls).toHaveLength(1);
  const hook = fake.calls[0]!.hooks!.PreToolUse!.flatMap((m) => m.hooks)[0]!;
  expect(await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__mail__draft_email", tool_input: {}, tool_use_id: "tu", session_id: "ses_1", transcript_path: "", cwd: base } as never, "tu", { signal: new AbortController().signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  await sessions.shutdown();
});

test("a verified native installation replaces its injected copy; disabling it restores the workspace package", async () => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "native-skills-")));
  made.push(stateDir);
  const fetch = vi.fn(async () => [{ name: "hello-check", nativePlugin: "dispand-plugin_1", nativeKey: "source-key", files: [{ path: "hello-check/SKILL.md", content: Buffer.from("---\nname: hello-check\n---\n") }] }]);
  const { events, fake, sessions } = await setup({ server: "https://dispand.test", token: "t0ken", stateDir, fetch });
  const request = vi.fn()
    .mockResolvedValueOnce({ packages: [{ name: "dispand-plugin_1", sourceKey: "source-key", namespace: "actual-native", harness: "claude-code", installed: true, enabled: true, pending: false }] })
    .mockResolvedValueOnce({ packages: [{ name: "dispand-plugin_1", sourceKey: "source-key", harness: "claude-code", installed: true, enabled: false, pending: false }] });
  (sessions as unknown as { options: SessionsOptions }).options.nativePlugins = { request };
  for (const [sessionId, runKey] of [["ses_native", "run_native"], ["ses_fallback", "run_fallback"]]) {
    await sessions.handle({ type: "session.start", start: { ...start(sessionId!, runKey!), prompt: "/hello-check:hello-check args", skills: [{ packageId: "pkg_1", name: "hello-check" }] } });
    await ended(events, sessionId!);
  }
  expect(fake.inputs).toEqual(["/actual-native:hello-check args", "/hello-check:hello-check args"]);
  expect(fake.calls[0]!.plugins).toBeUndefined();
  expect(fake.calls[1]!.plugins).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(2);
});


test.each([
  { harness: "claude-code", change: "deny" },
  { harness: "codex", change: "deny" },
  { harness: "claude-code", change: "remove" },
  { harness: "codex", change: "remove" },
] as const)("$harness applies startup $change updates before native MCP configuration", async ({ harness, change }) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-restricted-")));
  made.push(base);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetch = vi.fn(async () => { await gate; return []; });
  const fake = fakeQuery();
  const codex = await fakeCodex(made);
  const events: [string, HarnessEvent][] = [];
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false, mcpServers: { gmail: { command: process.execPath } } },
    (id, event) => events.push([id, event]),
    { claude: { query: fake.query }, codex: { codexPath: codex.path, env: codex.env, version: "0.167.0" }, resumeMap: join(base, "sessions.json"), claudeVersion: "2.1.311", skills: { server: "https://dispand.test", token: "t", stateDir: join(base, "state"), fetch } },
  );
  const message = { ...start("ses_1", "run_a"), harness, permissionMode: "default", jobToken: "token", skills: [{ packageId: "pkg_1", name: "hello" }], mcpServers: [{ name: "mail", type: "runner", tool: "gmail", unasked: ["draft_email"] }] } as SessionStart;
  const slow = sessions.handle({ type: "session.start", start: message });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  const servers = change === "remove" ? [] : [{ name: "mail", unasked: [], denied: ["draft_email"] }];
  await sessions.handle({ type: "session.permissions", sessionId: "ses_1", servers });
  // Later messages cannot resurrect a removed server or clear its action denials.
  await sessions.handle({ type: "session.permissions", sessionId: "ses_1", servers: [{ name: "mail", unasked: ["draft_email"], denied: [] }] });
  release();
  await slow;
  await ended(events, "ses_1");
  if (harness === "codex") {
    const thread = (await codex.received()).find((m) => m.method === "thread/start")!;
    const configured = (thread.params as { config: { mcp_servers: Record<string, unknown> } }).config.mcp_servers;
    if (change === "remove") expect(configured).not.toHaveProperty("mail");
    else expect(configured.mail).toMatchObject({ disabled_tools: ["draft_email"] });
  } else if (change === "remove") expect(fake.servers[0]).not.toHaveProperty("mail");
  else expect(fake.calls[0]!.disallowedTools).toContain("mcp__mail__draft_email");
  await sessions.shutdown();
});
