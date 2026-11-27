import { expect, test, vi } from "vitest";
import { codexDenied, sandboxDenied } from "../boundary.ts";
import { BypassRefused } from "../outcome.ts";
import { ASK, askDescription, ASK_INPUT_SCHEMA } from "@dispand/runner-protocol";
import { codexConfig } from "./config.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import { type CodexDeps, type CodexSessionStart, type CodexState, codexThreadOptions, prepareSandbox, turnCompleted } from "./session.ts";

const base: CodexSessionStart = {
  sessionId: "ses_1",
  harness: "codex",
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
const GRANT = { id: "grant_1", enrollmentId: "enr_1", ttlMs: 60_000 };
const deps: CodexDeps = { codexPath: "/nonexistent/codex", secrets: [], env: {} };

test.each([
  ["default", {}, { restricted: false, bypass: false }],
  ["bypassPermissions", { allowBypass: true }, { restricted: false, bypass: true }],
  // A restricted start never bypasses questions, whatever its mode.
  ["bypassPermissions", { allowBypass: true, restricted: true }, { restricted: true, bypass: false }],
  ["default", { restricted: true }, { restricted: true, bypass: false }],
] as const)("a %s start (%o) prepares %o", (permissionMode, over, expected) => {
  const { restricted, ...allow } = over as { restricted?: boolean; allowBypass?: boolean };
  const prepared = prepareSandbox({ ...base, permissionMode, ...(restricted ? { restricted } : {}) }, cwd, { ...deps, ...allow });
  expect({ restricted: prepared.restricted, bypass: prepared.bypass }).toEqual(expected);
  expect(prepared.denied).toEqual(codexDenied([]));
});

test("bypassPermissions where the machine doesn't allow it, or a personal session without its worker and relay, is refused", () => {
  expect(() => prepareSandbox({ ...base, permissionMode: "bypassPermissions" }, cwd, deps)).toThrow(BypassRefused);
  const grant: CodexSessionStart = { ...base, grant: GRANT };
  expect(() => prepareSandbox(grant, cwd, deps)).toThrow("a personal session needs its worker and its relay");
});

/** The thread's arguments for a session prepared with `bypass` and `restricted`, the user's config naming `configured`. */
function threadOptions(
  o: { start?: Partial<CodexSessionStart>; deps?: Partial<CodexDeps>; bypass?: boolean; restricted?: boolean; configured?: string[] } = {},
) {
  const start = { ...base, ...o.start } as CodexSessionStart;
  const sessionDeps = { ...deps, ...o.deps };
  const denied = codexDenied(sessionDeps.secrets);
  return codexThreadOptions({
    start,
    cwd,
    deps: sessionDeps,
    restricted: o.restricted ?? false,
    bypass: o.bypass ?? false,
    denied,
    configured: o.configured ?? [],
    nativePrompts: {},
  });
}

test.each([false, true])("with bypass %s, MCP approvals stay on and the profile follows it", (bypass) => {
  const { overrides } = threadOptions({ bypass });
  expect(overrides).toEqual({
    cwd,
    model: null,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    config: codexConfig({ codexHome: undefined, denied: sandboxDenied(codexDenied([]), deps.codexPath), bypass, restricted: false, mcpServers: {} }),
    developerInstructions: base.systemPrompt,
  });
});

test("the Job's server is required; a restricted start turns the user's other servers off", () => {
  const servers = { job: { url: "http://127.0.0.1:1/mcp" }, tools: { url: "http://127.0.0.1:2/mcp" } };
  const mcp = { servers, env: {} };
  const open = threadOptions({ deps: { mcp, jobServer: "job" }, configured: ["mine"] });
  expect(open.overrides.config).toEqual(
    codexConfig({
      codexHome: undefined,
      denied: sandboxDenied(codexDenied([]), deps.codexPath),
      bypass: false,
      restricted: false,
      mcpServers: { ...servers, job: { ...servers.job, required: true } },
    }),
  );
  const restricted = threadOptions({ deps: { mcp, jobServer: "job" }, configured: ["mine"], restricted: true });
  expect(restricted.overrides.config).toEqual(
    codexConfig({
      codexHome: undefined,
      denied: sandboxDenied(codexDenied([]), deps.codexPath),
      bypass: false,
      restricted: true,
      mcpServers: { mine: { enabled: false }, ...servers, job: { ...servers.job, required: true } },
    }),
  );
});

test("the model, the worker's model route, the skill packages' folder and CODEX_HOME reach the thread", () => {
  const { overrides } = threadOptions({
    start: { model: "codex-model", systemPrompt: "" },
    deps: { modelBaseUrl: "http://127.0.0.1:3", pluginsDir: "/p/plugins", env: { CODEX_HOME: "/codex-home" } },
  });
  expect(overrides.model).toBe("codex-model");
  expect(overrides.developerInstructions).toBeNull();
  expect(overrides.config).toEqual(
    codexConfig({
      modelBaseUrl: "http://127.0.0.1:3",
      codexHome: "/codex-home",
      denied: sandboxDenied(codexDenied([]), deps.codexPath),
      pluginsDir: "/p/plugins",
      bypass: false,
      restricted: false,
      mcpServers: {},
    }),
  );
});

test("a personal session's relay reaches the thread only with its grant", () => {
  const subscriptionRelay = { url: "http://127.0.0.1:4", grant: "token" };
  const withGrant = threadOptions({ start: { grant: GRANT }, deps: { subscriptionRelay } });
  expect(withGrant.overrides.config).toEqual(
    codexConfig({
      subscriptionRelay,
      codexHome: undefined,
      denied: sandboxDenied(codexDenied([]), deps.codexPath),
      bypass: false,
      restricted: false,
      mcpServers: {},
    }),
  );
  const without = threadOptions({ deps: { subscriptionRelay } });
  expect(without.overrides.config).toEqual(
    codexConfig({ codexHome: undefined, denied: sandboxDenied(codexDenied([]), deps.codexPath), bypass: false, restricted: false, mcpServers: {} }),
  );
});

test("Dispand's dynamic tools: submit_outputs with every expected output required, request_approval and ask", () => {
  const { spec, approvalSpec, askSpec } = threadOptions();
  expect(spec).toMatchObject({
    type: "function",
    name: "submit_outputs",
    inputSchema: { properties: { summary: { type: "string", description: "One line" } }, required: ["summary"], additionalProperties: false },
  });
  expect(approvalSpec).toMatchObject({ type: "function", name: "request_approval", inputSchema: { required: ["message"], additionalProperties: false } });
  expect(askSpec).toEqual({ type: "function", name: ASK, description: askDescription(base), inputSchema: ASK_INPUT_SCHEMA });
});

const turn = (fields: Partial<Turn> = {}) =>
  ({ id: "turn_1", rootTurnId: null, items: [], status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null, ...fields }) as Turn;

/** A turn's end with the session in `state` and `waiting` messages left after its steers are queued. */
function ending(over: { state?: Partial<CodexState>; waiting?: number } = {}) {
  const state: CodexState = {
    finished: false,
    rpc: undefined,
    threadId: "thread_1",
    running: true,
    turnId: "turn_1",
    interrupted: false,
    turnAbort: new AbortController(),
    closing: false,
    lastText: "done",
    ...over.state,
  };
  const input = { steersQueued: vi.fn(), waiting: () => over.waiting ?? 0, nextTurn: vi.fn(async () => {}) };
  const outcome = { turnEnded: vi.fn() };
  return { state, input, outcome, ctx: { state, input, outcome } };
}

test.each([
  ["a completed turn", turn(), {}, { interrupted: false, text: "done", queued: false }],
  [
    "a failed turn",
    turn({ status: "failed", error: { message: "model error" } as Turn["error"] }),
    {},
    { interrupted: false, error: "model error", text: "done", queued: false },
  ],
  ["a failed turn without a message", turn({ status: "failed" }), {}, { interrupted: false, error: "the turn failed", text: "done", queued: false }],
  ["a turn Codex reports interrupted", turn({ status: "interrupted" }), {}, { interrupted: true, text: "done", queued: false }],
  ["a turn interrupted from here", turn(), { state: { interrupted: true } }, { interrupted: true, text: "done", queued: false }],
  ["a turn with messages still waiting", turn(), { waiting: 1 }, { interrupted: false, text: "done", queued: true }],
  // Its id came with neither `turn/start`'s reply nor `turn/started`: the completion is the one running.
  ["a turn whose id wasn't known yet", turn({ id: "turn_9" }), { state: { turnId: undefined } }, { interrupted: false, text: "done", queued: false }],
] as const)("%s ends as the outcome's turn end, and the next message's turn starts", (_name, done, over, expected) => {
  const { state, input, outcome, ctx } = ending(over);
  turnCompleted(done, ctx);
  expect(input.steersQueued).toHaveBeenCalledOnce();
  expect(outcome.turnEnded).toHaveBeenCalledExactlyOnceWith(expected);
  expect(input.nextTurn).toHaveBeenCalledOnce();
  expect(state).toMatchObject({ running: false, interrupted: false, turnId: undefined });
});

test.each([
  ["another turn's completion", turn({ id: "turn_0" }), {}],
  ["a completion while no turn runs", turn(), { state: { running: false } }],
] as const)("%s changes nothing", (_name, done, over) => {
  const { state, input, outcome, ctx } = ending(over);
  const before = { ...state };
  turnCompleted(done, ctx);
  expect(outcome.turnEnded).not.toHaveBeenCalled();
  expect(input.steersQueued).not.toHaveBeenCalled();
  expect(input.nextTurn).not.toHaveBeenCalled();
  expect(state).toEqual(before);
});
