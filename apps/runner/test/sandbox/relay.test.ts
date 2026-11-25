// A personal worker's only model transport is its grant's relay on the supervisor, and the
// relay serves only that grant, while Dispand says it holds. Real gVisor, in the supervisor
// image (CI's runner-sandbox job), like the worker's route in `egress.test.ts`.
import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type HarnessEvent, SESSION_NOT_RUNNING, type SessionStart } from "@dispand/runner-protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { selfContainer } from "../../src/sandbox/egress.ts";
import { Sandbox, type Worker } from "../../src/sandbox/worker.ts";
import { Sessions } from "../../src/sessions.ts";
import { GRANT_HEADER, GrantChecks, GrantRelay } from "../../src/subscriptions/relay.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);
/** The subscription's credential: it must never be readable in a worker. */
const CREDENTIAL = { authorization: "Bearer sub-SENTINEL-access", "chatgpt-account-id": "acct-SENTINEL" };
const SENTINELS = ["sub-SENTINEL-access", "acct-SENTINEL"];

const output = (child: ChildProcessWithoutNullStreams) =>
  new Promise<string>((done) => {
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    child.on("exit", () => done(out));
  });

/** Dispand's side of the checks: `answer` says what each one gets (undefined denies). */
function dispand(answer: () => number | undefined = () => 60_000) {
  const asked: string[] = [];
  const checks: GrantChecks = new GrantChecks((msg) => {
    asked.push(msg.grantId);
    const ttlMs = answer();
    queueMicrotask(() => checks.checked({ type: "grant.checked", askId: msg.askId, ...(ttlMs === undefined ? {} : { ttlMs }) }));
    return true;
  });
  return { checks, asked };
}

describe.skipIf(!RUNTIME || !process.env.DISPAND_SANDBOX_STATE)(`a personal worker's relay on ${RUNTIME}`, () => {
  const id = process.pid;
  const holdName = `dispand-relay-hold-${id}`;
  const modelName = `dispand-relay-model-${id}`;
  let state: SandboxState;
  let sandbox: Sandbox;
  let hold: string;
  let model: string;
  const workers: Worker[] = [];

  beforeAll(async () => {
    state = await sandboxState();
    // Provider stand-ins on the supervisor's own network: no worker reaches them but through the relay.
    const own = (await docker("inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}", await selfContainer())).stdout.trim().split("\n")[0]!;
    const address = async (name: string) => `http://${(await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${own}").IPAddress}}`, name)).stdout.trim()}:8080`;
    await docker("run", "-d", "--name", holdName, "--network", own, "--read-only", "-v", `${resolve("test/sandbox/egress-double.mjs")}:/double.mjs:ro`, IMAGE, "node", "/double.mjs");
    await docker("run", "-d", "--name", modelName, "--network", own, "--read-only", "-v", `${resolve("test/sandbox/model-double.mjs")}:/double.mjs:ro`, IMAGE, "node", "/double.mjs");
    hold = await address(holdName);
    model = await address(modelName);
    sandbox = new Sandbox({
      image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource,
      // The runner's own key too: a personal worker must get none of it.
      keys: { openai: "sk-runner-own-key", anthropic: "sk-runner-own-key" }, hostAddresses: (process.env.DISPAND_HOST_ADDRESSES ?? "").split(/[\s,]+/).filter(Boolean),
    });
    await sandbox.sweep();
  }, 120_000);
  afterAll(async () => {
    for (const w of workers) await w.remove().catch(() => undefined);
    await docker("rm", "-f", holdName, modelName).catch(() => undefined);
    await state.done();
  });

  const personal = async (key: string, relay: GrantRelay) => {
    await mkdir(join(state.base, "runs", key), { recursive: true });
    const worker = await sandbox.worker(join(state.base, "runs", key), join(state.base, "cli", key), [], { relay: relay.handle });
    workers.push(worker);
    return worker;
  };
  const relayFor = (grantId: string, checks: GrantChecks, o: { ttlMs?: number; upstream?: string } = {}) =>
    new GrantRelay({ grant: { id: grantId, enrollmentId: "enrollment-1", ttlMs: o.ttlMs ?? 60_000 }, harness: "codex", checks, credential: { read: async () => CREDENTIAL, renew: async () => undefined }, upstream: o.upstream ?? hold, tickMs: 100 });

  /** From inside a worker: each request to its relay (`relay <name> <status>`), then what else it can reach. */
  const PROBE = `
const net = require("node:net");
const { relay, tokens, double, header } = JSON.parse(process.argv[1]);
const post = (headers, method = "POST", path = "/responses") => fetch(relay + path, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }).then((r) => r.status, () => 0);
const reach = (host, port) => new Promise((done) => { const s = net.connect({ host, port, timeout: 3000 }); const end = (v) => { s.destroy(); done(v); }; s.once("connect", () => end("open")); s.once("timeout", () => end("closed")); s.once("error", () => end("closed")); });
(async () => {
  const u = new URL(relay);
  console.log("relay none " + (await post({})));
  for (const [name, token] of Object.entries(tokens)) console.log("relay " + name + " " + (await post({ [header]: token })));
  console.log("relay get " + (await post({ [header]: tokens.own }, "GET")));
  console.log("relay other-path " + (await post({ [header]: tokens.own }, "POST", "/v1/responses")));
  const connect = await new Promise((done) => { const s = net.connect(Number(u.port), u.hostname, () => s.write("CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n")); let a = ""; s.on("data", (d) => (a += d)); s.on("close", () => done(a.split("\\r\\n")[0] || "closed")); s.on("error", () => done("closed")); s.setTimeout(5000, () => s.destroy()); });
  console.log("connect " + connect);
  const d = new URL(double);
  console.log("direct " + (await reach(d.hostname, Number(d.port))));
  console.log("proxy " + (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "none"));
  console.log("keys " + Object.keys(process.env).filter((k) => /KEY|TOKEN|BASE_URL/.test(k)).join(","));
})();`;

  test("› a request without its grant, or with another worker's grant, is denied; no model route exists except the relay", async () => {
    const { checks, asked } = dispand();
    const a = relayFor("grant-a", checks);
    const b = relayFor("grant-b", checks);
    const worker = await personal("relay-a", a);
    await personal("relay-b", b);
    expect(worker.relayUrl).toBeDefined();
    expect(worker.openaiBaseUrl).toBeUndefined();
    const out = await output(worker.probe(["node", "-e", PROBE, JSON.stringify({ relay: worker.relayUrl, tokens: { other: b.token, own: a.token }, double: hold, header: GRANT_HEADER })]));
    expect(out, out).toContain("relay none 403");
    expect(out, out).toContain("relay other 403");
    expect(out, out).toContain("relay own 200");
    expect(out, out).toContain("relay get 403");
    expect(out, out).toContain("relay other-path 403");
    // No tunnel, no direct route, no proxy and none of the runner's keys.
    expect(out, out).not.toMatch(/connect HTTP\/1\.1 200/);
    expect(out, out).toContain("direct closed");
    expect(out, out).toContain("proxy none");
    expect(out, out).toMatch(/^keys $/m);
    // Only its own grant's request was checked, once.
    expect(asked).toEqual(["grant-a"]);
  }, 180_000);

  test("› a late request after the next grant is denied", async () => {
    const { checks } = dispand();
    const old = relayFor("grant-old", checks);
    const worker = await personal("late", old);
    const late = worker.probe(["node", "-e", `setTimeout(() => fetch(process.argv[1] + "/responses", { method: "POST", headers: { [process.argv[3]]: process.argv[2] }, body: "{}" }).then((r) => console.log("late " + r.status), () => console.log("late failed")), 3000)`, worker.relayUrl!, old.token, GRANT_HEADER]);
    const answer = output(late);
    // The next grant comes while the old worker still runs: the old one's is revoked first.
    old.revoke();
    relayFor("grant-next", checks);
    expect(await answer).toMatch(/late (403|failed)/);
  }, 120_000);

  const holdStream = async (key: string, relay: GrantRelay) => {
    const worker = await personal(key, relay);
    const child = worker.probe(["node", "-e", `fetch(process.argv[1] + "/responses", { method: "POST", headers: { [process.argv[3]]: process.argv[2], "x-test-hold": "1" }, body: "{}" }).then(async (r) => { for await (const _ of r.body) {} })`, worker.relayUrl!, relay.token, GRANT_HEADER]);
    child.stdout.resume();
    child.stderr.resume();
    const held = () => fetch(`${hold}/held`).then((r) => r.text());
    await vi.waitFor(async () => expect(await held()).toBe("open"), { timeout: 60_000, interval: 500 });
    return async () => vi.waitFor(async () => expect(await held()).toBe("closed"), { timeout: 30_000, interval: 500 });
  };

  test("› an active stream closes on revocation, on losing Dispand, and at the deadline", async () => {
    const revoked = relayFor("grant-revoked", dispand().checks);
    const closedOnRevoke = await holdStream("revoked", revoked);
    revoked.revoke();
    await closedOnRevoke();

    const lost = dispand();
    const closedOnLoss = await holdStream("lost", relayFor("grant-lost", lost.checks));
    lost.checks.lost();
    await closedOnLoss();

    // A short deadline that Dispand doesn't extend.
    let extend = true;
    const deadline = dispand(() => (extend ? 4000 : undefined));
    const closedAtDeadline = await holdStream("deadline", relayFor("grant-deadline", deadline.checks, { ttlMs: 4000 }));
    extend = false;
    await closedAtDeadline();
  }, 240_000);

  /** A supervisor's sessions with personal mode on, as the runner runs them under gVisor. */
  const supervisor = (key: string, harness: SessionStart["harness"] = "codex") => {
    const events: [string, HarnessEvent][] = [];
    const { checks, asked } = dispand();
    const sessions = new Sessions(
      { server: "https://dispand.test", roots: [join(state.base, key, "root")], allowBypass: true },
      (sessionId, event) => events.push([sessionId, event]),
      {
        sandbox, claude: { claudePath: "claude", env: process.env }, codex: { codexPath: "codex", env: process.env, version: "0.169.0" }, claudeVersion: "2.1.326", resumeMap: join(state.base, key, "sessions.json"),
        personal: { checks, credential: (_harness, enrollmentId) => (enrollmentId === "enrollment-1" ? { read: async () => CREDENTIAL, renew: async () => undefined } : undefined), upstream: model },
      },
    );
    const start = (sessionId: string, runKey: string, grantId: string, resumeCliSessionId?: string): SessionStart => ({
      sessionId, harness, ...(harness === "codex" ? { model: "gpt-double" } : {}), cwd: { mode: "per-run", runKey }, systemPrompt: "", prompt: "HEARTBEAT", expectedOutputs: [], interactive: true,
      permissionMode: "bypassPermissions", skills: [], mcpServers: [], grant: { id: grantId, enrollmentId: "enrollment-1", ttlMs: 60_000 },
      ...(resumeCliSessionId ? { resumeCliSessionId } : {}),
    });
    const run = (runKey: string) => join(state.base, key, "root", "runs", runKey);
    const turnEnded = (sessionId: string) => vi.waitFor(() => {
      expect(events.find(([s, e]) => s === sessionId && e.type === "error"), JSON.stringify(events)).toBeUndefined();
      expect(events.some(([s, e]) => s === sessionId && e.type === "turn-end"), JSON.stringify(events)).toBe(true);
    }, { timeout: 120_000, interval: 500 });
    return { sessions, events, asked, start, run, turnEnded };
  };
  const beats = (dir: string) => stat(join(dir, "heartbeat")).then((s) => s.mtimeMs, () => 0);
  const beating = async (dir: string) => {
    const before = await beats(dir);
    await new Promise((r) => setTimeout(r, 2500));
    return (await beats(dir)) > before;
  };
  const workersLeft = async () => (await docker("ps", "-aq", "--filter", "label=dispand.runner.worker", "--filter", "name=dispand-worker-")).stdout.trim().split("\n").filter(Boolean);

  test.each(["codex", "claude-code"] as const)("› %s: revocation stops the worker and a running tool child with no new grant; nothing in the worker can read a credential", async (harness) => {
    const { sessions, events, asked, start, run, turnEnded } = supervisor(`revoke-${harness}`, harness);
    const logged = (await docker("logs", modelName)).stdout.length;
    const before = new Set(await workersLeft());
    await sessions.handle({ type: "session.start", start: start("s1", "r1", "grant-1") });
    await turnEnded("s1");
    // Its model requests went through the relay, each checked under its grant.
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["grant-1"]));
    await vi.waitFor(async () => expect(await beating(run("r1"))).toBe(true), { timeout: 30_000 });
    const mine = (await workersLeft()).filter((w) => !before.has(w));
    expect(mine).toHaveLength(1);
    // What every process in the worker held, its container's settings, and its retained storage.
    const seen = await readFile(join(run("r1"), "seen-env.txt"), "utf8");
    const inspected = (await docker("inspect", mine[0]!)).stdout;
    const cli = join(state.base, `revoke-${harness}`, "root", "cli", "r1");
    const files = await readdir(cli, { recursive: true });
    const retained = (await Promise.all(files.map((f) => readFile(join(cli, f), "utf8").catch(() => "")))).join("\n");
    for (const secret of [...SENTINELS, "sk-runner-own-key"]) {
      expect(seen).not.toContain(secret);
      expect(inspected).not.toContain(secret);
      expect(retained).not.toContain(secret);
    }
    // No grant in retained storage: its id only lives in the supervisor's memory.
    expect(retained).not.toContain("grant-1");
    // Only the model operation reached the provider: Claude Code's hello and the like were refused, and its turn still ended.
    const reached = (await docker("logs", modelName)).stdout.slice(logged).split("\n").filter((line) => /^[A-Z]+ \//.test(line));
    expect(reached.length).toBeGreaterThan(0);
    for (const line of reached) expect(line).toMatch(harness === "codex" ? /^POST \/responses/ : /^POST \/v1\/messages(\?|$)/);

    sessions.endGrant("grant-1");
    await vi.waitFor(() => expect(events.some(([s, e]) => s === "s1" && e.type === "session-ended")).toBe(true), { timeout: 60_000, interval: 500 });
    // Between turns, a grant's end retires the worker: no error, so Dispand doesn't fail the action.
    expect(events.filter(([s, e]) => s === "s1" && e.type === "error")).toEqual([]);
    expect(await workersLeft()).not.toContain(mine[0]);
    expect(await beating(run("r1"))).toBe(false);
  }, 300_000);

  test("› the next grant waits for confirmed teardown, including a long-lived tool child", async () => {
    const { sessions, events, start, run, turnEnded } = supervisor("next");
    const before = new Set(await workersLeft());
    await sessions.handle({ type: "session.start", start: start("s1", "r1", "grant-1") });
    await turnEnded("s1");
    await vi.waitFor(async () => expect(await beating(run("r1"))).toBe(true), { timeout: 30_000 });
    const first = (await workersLeft()).filter((w) => !before.has(w));
    // When the next grant's worker is asked for, the previous one and its child must already be gone.
    let atNext: { left: string[]; beating: boolean } | undefined;
    const worker = sandbox.worker.bind(sandbox);
    sandbox.worker = async (...args) => {
      atNext ??= { left: await workersLeft(), beating: await beating(run("r1")) };
      return worker(...args);
    };
    try {
      // The next action of the same conversation, as Dispand resumes it: the turn's grant ends, and the same
      // session starts at once on its next grant, without waiting. Only its workspace and transcript carry over.
      const cli = events.find(([s, e]) => s === "s1" && e.type === "cli-session")![1] as Extract<HarnessEvent, { type: "cli-session" }>;
      const mark = events.length;
      sessions.endGrant("grant-1");
      await sessions.handle({ type: "session.start", start: start("s1", "r1", "grant-2", cli.cliSessionId) });
      await vi.waitFor(() => {
        const later = events.slice(mark).filter(([s]) => s === "s1").map(([, e]) => e);
        expect(later.filter((e) => e.type === "error"), JSON.stringify(later)).toEqual([]);
        expect(later.some((e) => e.type === "turn-end"), JSON.stringify(later)).toBe(true);
      }, { timeout: 120_000, interval: 500 });
    } finally {
      sandbox.worker = worker;
    }
    expect(first).toHaveLength(1);
    expect(atNext!.left).not.toContain(first[0]);
    expect(atNext!.beating).toBe(false);
    // The resumed worker started a child of its own, which its grant's end stops too.
    await vi.waitFor(async () => expect(await beating(run("r1"))).toBe(true), { timeout: 30_000 });
    sessions.endGrant("grant-2");
    await vi.waitFor(async () => expect(await beating(run("r1"))).toBe(false), { timeout: 60_000 });
  }, 300_000);
  test("› a pending request whose worker is gone: the runner delivers its answer nowhere, nor into a replacement", async () => {
    const { sessions, events, start, run, turnEnded } = supervisor("pending");
    // The command waits for an approval nobody has given yet.
    await sessions.handle({ type: "session.start", start: { ...start("s1", "r1", "grant-1"), prompt: "List and write", permissionMode: "default" } });
    await vi.waitFor(() => expect(events.some(([s, e]) => s === "s1" && e.type === "question"), JSON.stringify(events)).toBe(true), { timeout: 120_000, interval: 500 });
    const question = events.find(([s, e]) => s === "s1" && e.type === "question")![1] as Extract<HarnessEvent, { type: "question" }>;
    const cli = events.find(([s, e]) => s === "s1" && e.type === "cli-session")![1] as Extract<HarnessEvent, { type: "cli-session" }>;
    // Its grant ends: the worker goes with the pending request in it.
    sessions.endGrant("grant-1");
    await vi.waitFor(() => expect(events.some(([s, e]) => s === "s1" && e.type === "session-ended")).toBe(true), { timeout: 60_000, interval: 500 });
    const allow = { kind: "permission" as const, decision: "allow" as const };
    // The answer that arrives now reaches no worker: the runner says the session isn't running, and Dispand pauses the action (`engine.ts` resume).
    await sessions.handle({ type: "session.answer", sessionId: "s1", questionId: question.questionId, answer: allow });
    expect(events).toContainEqual(["s1", SESSION_NOT_RUNNING]);
    // The replacement, on the conversation's next grant with its transcript restored, gets neither the request nor its answer.
    await sessions.handle({ type: "session.start", start: { ...start("s2", "r1", "grant-2", cli.cliSessionId), prompt: "RECALL", permissionMode: "default" } });
    await turnEnded("s2");
    await sessions.handle({ type: "session.answer", sessionId: "s2", questionId: question.questionId, answer: allow });
    await new Promise((r) => setTimeout(r, 5000));
    expect(events.filter(([s, e]) => s === "s2" && e.type === "question")).toEqual([]);
    await expect(access(join(run("r1"), "written.txt"))).rejects.toThrow();
    sessions.endGrant("grant-2");
    await vi.waitFor(() => expect(events.some(([s, e]) => s === "s2" && e.type === "session-ended")).toBe(true), { timeout: 60_000, interval: 500 });
  }, 300_000);
});
