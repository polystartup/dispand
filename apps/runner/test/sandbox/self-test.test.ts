// The start-up self-test, on a real host: it passes where the sandbox contract holds, and fails,
// naming the check, where it doesn't. A launch whose runtime vanished fails, never downgraded.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessEvent } from "@dispand/runner-protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Sandbox } from "../../src/sandbox/worker.ts";
import { Sessions } from "../../src/sessions.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const hosts = (process.env.DISPAND_HOST_ADDRESSES ?? "").split(/[\s,]+/).filter(Boolean);

describe.skipIf(!RUNTIME || !process.env.DISPAND_SANDBOX_STATE)(`self-test on ${RUNTIME}`, () => {
  let state: SandboxState;
  beforeAll(async () => {
    state = await sandboxState();
  });
  afterAll(() => state.done());

  const run = async (sandbox: Sandbox, key: string) => {
    await sandbox.sweep();
    await mkdir(join(state.base, "runs", key), { recursive: true });
    return sandbox.selfTest(join(state.base, "runs", key), join(state.base, "cli", key), join(state.base, "config.json"));
  };

  test("passes where every worker gets the sandbox contract", async () => {
    await writeFile(join(state.base, "config.json"), "{}");
    const sandbox = new Sandbox({ owner: `test-self-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, hostAddresses: hosts });
    expect(await run(sandbox, "pass")).toEqual([]);
  }, 120_000);

  test("› a host that doesn't isolate the worker's network fails the self-test, naming the check", async () => {
    // As on a host whose workers share an ordinary network: no route through the supervisor.
    const sandbox = new Sandbox({ owner: `test-self-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, hostAddresses: hosts, network: "bridge" });
    expect(await run(sandbox, "open")).toContain("metadata-refused-by-the-route");
  }, 120_000);

  test("› a start whose runsc vanished fails without a runc or bypass retry", async () => {
    // A docker client for which runsc is gone: every `run` names it, and each call is recorded.
    const calls = join(state.base, "docker-calls");
    const docker = join(state.base, "docker-without-runsc");
    await writeFile(docker, `#!/bin/sh\nfor a in "$@"; do [ "$a" = run ] && echo "$*" >> "${calls}"; done\nfor a in "$@"; do shift; [ "$a" = runsc ] && a=runsc-vanished; set -- "$@" "$a"; done\nexec docker "$@"\n`);
    await chmod(docker, 0o755);
    const sandbox = new Sandbox({ owner: `test-self-${process.pid}`, image: IMAGE, runtime: "runsc", stateDir: state.stateDir, stateSource: state.stateSource, network: "none", docker });
    await sandbox.sweep();
    const events: HarnessEvent[] = [];
    const sessions = new Sessions(
      { server: "https://dispand.test", roots: [join(state.base, "vanished")], allowBypass: true },
      (_id, event) => events.push(event),
      { sandbox, claude: { claudePath: "claude", env: process.env }, claudeVersion: "2.1.326", resumeMap: join(state.base, "vanished.json") },
    );
    await sessions.handle({ type: "session.start", start: { sessionId: "s", harness: "claude-code", cwd: { mode: "per-run", runKey: "k" }, systemPrompt: "", prompt: "hi", expectedOutputs: [], interactive: false, permissionMode: "default", skills: [], mcpServers: [] } });
    await vi.waitFor(() => expect(events.some((e) => e.type === "error")).toBe(true), { timeout: 60_000, interval: 500 });
    const runs = (await readFile(calls, "utf8")).trim().split("\n");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--runtime runsc");
    expect(runs[0]).not.toContain("bypass");
  }, 120_000);
});
