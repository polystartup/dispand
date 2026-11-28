import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@dispand/runner-protocol";
import { afterEach, expect, test, vi } from "vitest";
import { fakeCodex } from "../fixtures/fake-codex-bin.ts";
import type { Launch } from "../sandbox/worker.ts";
import { GRANT_HEADER, GrantChecks, GrantRelay } from "../subscriptions/relay.ts";
import { identityDigest, RENEWAL_ATTEMPTS, subscriptionsDir, Subscriptions } from "../subscriptions/supervisor.ts";
import { codexConfig } from "./config.ts";
import { CodexSubscription } from "./personal.ts";
import { type CodexSessionStart, startCodexSession } from "./session.ts";

const waitFor = <T>(callback: () => T | Promise<T>) => vi.waitFor(callback, { timeout: 20_000 });

const made: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const OLD = "tok-SENTINEL-before";
const NEW = "tok-SENTINEL-after";
const RELAY = { url: "http://relay.example.test", grant: "grant-token" };
const CHATGPT = JSON.stringify({
  account: { type: "chatgpt", email: "someone@example.test", planType: "plus", workspaceName: null },
  requiresOpenaiAuth: true,
  workspaceRouting: null,
});
const auth = (token: string) => JSON.stringify({ authMethod: "chatgpt", authToken: token, requiresOpenaiAuth: true });
const signedInAs = (userId: string, accountId: string) =>
  JSON.stringify({
    activeSessionId: "s1",
    sessions: [
      {
        sessionId: "s1",
        email: "someone@example.test",
        userId,
        displayName: null,
        imageUrl: null,
        lastUsedAt: 1,
        isActive: true,
        selectedWorkspaceAccountId: accountId,
        workspaces: [],
      },
    ],
  });

/** The supervisor's Codex login, signed in as `user-1` / `acct-1` and enrolled as such, on a fake `codex`. */
async function supervisor(env: Record<string, string> = {}) {
  const configDir = await mkdtemp(join(tmpdir(), "personal-"));
  made.push(configDir);
  const home = join(subscriptionsDir(configDir), "codex");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "auth.json"), "{}");
  const sessionsFile = join(configDir, "sessions.json");
  const authFile = join(configDir, "auth-status.json");
  await writeFile(sessionsFile, signedInAs("user-1", "acct-1"));
  await writeFile(authFile, auth(OLD));
  // A renewal rotates the token, as Codex's does; a test that wants it to stay passes FAKE_CODEX_AUTH_RENEWED: auth(OLD).
  const codex = await fakeCodex(made, {
    FAKE_CODEX_ACCOUNT: CHATGPT,
    FAKE_CODEX_SESSIONS: sessionsFile,
    FAKE_CODEX_AUTH: authFile,
    FAKE_CODEX_AUTH_RENEWED: auth(NEW),
    ...env,
  });
  const subscriptions = new Subscriptions({ configDir, codexPath: () => codex.path, env: codex.env });
  const onSignInNeeded = vi.fn();
  const credential = new CodexSubscription({
    subscriptions,
    configDir,
    codexPath: () => codex.path,
    env: codex.env,
    identity: identityDigest("user-1", "acct-1"),
    onSignInNeeded,
  });
  const refreshes = async () =>
    (await codex.received()).filter((m) => m.method === "account/read" && (m.params as { refreshToken?: boolean }).refreshToken).length;
  return { home, sessionsFile, authFile, subscriptions, credential, onSignInNeeded, refreshes, received: codex.received };
}

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** A personal worker's model requests through its grant's relay, on `credential`, to a provider that accepts only `accepted`. */
async function relayed(credential: CodexSubscription, accepted: string) {
  const seen: string[] = [];
  const upstream = await listen((req, res) => {
    seen.push(req.headers.authorization ?? "");
    req.resume();
    res.writeHead(req.headers.authorization === `Bearer ${accepted}` ? 200 : 401).end();
  });
  const checks: GrantChecks = new GrantChecks((msg) => {
    queueMicrotask(() => checks.checked({ type: "grant.checked", askId: msg.askId, ttlMs: 60_000 }));
    return true;
  });
  const relay = new GrantRelay({ grant: { id: "grt_1", enrollmentId: "enr_1", ttlMs: 60_000 }, harness: "codex", checks, credential, upstream, tickMs: 20 });
  const url = await listen(relay.handle);
  // The relay renews after passing the 401 on; the next request's read waits for that renewal.
  const send = () => fetch(`${url}/responses`, { method: "POST", headers: { [GRANT_HEADER]: relay.token }, body: "{}" }).then((r) => r.status);
  return { seen, send, end: () => relay.revoke() };
}

const start: CodexSessionStart = {
  sessionId: "ses_1",
  harness: "codex",
  cwd: { mode: "per-run", runKey: "run_1" },
  systemPrompt: "",
  prompt: "Hi",
  expectedOutputs: [],
  interactive: false,
  permissionMode: "default",
  skills: [],
  mcpServers: [],
};
const GRANT = { id: "grt_1", enrollmentId: "enr_1", ttlMs: 60_000 };

/** A personal worker's Codex session on a fake `codex`, whose turn asks the runner for a ChatGPT token; its launch records what the worker gets. */
async function worker(grant: boolean) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "personal-worker-")));
  made.push(cwd);
  const codex = await fakeCodex(made, {
    FAKE_CODEX_TURNS: JSON.stringify([[{ request: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: null } }]]),
  });
  const envs: NodeJS.ProcessEnv[] = [];
  const launch: Launch = (command, args, o) => {
    envs.push(o.env);
    return spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
  };
  const events: HarnessEvent[] = [];
  const session = startCodexSession({ ...start, ...(grant ? { grant: GRANT } : {}) }, cwd, (e) => events.push(e), {
    codexPath: codex.path,
    env: codex.env,
    secrets: [],
    launch,
    ...(grant ? { subscriptionRelay: RELAY } : {}),
  });
  await waitFor(() => expect(events.some((e) => e.type === "result" || e.type === "error")).toBe(true));
  await session.done;
  return { envs, received: await codex.received() };
}

test.each([true, false])("the refresh RPC is refused (personal grant: %s)", async (grant) => {
  const { received } = await worker(grant);
  // The runner answers Codex's token request with an error, never a token.
  expect(received.find((m) => m.id === "r0" && m.method === undefined)).toMatchObject({ error: { code: expect.any(Number) } });
  expect(received.find((m) => m.id === "r0" && m.method === undefined)).not.toHaveProperty("result");
});

test("a personal worker's config holds no credential, only the relay", async () => {
  const { envs, received } = await worker(true);
  const config = (received.find((m) => m.method === "thread/start")!.params as { config: Record<string, unknown> }).config;
  expect(config.model_provider).toBe("subscription");
  expect(config.model_providers).toEqual({
    subscription: { name: "Personal subscription", base_url: RELAY.url, wire_api: "responses", http_headers: { "x-dispand-grant": RELAY.grant } },
  });
  expect(envs).not.toHaveLength(0);
  expect(() => codexConfig({ denied: [], bypass: false, modelBaseUrl: "http://x", subscriptionRelay: RELAY })).toThrow();
  // Without its worker or its relay, a personal session never starts.
  expect(() => startCodexSession({ ...start, grant: GRANT }, "/tmp", () => {}, { codexPath: "codex", secrets: [], subscriptionRelay: RELAY })).toThrow();
  expect(() =>
    startCodexSession({ ...start, grant: GRANT }, "/tmp", () => {}, {
      codexPath: "codex",
      secrets: [],
      launch: () => {
        throw new Error("unused");
      },
    }),
  ).toThrow();
});

test("a renewal in the supervisor serves the next read, and no token reaches the worker", async () => {
  const s = await supervisor();
  const before = await s.credential.read();
  expect(before).toEqual({ authorization: `Bearer ${OLD}`, "chatgpt-account-id": "acct-1" });
  // The provider refused it: the supervisor renews in its own store, which then holds a new token.
  expect(await s.credential.renew(before!)).toEqual({ authorization: `Bearer ${NEW}`, "chatgpt-account-id": "acct-1" });
  expect(await s.credential.read()).toMatchObject({ authorization: `Bearer ${NEW}` });
  expect(await s.refreshes()).toBe(1);
  // Only the supervisor's app-server was asked for a token; a personal worker gets none.
  const { envs, received } = await worker(true);
  const seen = JSON.stringify([envs, received]);
  for (const secret of [OLD, NEW, "acct-1"]) expect(seen).not.toContain(secret);
  expect(s.onSignInNeeded).not.toHaveBeenCalled();
});

test.each([
  ["user", "user-2", "acct-1"],
  ["account", "user-1", "acct-2"],
])("a renewal that changes the provider %s is refused", async (_, user, account) => {
  const s = await supervisor();
  const before = await s.credential.read();
  await writeFile(s.sessionsFile, signedInAs(user, account));
  await writeFile(s.authFile, auth(NEW));
  expect(await s.credential.renew(before!)).toBeUndefined();
  expect(await s.credential.read()).toBeUndefined();
  expect(s.onSignInNeeded).toHaveBeenCalledTimes(1);
  // Signed in as the enrolled identity again: the same source serves it.
  await writeFile(s.sessionsFile, signedInAs("user-1", "acct-1"));
  expect(await s.credential.read()).toEqual({ authorization: `Bearer ${NEW}`, "chatgpt-account-id": "acct-1" });
});

test.each([
  ["fails", { FAKE_CODEX_REFRESH: "fail" }],
  ["leaves the refused token in place", { FAKE_CODEX_AUTH_RENEWED: auth(OLD) }],
])("a renewal that %s asks for one sign-in once renewal gives up, and a fresh sign-in serves again", async (_, env) => {
  const s = await supervisor(env);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const r = await relayed(s.credential, NEW);
  // The CLI resends its request after each refusal: each one is sent with the login's token, then renewed.
  for (let i = 0; i < RENEWAL_ATTEMPTS; i++) {
    expect(await r.send()).toBe(401);
    await waitFor(async () => expect(await s.refreshes()).toBe(i + 1));
  }
  await waitFor(() => expect(s.onSignInNeeded).toHaveBeenCalledTimes(1));
  expect(await s.subscriptions.status()).toEqual([expect.objectContaining({ harness: "codex", signInNeeded: true })]);
  // Renewal gave up: nothing more reaches the provider, and nothing more is renewed.
  for (let i = 0; i < 3; i++) expect(await r.send()).toBe(403);
  expect(r.seen).toEqual(Array.from({ length: RENEWAL_ATTEMPTS }, () => `Bearer ${OLD}`));
  expect(await s.refreshes()).toBe(RENEWAL_ATTEMPTS);
  expect(s.onSignInNeeded).toHaveBeenCalledTimes(1);
  // A fresh sign-in as the same account rewrites the login: the same source serves it, with no restart.
  await writeFile(join(s.home, "auth.json"), JSON.stringify({ signedIn: "again" }));
  await writeFile(s.authFile, auth(NEW));
  expect(await r.send()).toBe(200);
  expect(r.seen.at(-1)).toBe(`Bearer ${NEW}`);
  expect(await s.subscriptions.status()).toEqual([expect.objectContaining({ harness: "codex", signInNeeded: false })]);
  r.end();
});

test("reads and renewals of the store never overlap", async () => {
  const s = await supervisor();
  const before = await s.credential.read();
  await Promise.all([s.credential.read(), s.credential.renew(before!), s.credential.read(), s.credential.read()]);
  // One app-server at a time: each one's handshake comes after the previous one's last request.
  const methods = (await s.received()).map((m) => m.method).filter((m) => m === "initialize" || m === "accountSession/list" || m === "account/read");
  const servers = methods
    .join(" ")
    .split("initialize")
    .slice(1)
    .map((x) => x.trim());
  expect(servers).toEqual([
    "accountSession/list",
    "accountSession/list",
    "accountSession/list",
    "account/read",
    "accountSession/list",
    "accountSession/list",
    "accountSession/list",
  ]);
});

test("requests refused with the same token share one renewal", async () => {
  const s = await supervisor();
  const before = await s.credential.read();
  const renewed = await Promise.all([s.credential.renew(before!), s.credential.renew(before!)]);
  expect(renewed).toEqual([expect.objectContaining({ authorization: `Bearer ${NEW}` }), expect.objectContaining({ authorization: `Bearer ${NEW}` })]);
  // The second finds the token the first renewal put in the store.
  expect(await s.refreshes()).toBe(1);
});
