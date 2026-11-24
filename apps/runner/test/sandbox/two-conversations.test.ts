// Two conversations at once, each in its own worker, through the runner's own session adapters
// and the model doubles (`model-double.mjs`): each sees only its own workspace, and a shell write
// asks first and honors the answer. Real gVisor in CI (DISPAND_SANDBOX_RUNTIME=runsc).
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { HarnessEvent, SessionStart } from "@dispand/runner-protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Sandbox } from "../../src/sandbox/worker.ts";
import { Sessions } from "../../src/sessions.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);

describe.skipIf(!RUNTIME)(`two conversations on ${RUNTIME}`, () => {
  const net = `dispand-double-${process.pid}`;
  let base: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "two-")));
    // Internal: the workers and the double reach each other and nothing else.
    await docker("network", "create", "--internal", net);
    await docker("run", "-d", "--name", net, "--network", net, "--network-alias", "double", "--read-only",
      "-v", `${resolve("test/sandbox/model-double.mjs")}:/double.mjs:ro`, IMAGE, "node", "/double.mjs");
  });
  afterAll(async () => {
    await docker("logs", net).then(({ stdout }) => console.log(stdout)).catch(() => undefined);
    await docker("rm", "-f", net).catch(() => undefined);
    await docker("network", "rm", net).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  });

  test.each(["claude-code", "codex"] as const)("%s: each sees only its own workspace, and a shell write waits for its answer", async (harness) => {
    const root = join(base, harness, "root");
    const events: [string, HarnessEvent][] = [];
    const sandbox = new Sandbox({
      image: IMAGE, runtime: RUNTIME!, stateDir: base, stateSource: base, network: net,
      extraEnv: { ANTHROPIC_BASE_URL: "http://double:8080", ANTHROPIC_API_KEY: "sk-double" },
    });
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
    for (const key of Object.values(keys)) {
      // Codex's provider is the double: written where the worker's CODEX_HOME will be.
      await mkdir(join(root, "cli", key, "codex"), { recursive: true });
      await writeFile(join(root, "cli", key, "codex", "config.toml"), 'model = "gpt-double"\nmodel_provider = "double"\n[model_providers.double]\nname = "double"\nbase_url = "http://double:8080/v1"\nwire_api = "responses"\n');
    }
    const start = (key: string): SessionStart => ({
      sessionId: key, harness, cwd: { mode: "per-run", runKey: key }, systemPrompt: "", prompt: "List the runs and write the file.",
      expectedOutputs: [], interactive: true, permissionMode: "default", skills: [], mcpServers: [],
    });
    await Promise.all(Object.values(keys).map((key) => sessions.handle({ type: "session.start", start: start(key) })));
    const question = (key: string) => events.find(([id, e]) => id === key && e.type === "question")?.[1] as Extract<HarnessEvent, { type: "question" }> | undefined;
    const failure = () => events.find(([, e]) => e.type === "error");
    await vi.waitFor(() => {
      expect(failure()).toBeUndefined();
      expect(question(keys.allow)).toBeDefined();
      expect(question(keys.deny)).toBeDefined();
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
