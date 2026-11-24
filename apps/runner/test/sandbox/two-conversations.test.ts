// Two conversations at once, each in its own worker, through the runner's own session adapters
// and the model doubles (`model-double.mjs`): each sees only its own workspace, and a shell write
// asks first and honors the answer. Real gVisor in CI (DISPAND_SANDBOX_RUNTIME=runsc).
import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
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

describe.skipIf(!RUNTIME)(`two conversations on ${RUNTIME}`, () => {
  const net = `dispand-double-${process.pid}`;
  let state: SandboxState;
  let base: string;
  // gVisor's own network stack skips Docker's embedded DNS: the double is reached by its address.
  let double: string;

  beforeAll(async () => {
    state = await sandboxState();
    base = state.base;
    // Internal: the workers and the double reach each other and nothing else.
    await docker("network", "create", "--internal", net);
    await docker("run", "-d", "--name", net, "--network", net, "--read-only",
      "-v", `${resolve("test/sandbox/model-double.mjs")}:/double.mjs:ro`, IMAGE, "node", "/double.mjs");
    const { stdout } = await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, net);
    double = `http://${stdout.trim()}:8080`;
  });
  afterAll(async () => {
    await docker("logs", net).then(({ stdout }) => console.log(stdout)).catch(() => undefined);
    await docker("rm", "-f", net).catch(() => undefined);
    await docker("network", "rm", net).catch(() => undefined);
    await state.done();
  });

  test("a worker on the doubles' network reaches them", async () => {
    const sandbox = new Sandbox({ owner: `test-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net });
    await sandbox.sweep();
    await mkdir(join(base, "probe", "runs", "p"), { recursive: true });
    const worker = await sandbox.worker(join(base, "probe", "runs", "p"), join(base, "probe", "cli", "p"));
    const child = worker.probe(["node", "-e", "fetch(process.argv[1] + '/v1/messages', { method: 'POST', body: '{}' }).then((r) => console.log('status', r.status), (e) => console.log('failed', e.cause?.code ?? e.message))", double]);
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    await new Promise((r) => child.on("exit", r));
    await worker.remove();
    expect(out).toContain("status 200");
  }, 120_000);

  test.each(["claude-code", "codex"] as const)("%s: each sees only its own workspace, and a shell write waits for its answer", async (harness) => {
    const root = join(base, harness, "root");
    const events: [string, HarnessEvent][] = [];
    const sandbox = new Sandbox({
      owner: `test-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: net,
      extraEnv: { ANTHROPIC_BASE_URL: double, ANTHROPIC_API_KEY: "sk-double" }, openaiBaseUrl: double,
    });
    await sandbox.sweep();
    const sessions = new Sessions(
      { server: "https://dispand.test", roots: [root], allowBypass: false },
      (sessionId, event) => events.push([sessionId, event]),
      {
        sandbox,
        claude: { claudePath: "claude", env: process.env },
        codex: { codexPath: "codex", env: process.env, version: "0.169.0" },
        claudeVersion: "2.1.326",
        resumeMap: join(base, harness, "sessions.json"),
      },
    );
    const keys = { allow: `${harness}-allow`, deny: `${harness}-deny` };
    const start = (key: string): SessionStart => ({
      sessionId: key, harness, cwd: { mode: "per-run", runKey: key }, systemPrompt: "", prompt: "List the runs and write the file.",
      ...(harness === "codex" ? { model: "gpt-double" } : {}),
      expectedOutputs: [], interactive: true, permissionMode: "default", skills: [], mcpServers: [],
    });
    await Promise.all(Object.values(keys).map((key) => sessions.handle({ type: "session.start", start: start(key) })));
    const question = (key: string) => events.find(([id, e]) => id === key && e.type === "question")?.[1] as Extract<HarnessEvent, { type: "question" }> | undefined;
    const failure = () => events.find(([, e]) => e.type === "error");
    await vi.waitFor(() => {
      expect(failure(), JSON.stringify(events)).toBeUndefined();
      expect(question(keys.allow), JSON.stringify(events)).toBeDefined();
      expect(question(keys.deny), JSON.stringify(events)).toBeDefined();
    }, { timeout: 120_000, interval: 500 });
    // Asked first: nothing written before the answer.
    for (const key of Object.values(keys)) {
      expect(question(key)!.payload).toMatchObject({ kind: "permission" });
      await expect(stat(join(root, "runs", key, "written.txt"))).rejects.toThrow();
    }
    await sessions.handle({ type: "session.answer", sessionId: keys.allow, questionId: question(keys.allow)!.questionId, answer: { kind: "permission", decision: "allow" } });
    await sessions.handle({ type: "session.answer", sessionId: keys.deny, questionId: question(keys.deny)!.questionId, answer: { kind: "permission", decision: "deny" } });
    await vi.waitFor(() => expect(Object.values(keys).every((key) => events.some(([id, e]) => id === key && e.type === "turn-end"))).toBe(true), { timeout: 120_000, interval: 500 });
    expect(await readFile(join(root, "runs", keys.allow, "written.txt"), "utf8")).toBe("hi\n");
    // Its workspace's parent shows only itself, while the other conversation's folder sits next to it.
    expect((await readFile(join(root, "runs", keys.allow, "seen.txt"), "utf8")).trim().split("\n")).toEqual([keys.allow]);
    await expect(stat(join(root, "runs", keys.deny, "written.txt"))).rejects.toThrow();
    for (const key of Object.values(keys)) await sessions.handle({ type: "session.stop", sessionId: key });
    await vi.waitFor(() => expect(Object.values(keys).every((key) => events.some(([id, e]) => id === key && e.type === "session-ended"))).toBe(true), { timeout: 60_000 });
    // Every worker is gone once its session has ended.
    const { stdout } = await docker("ps", "-aq", "--filter", "label=dispand.runner.worker");
    expect(stdout.trim()).toBe("");
  }, 300_000);
});
