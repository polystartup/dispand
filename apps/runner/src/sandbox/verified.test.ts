import { ClaudePermissionMode, CodexPermissionMode, type SessionStart } from "@dispand/runner-protocol";
import { expect, test } from "vitest";
import { type Runtime, unverified, VERIFIED } from "./verified.ts";

const HARNESSES = { "claude-code": ClaudePermissionMode.options, codex: CodexPermissionMode.options } as const;

test("verified › every runtime × harness × permission mode × restricted is classified, as the spec found them", () => {
  for (const runtime of ["runsc", "runc"] as Runtime[]) {
    for (const [harness, modes] of Object.entries(HARNESSES) as [keyof typeof HARNESSES, readonly string[]][]) {
      // Every mode of the protocol is in the table, and nothing else: a new mode fails here until listed.
      expect(Object.keys(VERIFIED[runtime][harness]).sort()).toEqual([...modes].sort());
      for (const permissionMode of modes) {
        for (const restricted of [false, true]) {
          const start = { harness, permissionMode, ...(restricted ? { restricted: true } : {}) } as SessionStart;
          // gVisor runs everything; runc runs Claude Code and restricted Jobs, not an ordinary Codex session.
          const expected = runtime === "runsc" || harness === "claude-code" || restricted;
          expect(unverified(runtime, start) === undefined, `${runtime} ${harness} ${permissionMode} restricted=${restricted}`).toBe(expected);
        }
      }
    }
  }
});

test("› a refused Codex chat on runc starts no worker and isn't retried with bypass", async () => {
  const { vi } = await import("vitest");
  const { Sessions } = await import("../sessions.ts");
  const events: { type: string }[] = [];
  const worker = vi.fn();
  const sessions = new Sessions(
    { server: "https://dispand.test", roots: ["/nonexistent-root"], allowBypass: true },
    (_id, event) => events.push(event),
    { sandbox: { runtime: "runc", worker } as never, codex: { codexPath: "codex", version: "0.169.0" }, claudeVersion: "2.1.326", resumeMap: "/nonexistent-root/s.json" },
  );
  const start = { sessionId: "s", harness: "codex" as const, cwd: { mode: "per-run" as const, runKey: "k" }, systemPrompt: "", prompt: "hi", expectedOutputs: [], interactive: true, permissionMode: "default" as const, skills: [], mcpServers: [] };
  await sessions.handle({ type: "session.start", start });
  expect(worker).not.toHaveBeenCalled();
  expect(events).toEqual([expect.objectContaining({ type: "error", message: expect.stringContaining("no gVisor") })]);
});

test("› a run already starting or live on this runner isn't attached to a second worker", async () => {
  const { vi } = await import("vitest");
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Sessions } = await import("../sessions.ts");
  const base = await realpath(await mkdtemp(join(tmpdir(), "run-")));
  try {
    const events: [string, { type: string; message?: string }][] = [];
    // The first session's worker never comes: it stays starting.
    const worker = vi.fn(() => new Promise(() => {}));
    const sessions = new Sessions(
      { server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false },
      (id, event) => events.push([id, event]),
      { sandbox: { runtime: "runsc", worker } as never, claude: {}, claudeVersion: "2.1.326", resumeMap: join(base, "s.json") },
    );
    const start = (sessionId: string) => ({ sessionId, harness: "claude-code" as const, cwd: { mode: "per-run" as const, runKey: "shared" }, systemPrompt: "", prompt: "hi", expectedOutputs: [], interactive: true, permissionMode: "default" as const, skills: [], mcpServers: [] });
    void sessions.handle({ type: "session.start", start: start("a") });
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));
    await sessions.handle({ type: "session.start", start: start("b") });
    expect(worker).toHaveBeenCalledTimes(1);
    expect(events).toEqual([["b", expect.objectContaining({ type: "error", message: expect.stringContaining("still running") })]]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
