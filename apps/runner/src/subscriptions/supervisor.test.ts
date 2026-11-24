import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { fakeCodex } from "../fixtures/fake-codex-bin.ts";
import { Sandbox } from "../sandbox/worker.ts";
import { overlapping } from "../config.ts";
import { askControl, controlSocket, serveControl } from "./control.ts";
import { identityDigest, RENEWAL_ATTEMPTS, subscriptionLogins, subscriptionsDir, Subscriptions } from "./supervisor.ts";
import { credentialValues } from "../mcp.ts";

const made: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const TOKEN = "tok-SENTINEL-access";
const CHATGPT = JSON.stringify({ account: { type: "chatgpt", email: "someone@example.test", planType: "plus", workspaceName: null }, requiresOpenaiAuth: true, workspaceRouting: null });
const signedInAs = (userId: string, accountId: string) => JSON.stringify({
  activeSessionId: "s1",
  // What a store could hold next to the ids: none of it may reach a report.
  sessions: [{ sessionId: "s1", email: "someone@example.test", userId, displayName: null, imageUrl: null, lastUsedAt: 1, isActive: true, selectedWorkspaceAccountId: accountId, workspaces: [], accessToken: TOKEN }],
});

/** A supervisor signed in to Codex as `user-1` / `acct-1`, on a fake `codex`. */
async function setup(env: Record<string, string> = {}) {
  const configDir = await mkdtemp(join(tmpdir(), "subscriptions-"));
  made.push(configDir);
  const home = join(subscriptionsDir(configDir), "codex");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: TOKEN } }));
  const sessionsFile = join(configDir, "sessions.json");
  await writeFile(sessionsFile, signedInAs("user-1", "acct-1"));
  const codex = await fakeCodex(made, { FAKE_CODEX_ACCOUNT: CHATGPT, FAKE_CODEX_SESSIONS: sessionsFile, ...env });
  const subs = new Subscriptions({ configDir, codexPath: () => codex.path, env: codex.env });
  const refreshes = async () => (await codex.received()).filter((m) => m.method === "account/read" && (m.params as { refreshToken?: boolean }).refreshToken).length;
  return { configDir, home, sessionsFile, codex, subs, refreshes };
}

test("status reports the provider identity without any token", async () => {
  const { subs, codex } = await setup();
  const status = await subs.status();
  expect(status).toEqual([{ harness: "codex", identity: identityDigest("user-1", "acct-1"), signInNeeded: false }]);
  const reported = JSON.stringify(status);
  for (const secret of [TOKEN, "user-1", "acct-1", "someone@example.test"]) expect(reported).not.toContain(secret);
  // Nothing asked Codex for a token.
  const asked = await codex.received();
  expect(asked.map((m) => m.method)).not.toContain("getAuthStatus");
  expect(JSON.stringify(asked)).not.toContain("includeToken");
});

test("a poll's redaction knows the values of the supervisor's logins", async () => {
  const { configDir } = await setup();
  expect(credentialValues(subscriptionLogins(configDir))).toContain(TOKEN);
});

test("no status without a ChatGPT sign-in in the supervisor's own store", async () => {
  const { subs, home } = await setup({ FAKE_CODEX_ACCOUNT: JSON.stringify({ account: { type: "apiKey" }, requiresOpenaiAuth: true, workspaceRouting: null }) });
  expect(await subs.status()).toEqual([]);
  await rm(home, { recursive: true });
  expect(await subs.status()).toEqual([]);
});

test("a provider identity change is reported and confirms no enrollment", async () => {
  const { subs, sessionsFile, codex } = await setup();
  const before = (await subs.status())[0]!.identity;
  // Same user, another account: a new identity, read at the next report.
  await writeFile(sessionsFile, signedInAs("user-1", "acct-2"));
  const after = await subs.status();
  expect(after).toEqual([{ harness: "codex", identity: identityDigest("user-1", "acct-2"), signInNeeded: false }]);
  expect(after[0]!.identity).not.toBe(before);

  const sent: unknown[] = [];
  const answer = subs.enroll("codex", "c".repeat(32), (msg) => {
    sent.push(msg);
    queueMicrotask(() => subs.enrolled({ type: "subscription.enrolled", askId: msg.askId, error: "the identity doesn't match the enrollment" }));
    return true;
  });
  expect(await answer).toEqual({ ok: false, message: "Dispand bound nothing: the identity doesn't match the enrollment" });
  // The enrollment carries the identity signed in now, never the earlier one.
  expect(sent).toEqual([expect.objectContaining({ type: "subscription.enroll", harness: "codex", identity: after[0]!.identity })]);
  expect(JSON.stringify(sent)).not.toContain(before);

  // Signed out of ChatGPT: nothing is sent at all.
  const signedOut = new Subscriptions({ configDir: (subs as unknown as { options: { configDir: string } }).options.configDir, codexPath: () => codex.path, env: { ...codex.env, FAKE_CODEX_ACCOUNT: JSON.stringify({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }) } });
  const none: unknown[] = [];
  expect((await signedOut.enroll("codex", "c".repeat(32), (m) => none.push(m) > 0)).ok).toBe(false);
  expect(none).toEqual([]);
});

test("an enrollment is confirmed only for Codex, with a challenge Dispand could have issued", async () => {
  const { subs } = await setup();
  const sent: unknown[] = [];
  const send = (m: unknown) => sent.push(m) > 0;
  expect((await subs.enroll("claude-code", "c".repeat(32), send)).ok).toBe(false);
  expect((await subs.enroll("codex", "not a challenge", send)).ok).toBe(false);
  expect(sent).toEqual([]);
  const answer = subs.enroll("codex", "c".repeat(32), (msg) => {
    queueMicrotask(() => subs.enrolled({ type: "subscription.enrolled", askId: msg.askId, enrollmentId: "enr_1" }));
    return true;
  });
  expect(await answer).toMatchObject({ ok: true });
  expect(await subs.enroll("codex", "c".repeat(32), () => false)).toMatchObject({ ok: false });
});

test("concurrent renewals result in one provider call", async () => {
  const { subs, refreshes } = await setup();
  expect(await Promise.all(Array.from({ length: 5 }, () => subs.renew()))).toEqual([true, true, true, true, true]);
  expect(await refreshes()).toBe(1);
});

test("repeated renewal failures produce a single sign-in-needed status", async () => {
  const { subs, home, refreshes } = await setup({ FAKE_CODEX_REFRESH: "fail" });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  for (let i = 0; i < RENEWAL_ATTEMPTS + 3; i++) expect(await subs.renew()).toBe(false);
  // The provider was asked only until renewal gave up, and the person is told once.
  expect(await refreshes()).toBe(RENEWAL_ATTEMPTS);
  expect(logged).toHaveBeenCalledTimes(1);
  expect(await subs.status()).toEqual([expect.objectContaining({ harness: "codex", signInNeeded: true })]);
  // A fresh sign-in rewrites the login: renewal is tried again.
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "a newer one" } }));
  expect(await subs.status()).toEqual([expect.objectContaining({ signInNeeded: false })]);
  await subs.renew();
  expect(await refreshes()).toBe(RENEWAL_ATTEMPTS + 1);
});

test("`enroll` reaches the supervisor through a socket only its user can open", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "control-"));
  made.push(configDir);
  const path = controlSocket(configDir);
  const server = await serveControl(path, async (ask) => ({ ok: true, message: `got ${ask.harness}` }));
  try {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(subscriptionsDir(configDir))).mode & 0o777).toBe(0o700);
    expect(await askControl(path, { harness: "codex", challenge: "x" })).toEqual({ ok: true, message: "got codex" });
  } finally {
    server.close();
  }
});

test("the subscription logins are never among a worker's mounts", async () => {
  // The image's layout: the supervisor's state (HOME) holds its config folder and its roots.
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "state-")));
  made.push(stateDir);
  const configDir = join(stateDir, ".config", "dispand-runner");
  const root = join(stateDir, "work");
  const logins = subscriptionsDir(configDir);
  for (const dir of [join(logins, "codex"), join(logins, "claude-code"), join(root, "runs", "s1"), join(root, "skills")]) await mkdir(dir, { recursive: true });
  const docker = join(stateDir, "docker");
  // Docker as far as a worker's command needs: no container left, and none there once removed.
  await writeFile(docker, '#!/bin/sh\n[ "$1 $2" = "container inspect" ] && { echo "No such container" >&2; exit 1; }\nexit 0\n');
  await chmod(docker, 0o755);
  const sandbox = new Sandbox({ image: "worker@sha256:0", runtime: "runsc", stateDir, stateSource: "/host/state", network: "none", owner: "test", docker });
  await sandbox.sweep();
  const worker = await sandbox.worker(join(root, "runs", "s1"), join(root, "cli", "s1"), [join(root, "skills")]);
  const { args } = worker.command(["codex", "app-server"], join(root, "runs", "s1"), {});
  const mounts = args.flatMap((arg, i) => (args[i - 1] === "--mount" ? [arg] : []));
  expect(mounts.length).toBeGreaterThan(0);
  for (const mount of mounts) {
    const src = /(?:^|,)src=([^,]+)/.exec(mount)?.[1];
    const dst = /(?:^|,)dst=([^,]+)/.exec(mount)![1]!;
    for (const path of [src, dst].filter((p): p is string => !!p)) {
      // As the worker sees it, and as the Docker host's path under the state's source.
      const local = path.startsWith("/host/state") ? join(stateDir, path.slice("/host/state".length)) : path;
      expect(overlapping(local, [logins, configDir])).toBeUndefined();
    }
  }
  await worker.remove();
});
