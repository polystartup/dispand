import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, SessionStart } from "@dispand/runner-protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { Sandbox, Worker } from "./sandbox/worker.ts";
import { GRANT_ENDED, Sessions, type SessionsOptions } from "./sessions.ts";
import { GrantChecks } from "./subscriptions/relay.ts";

// A personal start's refusals and its grant's end before launch, on a stand-in sandbox. Its worker,
// relay and teardown on real gVisor: `test/sandbox/relay.test.ts`.
const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const credential = { read: async () => ({ authorization: "Bearer x" }), renew: async () => undefined };

async function setup(o: { runtime?: string; personal?: boolean; worker?: () => Promise<void> } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "grants-")));
  made.push(base);
  const events: [string, HarnessEvent][] = [];
  const launched = vi.fn();
  const removed = vi.fn(async () => undefined);
  const sandbox = {
    runtime: o.runtime ?? "runsc",
    worker: async (_ws: string, _cli: string, _ro: string[], opts: { relay?: unknown }) => {
      expect(opts.relay).toBeTypeOf("function");
      await o.worker?.();
      return { claudeConfigDir: "/c", codexHome: "/x", relayUrl: "http://relay", launch: launched, probe: launched, command: launched, remove: removed } as unknown as Worker;
    },
  } as unknown as Sandbox;
  const personal: SessionsOptions["personal"] = { checks: new GrantChecks(() => false), credential: (_h, id) => (id === "enrollment-1" ? credential : undefined) };
  const sessions = new Sessions({ server: "https://dispand.test", roots: [join(base, "root")], allowBypass: false }, (id, e) => events.push([id, e]), {
    sandbox, codex: { codexPath: "codex", env: {}, version: "0.169.0" }, claudeVersion: "2.1.326", resumeMap: join(base, "sessions.json"),
    ...(o.personal === false ? {} : { personal }),
  });
  return { sessions, events, launched, removed };
}

const start = (grant: SessionStart["grant"], harness: SessionStart["harness"] = "codex"): SessionStart => ({
  sessionId: "s1", harness, cwd: { mode: "per-run", runKey: "r1" }, systemPrompt: "", prompt: "hi", expectedOutputs: [], interactive: true,
  permissionMode: "default", skills: [], mcpServers: [], ...(harness === "codex" ? { model: "m" } : {}), ...(grant ? { grant } : {}),
});
const GRANT = { id: "grant-1", enrollmentId: "enrollment-1", ttlMs: 60_000 };
const errors = (events: [string, HarnessEvent][]) => events.flatMap(([, e]) => (e.type === "error" ? [e.message] : []));

test.each([
  ["no personal mode", { personal: false }, start(GRANT)],
  ["runc", { runtime: "runc" }, start(GRANT)],
  ["a CLI with no relay yet", {}, start(GRANT, "claude-code")],
  ["an enrollment this runner doesn't hold", {}, start({ ...GRANT, enrollmentId: "enrollment-2" })],
])("a grant is refused with %s, before any worker", async (_name, options, s) => {
  const { sessions, events, launched } = await setup(options);
  await sessions.handle({ type: "session.start", start: s });
  expect(errors(events)).toHaveLength(1);
  expect(launched).not.toHaveBeenCalled();
});

test("a grant that ends before its relay is reserved never launches", async () => {
  const { sessions, events, launched } = await setup();
  const started = sessions.handle({ type: "session.start", start: start(GRANT) });
  sessions.endGrant("grant-1");
  await started;
  expect(errors(events)).toEqual([GRANT_ENDED]);
  expect(launched).not.toHaveBeenCalled();
});

test("a grant that ends while its worker is set up never launches, and an ended grant never starts again", async () => {
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  const held: { sessions?: Sessions } = {};
  const setupDone = await setup({ worker: async () => { held.sessions!.endGrant("grant-1"); await ready; } });
  const sessions = (held.sessions = setupDone.sessions);
  const started = sessions.handle({ type: "session.start", start: start(GRANT) });
  release();
  await started;
  expect(errors(setupDone.events)).toEqual([GRANT_ENDED]);
  expect(setupDone.launched).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(setupDone.removed).toHaveBeenCalled());
  await sessions.handle({ type: "session.start", start: { ...start(GRANT), sessionId: "s2" } });
  expect(errors(setupDone.events)).toEqual([GRANT_ENDED, GRANT_ENDED]);
});
