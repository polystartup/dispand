// A conversation resumes in a fresh worker from its kept transcript, and from nothing else: a
// workspace alone can't resume, nothing a worker wrote loads as settings, and a restarted
// supervisor attaches no storage until what a previous run left is gone. Real gVisor in CI.
import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { HarnessEvent, SessionStart } from "@dispand/runner-protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Sandbox } from "../../src/sandbox/worker.ts";
import { Sessions } from "../../src/sessions.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);

describe.skipIf(!RUNTIME)(`resuming on ${RUNTIME}`, () => {
  const net = `dispand-resume-${process.pid}`;
  const owner = `test-resume-${process.pid}`;
  let state: SandboxState;
  let double: string;

  beforeAll(async () => {
    state = await sandboxState();
    await docker("network", "create", "--internal", net);
    await docker("run", "-d", "--name", net, "--network", net, "--read-only", "-v", `${resolve("test/sandbox/model-double.mjs")}:/double.mjs:ro`, IMAGE, "node", "/double.mjs");
    double = `http://${(await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, net)).stdout.trim()}:8080`;
  }, 120_000);
  afterAll(async () => {
    await docker("rm", "-f", net).catch(() => undefined);
    await docker("network", "rm", net).catch(() => undefined);
    await state.done();
  });

  const sandbox = () => new Sandbox({
    owner, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net,
    extraEnv: { ANTHROPIC_BASE_URL: double, ANTHROPIC_API_KEY: "sk-double" }, openaiBaseUrl: double,
  });
  /** As the supervisor does at start: every worker waits for this sweep. */
  const swept = (s: Sandbox) => (void s.sweep(), s);
  /** A supervisor: its own Sessions over the same root and resume map, as after a restart. */
  const supervisor = (harness: string) => {
    const events: [string, HarnessEvent][] = [];
    const sessions = new Sessions(
      { server: "https://dispand.test", roots: [join(state.base, harness, "root")], allowBypass: false },
      (sessionId, event) => events.push([sessionId, event]),
      { sandbox: swept(sandbox()), claude: { claudePath: "claude", env: process.env }, codex: { codexPath: "codex", env: process.env, version: "0.169.0" }, claudeVersion: "2.1.326", resumeMap: join(state.base, harness, "sessions.json") },
    );
    return { events, sessions };
  };
  const start = (harness: "claude-code" | "codex", sessionId: string, runKey: string, prompt: string, resumeCliSessionId?: string): SessionStart => ({
    sessionId, harness, cwd: { mode: "per-run", runKey }, systemPrompt: "", prompt, expectedOutputs: [], interactive: true, permissionMode: "default", skills: [], mcpServers: [],
      ...(harness === "codex" ? { model: "gpt-double" } : {}),
    ...(resumeCliSessionId ? { resumeCliSessionId } : {}),
  });
  const text = (events: [string, HarnessEvent][], id: string) => events.filter(([s, e]) => s === id && e.type === "text").map(([, e]) => (e as { delta: string }).delta).join("");
  const ended = (events: [string, HarnessEvent][], id: string) => events.some(([s, e]) => s === id && e.type === "turn-end");

  /** Runs one turn and stops the session: its worker gone, its transcript kept. Returns the CLI session id. */
  async function firstTurn(harness: "claude-code" | "codex", runKey: string, prompt: string, answer?: (sessions: Sessions, events: [string, HarnessEvent][]) => Promise<void>) {
    const { sessions, events } = supervisor(harness);
    await sessions.handle({ type: "session.start", start: start(harness, "first", runKey, prompt) });
    if (answer) await answer(sessions, events);
    await vi.waitFor(() => { expect(events.find(([, e]) => e.type === "error"), JSON.stringify(events)).toBeUndefined(); expect(ended(events, "first")).toBe(true); }, { timeout: 120_000, interval: 500 });
    const cli = events.find(([, e]) => e.type === "cli-session")![1] as { cliSessionId: string };
    await sessions.handle({ type: "session.stop", sessionId: "first" });
    await vi.waitFor(() => expect(events.some(([, e]) => e.type === "session-ended")).toBe(true), { timeout: 60_000 });
    return cli.cliSessionId;
  }

  test.each(["claude-code", "codex"] as const)("%s: continues from its transcript in a new worker", async (harness) => {
    const cli = await firstTurn(harness, `${harness}-resume`, "REMEMBER alpha");
    const { sessions, events } = supervisor(harness);
    await sessions.handle({ type: "session.start", start: start(harness, "second", `${harness}-resume`, "RECALL", cli) });
    await vi.waitFor(() => { expect(events.find(([, e]) => e.type === "error"), JSON.stringify(events)).toBeUndefined(); expect(text(events, "second")).toContain("found alpha"); }, { timeout: 120_000, interval: 500 });
    await sessions.handle({ type: "session.stop", sessionId: "second" });
  }, 300_000);

  test.each(["claude-code", "codex"] as const)("%s: a workspace without its transcript fails with cannot-resume", async (harness) => {
    const cli = await firstTurn(harness, `${harness}-lost`, "REMEMBER alpha");
    const transcripts = join(state.base, harness, "root", "cli", `${harness}-lost`);
    for (const dir of await readdir(transcripts)) await rm(join(transcripts, dir), { recursive: true, force: true });
    const { sessions, events } = supervisor(harness);
    await sessions.handle({ type: "session.start", start: start(harness, "second", `${harness}-lost`, "RECALL", cli) });
    await vi.waitFor(() => expect(events.find(([, e]) => e.type === "error")?.[1]).toMatchObject({ kind: "cannot-resume" }), { timeout: 120_000, interval: 500 });
  }, 300_000);

  test("a hook or settings an action wrote, in the workspace or the CLI's home, doesn't run on resume", async () => {
    const cli = await firstTurn("claude-code", "planted", "PLANT", async (sessions, events) => {
      await vi.waitFor(() => expect(events.some(([, e]) => e.type === "question")).toBe(true), { timeout: 120_000, interval: 500 });
      const q = events.find(([, e]) => e.type === "question")![1] as { questionId: string };
      await sessions.handle({ type: "session.answer", sessionId: "first", questionId: q.questionId, answer: { kind: "permission", decision: "allow" } });
    });
    const workspace = join(state.base, "claude-code", "root", "runs", "planted");
    // The plant ran: its settings are in the workspace; the CLI home's copy went with its worker.
    await stat(join(workspace, ".claude", "settings.json"));
    const { sessions, events } = supervisor("claude-code");
    await sessions.handle({ type: "session.start", start: start("claude-code", "second", "planted", "RECALL", cli) });
    await vi.waitFor(() => { expect(events.find(([, e]) => e.type === "error"), JSON.stringify(events)).toBeUndefined(); expect(ended(events, "second")).toBe(true); }, { timeout: 120_000, interval: 500 });
    await expect(stat(join(workspace, "hooked"))).rejects.toThrow();
    await sessions.handle({ type: "session.stop", sessionId: "second" });
  }, 300_000);

  test("a restarted supervisor removes what its previous run left before taking any session", async () => {
    // A worker of a previous run, still running, with this supervisor's label.
    await docker("run", "-d", "--label", "dispand.runner.worker=1", "--label", `dispand.runner.supervisor=${owner}`, "--runtime", RUNTIME!, "--network", "none", IMAGE, "sleep", "1000");
    const other = (await docker("run", "-d", "--label", "dispand.runner.supervisor=someone-else", "--network", "none", IMAGE, "sleep", "1000")).stdout.trim();
    try {
      expect(await sandbox().sweep()).toBe(1);
      // Confirmed gone when the sweep returns; another supervisor's worker untouched.
      expect((await docker("ps", "-aq", "--filter", `label=dispand.runner.supervisor=${owner}`)).stdout.trim()).toBe("");
      expect((await docker("ps", "-q", "--filter", `id=${other}`)).stdout.trim()).not.toBe("");
    } finally {
      await docker("rm", "-f", other).catch(() => undefined);
    }
  }, 120_000);
});
