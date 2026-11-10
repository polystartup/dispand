import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { fakeCodex as fakeCodexIn } from "../fixtures/fake-codex-bin.ts";
import { CodexRpc } from "./rpc.ts";
import { codexRequired, codexStatus } from "./version.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fakeCodex = (env: Record<string, string> = {}) => fakeCodexIn(made, env);

test("initialize and initialized come before any request", async () => {
  const codex = await fakeCodex();
  const rpc = await CodexRpc.spawn(codex.path, codex.env, codex.dir);
  const result = await rpc.request("account/read", { refreshToken: false });
  expect(result.requiresOpenaiAuth).toBe(true);
  await rpc.close();
  const [init, initialized, read] = await codex.received();
  expect(init).toMatchObject({
    method: "initialize",
    params: { clientInfo: { name: "dispand-runner" }, capabilities: { experimentalApi: true, requestAttestation: false } },
  });
  expect(init).not.toHaveProperty("jsonrpc");
  expect(initialized).toEqual({ method: "initialized" });
  expect(read).toMatchObject({ method: "account/read" });
});

test.each(["account/chatgptAuthTokens/refresh", "attestation/generate"])("%s is refused, even with a handler", async (method) => {
  const codex = await fakeCodex({ FAKE_CODEX_SERVER_REQUESTS: JSON.stringify([{ method, params: {} }]) });
  const rpc = await CodexRpc.spawn(codex.path, codex.env, codex.dir);
  const handler = vi.fn(async () => ({ accessToken: "never" }));
  rpc.onServerRequest(handler);
  await vi.waitFor(async () => expect((await codex.received()).find((m) => m.id === "s0")).toMatchObject({ error: { code: expect.any(Number) } }));
  expect(handler).not.toHaveBeenCalled();
  expect(JSON.stringify(await codex.received())).not.toContain("never");
  await rpc.close();
});

test("an unknown server request gets -32601", async () => {
  const codex = await fakeCodex({ FAKE_CODEX_SERVER_REQUESTS: JSON.stringify([{ method: "currentTime/read", params: {} }]) });
  const rpc = await CodexRpc.spawn(codex.path, codex.env, codex.dir);
  await vi.waitFor(async () => expect((await codex.received()).find((m) => m.id === "s0")).toMatchObject({ error: { code: -32601 } }));
  await rpc.close();
});

test("a handled server request gets the handler's result", async () => {
  const codex = await fakeCodex({ FAKE_CODEX_SERVER_REQUESTS: JSON.stringify([{ method: "currentTime/read", params: {} }]) });
  const rpc = await CodexRpc.spawn(codex.path, codex.env, codex.dir);
  rpc.onServerRequest(async (r) => ({ seen: r.method }));
  await vi.waitFor(async () => expect((await codex.received()).find((m) => m.id === "s0")).toEqual({ id: "s0", result: { seen: "currentTime/read" } }));
  await rpc.close();
});

test("the process exiting rejects pending requests", async () => {
  const codex = await fakeCodex({ FAKE_CODEX_EXIT_ON: "thread/list" });
  const rpc = await CodexRpc.spawn(codex.path, codex.env, codex.dir);
  await expect(rpc.request("thread/list", {})).rejects.toThrow(/exited/);
  await rpc.exited;
  await expect(rpc.request("account/read", {})).rejects.toThrow(/exited/);
});

test("a signed-out Codex reports signedIn false", async () => {
  const codex = await fakeCodex({ FAKE_CODEX_ACCOUNT: JSON.stringify({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }) });
  expect(await codexStatus(codex.path, codex.env)).toEqual({ version: "0.166.0", signedIn: false });
});

test("a signed-in Codex reports signedIn true, never its email", async () => {
  const account = { type: "chatgpt", email: "someone@example.invalid", planType: "plus", workspaceName: null };
  const codex = await fakeCodex({ FAKE_CODEX_VERSION: "0.170.1", FAKE_CODEX_ACCOUNT: JSON.stringify({ account, requiresOpenaiAuth: true, workspaceRouting: null }) });
  const status = await codexStatus(codex.path, codex.env);
  expect(status).toEqual({ version: "0.170.1", signedIn: true });
});

test("a Codex that needs no OpenAI auth counts as signed in", async () => {
  const codex = await fakeCodex({ FAKE_CODEX_ACCOUNT: JSON.stringify({ account: null, requiresOpenaiAuth: false, workspaceRouting: null }) });
  expect(await codexStatus(codex.path, codex.env)).toEqual({ version: "0.166.0", signedIn: true });
});

test("an app-server that fails reports no status, not signed out", async () => {
  const codex = await fakeCodex({ FAKE_CODEX_EXIT_ON: "account/read" });
  expect(await codexStatus(codex.path, codex.env)).toBeUndefined();
});

test("an app-server that doesn't answer in time reports no status and is killed", async () => {
  for (const method of ["initialize", "account/read"]) {
    const codex = await fakeCodex({ FAKE_CODEX_HANG_ON: method });
    const pidFile = join(codex.dir, "pid");
    expect(await codexStatus(codex.path, { ...codex.env, FAKE_CODEX_PID: pidFile }, 3000)).toBeUndefined();
    const pid = Number(await readFile(pidFile, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  }
});

test("a Codex that can't start reports no status", async () => {
  expect(await codexStatus("/nonexistent/codex", process.env)).toBeUndefined();
});

test("Codex older than the minimum is refused", () => {
  expect(codexRequired("0.165.9")).toBe("Codex ≥ 0.166.0 required (found 0.165.9): update codex on this machine");
  expect(codexRequired(undefined)).toMatch(/found none/);
  expect(codexRequired("0.166.0")).toBeUndefined();
  expect(codexRequired("0.200.0")).toBeUndefined();
});
