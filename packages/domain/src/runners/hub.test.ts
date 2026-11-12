import type { PGlite } from "@electric-sql/pglite";
import { stopTelemetry } from "../telemetry/index.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { call } from "@orpc/server";
import {
  type HarnessEvent,
  parseServerMessage,
  PROTOCOL_VERSION,
  type RunnerToServer,
  type ServerToRunner,
} from "@dispand/runner-protocol";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";

import { WebSocket } from "ws";
import type { Db } from "../db/client.ts";
import { runners } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { RunnerHub } from "./hub.ts";
import { upgradeRunner } from "./upgrade.ts";
import { pair } from "./pairing.ts";
import { ownerContext } from "./test-support.ts";

/**
 * Holds the hub's token lookups once they have read the runner, until `release`, to race an upgrade
 * against a revoke or a close. It holds the query on the database client, not `findRunnerByToken`:
 * a module mock wouldn't reach a hub another test file of the worker already loaded.
 */
function holdTokenLookups(db: Db) {
  const client = (db as unknown as { $client: PGlite }).$client;
  const query = client.query.bind(client);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const lookup = new Promise<void>((resolve) => (started = resolve));
  vi.spyOn(client, "query").mockImplementation((async (text: string, ...rest: [never, never]) => {
    const result = await query(text, ...rest);
    if (/ from "runners" where .*"token_hash" = /.test(text)) {
      started();
      await hold;
    }
    return result;
  }) as PGlite["query"]);
  return { started: lookup, release };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.restoreAllMocks();
});

/** An HTTP server that hands every upgrade to the hub the way the app's entries do. */
async function listen(hub: RunnerHub | (() => Promise<RunnerHub>)): Promise<string> {
  const server: Server = createServer((_req, res) => res.end("ok"));
  const load = typeof hub === "function" ? hub : async () => hub;
  server.on("upgrade", (req, socket, head) => upgradeRunner(req, socket, head, load));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/runner/ws`;
}

async function pairedRunner() {
  const context = await ownerContext();
  const { pairingCode } = await call(router.runners.create, { name: "Workstation" }, { context });
  const { runnerId, token } = await pair(context.db, pairingCode);
  return { context, runnerId, token, url: await listen(context.hub) };
}

/** A fake runner: a WebSocket client that collects what the hub sends it. */
function fakeRunner(url: string, token: string) {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}`, "dispand-protocol": String(PROTOCOL_VERSION) },
  });
  cleanup.push(() => ws.terminate());
  const inbox: ServerToRunner[] = [];
  const waiting: ((m: ServerToRunner) => void)[] = [];
  ws.on("message", (data) => {
    const msg = parseServerMessage(String(data));
    const resolve = waiting.shift();
    if (resolve) resolve(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    opened: new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    }),
    closed: new Promise<number>((resolve) => ws.once("close", (code) => resolve(code))),
    send: (msg: RunnerToServer) => ws.send(JSON.stringify(msg)),
    next: () => new Promise<ServerToRunner>((resolve) => (inbox.length ? resolve(inbox.shift()!) : waiting.push(resolve))),
  };
}

const hello: RunnerToServer = { type: "hello", runnerVersion: "0.1.0", clis: { claude: "2.1.0" }, tools: [], liveSessions: [], lastSeq: 0 };
const event = (seq: number, e: HarnessEvent = { type: "text", delta: `d${seq}` }): RunnerToServer => ({
  type: "event",
  seq,
  sessionId: "ses_1",
  event: e,
});

function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => reject(new Error("upgrade was accepted")));
    ws.on("error", () => {});
  });
}

test("revoked runner token is refused at upgrade", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));

  await call(router.runners.revoke, { runnerId }, { context });
  await runner.closed;
  expect(context.hub.isOnline(runnerId)).toBe(false);
  const protocol = String(PROTOCOL_VERSION);
  expect(await upgradeStatus(url, { authorization: `Bearer ${token}`, "dispand-protocol": protocol })).toBe(401);
  expect(await upgradeStatus(url, { authorization: "Bearer not-a-token", "dispand-protocol": protocol })).toBe(401);
  expect(await upgradeStatus(url, { "dispand-protocol": protocol })).toBe(401);
});

test("hello records the CLI versions and marks the runner online", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  const [listed] = await call(router.runners.list, undefined, { context });
  expect(listed).toMatchObject({ id: runnerId, status: "online", clis: { claude: "2.1.0" } });
  expect(listed?.lastSeenAt).toBeInstanceOf(Date);
});

test("hub acks and drops duplicate seq", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const handled: [string, string, HarnessEvent, number][] = [];
  context.hub.onEvent(async (...args) => {
    handled.push(args);
  });
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  runner.send(event(1));
  expect(await runner.next()).toEqual({ type: "ack", seq: 1 });
  runner.send(event(1));
  expect(await runner.next()).toEqual({ type: "ack", seq: 1 });
  runner.send(event(2));
  expect(await runner.next()).toEqual({ type: "ack", seq: 2 });
  expect(handled).toEqual([
    [runnerId, "ses_1", { type: "text", delta: "d1" }, 1],
    [runnerId, "ses_1", { type: "text", delta: "d2" }, 2],
  ]);

  // After an app restart, the last acked seq comes from the database.
  const restarted = new RunnerHub(context.db);
  onTestFinished(() => restarted.close());
  restarted.onEvent(async (...args) => {
    handled.push(args);
  });
  const again = fakeRunner(await listen(restarted), token);
  await again.opened;
  again.send(hello);
  again.send(event(2));
  expect(await again.next()).toEqual({ type: "ack", seq: 2 });
  expect(handled).toHaveLength(2);
  // Events aren't stored by the hub (the engine keeps what it needs); the last seq is.
  const [stored] = await context.db.select().from(runners).where(eq(runners.id, runnerId));
  expect(stored!.lastSeq).toBe(2);
});

test("seqs past the 32-bit range are handled, recorded and acked, also after a restart", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const big = 2_147_483_648;
  const handled: number[] = [];
  context.hub.onEvent(async () => {
    handled.push(1);
  });
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  runner.send(event(big));
  expect(await runner.next()).toEqual({ type: "ack", seq: big });
  runner.send(event(big + 1));
  expect(await runner.next()).toEqual({ type: "ack", seq: big + 1 });
  const [row] = await context.db.select().from(runners).where(eq(runners.id, runnerId));
  expect(row!.lastSeq).toBe(big + 1);

  // The stored last seq, read back as a number, still drops a duplicate after a restart.
  const restarted = new RunnerHub(context.db);
  onTestFinished(() => restarted.close());
  restarted.onEvent(async () => {
    handled.push(1);
  });
  const again = fakeRunner(await listen(restarted), token);
  await again.opened;
  again.send(hello);
  again.send(event(big + 1));
  expect(await again.next()).toEqual({ type: "ack", seq: big + 1 });
  expect(handled).toHaveLength(2);
});

test("an event whose handler fails is not acked, and the runner is disconnected", async () => {
  const { context, token, url } = await pairedRunner();
  const t = await captureTelemetry();
  onTestFinished(() => t.stop());
  context.hub.onEvent(async () => {
    throw new Error("engine down");
  });
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  runner.send(event(1));
  expect(await runner.closed).toBe(1011);
  expect(t.logs().map((r) => r.body)).toContain("runner message failed");

  const handled: number[] = [];
  context.hub.onEvent(async () => {
    handled.push(1);
  });
  const again = fakeRunner(url, token);
  await again.opened;
  again.send(hello);
  again.send(event(1));
  expect(await again.next()).toEqual({ type: "ack", seq: 1 });
  expect(handled).toEqual([1]);
});

test("send to an offline runner returns false and nothing is kept for later", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const answer: ServerToRunner = {
    type: "session.answer",
    sessionId: "ses_1",
    questionId: "q1",
    answer: { kind: "permission", decision: "allow" },
  };
  expect(await context.hub.send(runnerId, answer)).toBe(false);

  // Connected but no hello yet: not ready either.
  const runner = fakeRunner(url, token);
  await runner.opened;
  expect(await context.hub.send(runnerId, answer)).toBe(false);
  runner.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  const later: ServerToRunner = { type: "session.interrupt", sessionId: "ses_1" };
  expect(await context.hub.send(runnerId, later)).toBe(true);
  // The first thing the runner gets is the message sent while it was ready, not the earlier ones.
  expect(await runner.next()).toEqual(later);
});

test("send after hello returns true and the runner receives it", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  const msg: ServerToRunner = { type: "session.send", sessionId: "ses_1", text: "go on" };
  expect(await context.hub.send(runnerId, msg)).toBe(true);
  expect(await runner.next()).toEqual(msg);
});

test("a write failing mid-reconnect returns false, and the next send on the new connection works", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const first = fakeRunner(url, token);
  await first.opened;
  first.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));

  // The socket is going away under the hub's write.
  vi.spyOn(WebSocket.prototype, "send").mockImplementationOnce(function (this: WebSocket, _data: unknown, cb?: (err?: Error) => void) {
    cb?.(new Error("socket closed"));
  } as WebSocket["send"]);
  const lost: ServerToRunner = { type: "session.send", sessionId: "ses_1", text: "lost" };
  expect(await context.hub.send(runnerId, lost)).toBe(false);

  const second = fakeRunner(url, token);
  await second.opened;
  await first.closed;
  second.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  const next: ServerToRunner = { type: "session.send", sessionId: "ses_1", text: "next" };
  expect(await context.hub.send(runnerId, next)).toBe(true);
  expect(await second.next()).toEqual(next);
});

test("a client that resets during the upgrade doesn't crash the server", async () => {
  const { token, url } = await pairedRunner();
  const { port } = new URL(url);
  for (let i = 0; i < 5; i++) {
    const raw = connect(Number(port), "127.0.0.1");
    raw.on("error", () => {});
    await new Promise((resolve) => raw.once("connect", resolve));
    raw.write(
      "GET /runner/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        `Authorization: Bearer ${i % 2 ? token : "not-a-token"}\r\nDispand-Protocol: ${PROTOCOL_VERSION}\r\n\r\n`,
    );
    raw.resetAndDestroy();
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Still serving: a bad token gets its 401.
  expect(await upgradeStatus(url, { authorization: "Bearer not-a-token", "dispand-protocol": String(PROTOCOL_VERSION) })).toBe(401);
});

test("a reconnect while the handler runs doesn't handle the same seq twice", async () => {
  const { context, token, url } = await pairedRunner();
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  context.hub.onEvent(async () => {
    calls++;
    await held;
  });
  const first = fakeRunner(url, token);
  await first.opened;
  first.send(hello);
  first.send(event(1));
  await vi.waitFor(() => expect(calls).toBe(1));

  // The runner reconnects (the old socket is replaced) and resends seq 1, still unacked.
  const second = fakeRunner(url, token);
  await second.opened;
  second.send(hello);
  second.send(event(1));
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  expect(await second.next()).toEqual({ type: "ack", seq: 1 });
  expect(calls).toBe(1);
});

/** A raw TCP upgrade request; resolves with what the server answered (or "" if it closed silently). */
async function rawUpgrade(url: string, target: string, headers: Record<string, string> = {}) {
  const { port } = new URL(url);
  const raw = connect(Number(port), "127.0.0.1");
  cleanup.push(() => raw.destroy());
  raw.on("error", () => {});
  await new Promise((resolve) => raw.once("connect", resolve));
  const lines = [
    `GET ${target} HTTP/1.1`,
    "Host: x",
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  raw.write(lines.join("\r\n") + "\r\n\r\n");
  const response = await new Promise<string>((resolve) => {
    raw.once("data", (d) => resolve(String(d)));
    raw.once("close", () => resolve(""));
  });
  return { raw, response };
}

test("malformed and unknown upgrade targets are refused and the server keeps serving", async () => {
  const { token, url } = await pairedRunner();
  const auth = { Authorization: `Bearer ${token}`, "Dispand-Protocol": String(PROTOCOL_VERSION) };
  // Targets `new URL()` can't parse.
  for (const target of ["//[", "http://[::1", "//a:b@[", "http://%zz"]) {
    expect((await rawUpgrade(url, target, auth)).response).toMatch(/^HTTP\/1\.1 400 /);
  }
  for (const target of ["/elsewhere", "/%", "*", "/runner/ws/../x"]) {
    expect((await rawUpgrade(url, target, auth)).response).toMatch(/^HTTP\/1\.1 404 /);
  }
  expect(await (await fetch(url.replace("ws:", "http:"))).text()).toBe("ok");
  const runner = fakeRunner(url, token);
  await runner.opened;
});

test("a hub that can't load refuses the upgrade with 503", async () => {
  const t = await captureTelemetry();
  onTestFinished(() => t.stop());
  const url = await listen(async () => {
    throw new Error("database unavailable");
  });
  expect((await rawUpgrade(url, "/runner/ws")).response).toMatch(/^HTTP\/1\.1 503 /);
  expect(t.logs().map((r) => r.body)).toContain("runner hub unavailable");
});

test("a malformed frame from an authenticated runner closes only that connection", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const { raw, response } = await rawUpgrade(url, "/runner/ws", {
    Authorization: `Bearer ${token}`,
    "Dispand-Protocol": String(PROTOCOL_VERSION),
  });
  expect(response).toMatch(/^HTTP\/1\.1 101 /);
  const closed = new Promise((resolve) => raw.once("close", resolve));
  raw.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); // a text frame without the client mask
  await closed;
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(false));

  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  runner.send(event(1));
  expect(await runner.next()).toEqual({ type: "ack", seq: 1 });
});

test("a revoke racing an in-flight upgrade leaves the runner offline", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const { started, release } = holdTokenLookups(context.db);

  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}`, "dispand-protocol": String(PROTOCOL_VERSION) } });
  cleanup.push(() => ws.terminate());
  ws.on("error", () => {});
  ws.on("open", () => {
    ws.send(JSON.stringify(hello));
    ws.send(JSON.stringify(event(1)));
  });
  const outcome = new Promise<string>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(`refused ${res.statusCode}`));
    ws.on("close", () => resolve("closed"));
  });
  await started; // the token was read before the revoke commits
  await call(router.runners.revoke, { runnerId }, { context });
  release();

  expect(await outcome).toBe("refused 401");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(context.hub.isOnline(runnerId)).toBe(false);
  const [row] = await context.db.select().from(runners).where(eq(runners.id, runnerId));
  expect(row!.lastSeq).toBe(0);
});

test("a handler whose insert fails logs nothing of the event", async () => {
  const { context, token, url } = await pairedRunner();
  const t = await captureTelemetry();
  onTestFinished(() => t.stop());
  // The insert fails, and Drizzle's error carries the bound params.
  context.hub.onEvent(async (_r, _s, e) => {
    await context.db.execute(sql`insert into missing_table values (${e.type === "text" ? e.delta : ""})`);
  });
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  runner.send(event(1, { type: "text", delta: "secret-token-in-payload" }));
  expect(await runner.closed).toBe(1011);
  expect(t.logs()).not.toEqual([]);
  const logged = await t.all();
  expect(logged).not.toContain("secret-token-in-payload");
  expect(logged).not.toContain("insert into");
});

test("a frame over the payload limit closes the connection and the server keeps serving", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.ws.send("x".repeat(1024 * 1024 + 1));
  expect(await runner.closed).toBe(1009);

  const again = fakeRunner(url, token);
  await again.opened;
  again.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
});

test("a runner flooding past the pending limit is closed with 1008, and the server keeps serving", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  context.hub.onEvent(async () => {
    calls++;
    await held;
  });
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  for (let seq = 1; seq <= 1100; seq++) runner.send(event(seq));
  expect(await runner.closed).toBe(1008);
  release();

  // Nothing it had waiting was handled; it reconnects and resends from its first unacked event.
  const again = fakeRunner(url, token);
  await again.opened;
  again.send(hello);
  again.send(event(2));
  expect(await again.next()).toEqual({ type: "ack", seq: 2 });
  expect(calls).toBe(2);
  expect(context.hub.isOnline(runnerId)).toBe(true);
});

test("a burst under the pending limit is fully handled", async () => {
  const { context, token, url } = await pairedRunner();
  const handled: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  context.hub.onEvent(async (_runnerId, _sessionId, e) => {
    await held;
    handled.push(Number(e.type === "text" ? e.delta.slice(1) : 0));
  });
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  for (let seq = 1; seq <= 300; seq++) runner.send(event(seq));
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  for (let seq = 1; seq <= 300; seq++) expect(await runner.next()).toEqual({ type: "ack", seq });
  expect(handled).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
});

test("a replaced connection's waiting messages are dropped, not kept on the runner's allowance", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const handled: number[] = [];
  context.hub.onEvent(async (_r, _s, e) => {
    await held;
    handled.push(Number(e.type === "text" ? e.delta.slice(1) : 0));
  });
  const pending = () => (context.hub as unknown as { states: Map<string, { pending: unknown[] }> }).states.get(runnerId)!.pending.length;
  const first = fakeRunner(url, token);
  await first.opened;
  first.send(hello);
  for (let seq = 1; seq <= 600; seq++) first.send(event(seq));
  await vi.waitFor(() => expect(pending()).toBe(599)); // seq 1 is in the handler

  const second = fakeRunner(url, token);
  await second.opened;
  await vi.waitFor(() => expect(pending()).toBe(0));
  second.send(hello);
  for (let seq = 2; seq <= 700; seq++) second.send(event(seq)); // more than the first had left: still under the limit
  await vi.waitFor(() => expect(pending()).toBe(700));
  release();
  expect(await second.next()).toEqual({ type: "ack", seq: 2 });
  await vi.waitFor(() => expect(handled).toHaveLength(700));
  expect(handled).toEqual(Array.from({ length: 700 }, (_, i) => i + 1));
});

test("close() closes every runner socket", async () => {
  const one = await pairedRunner();
  const { pairingCode } = await call(router.runners.create, { name: "Laptop" }, { context: one.context });
  const two = await pair(one.context.db, pairingCode);
  const a = fakeRunner(one.url, one.token);
  const b = fakeRunner(one.url, two.token);
  await Promise.all([a.opened, b.opened]);
  a.send(hello);
  b.send(hello);
  await vi.waitFor(() => expect(one.context.hub.isOnline(two.runnerId)).toBe(true));
  one.context.hub.close();
  expect(await Promise.all([a.closed, b.closed])).toEqual([1001, 1001]);
  expect(one.context.hub.isOnline(one.runnerId)).toBe(false);
  expect(one.context.hub.isOnline(two.runnerId)).toBe(false);
});

test("300 reconnects behind a stalled handler retain nothing of the dropped connections", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  // Stalled, like a database call that hangs: its promise stays reachable until released.
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => (release = resolve));
  context.hub.onEvent(() => stalled);
  const state = () => (context.hub as unknown as { states: Map<string, { pending: unknown[] }> }).states.get(runnerId)!;
  const gc = (globalThis as { gc?: () => void }).gc!;
  const first = fakeRunner(url, token);
  await first.opened;
  first.send(hello);
  first.send(event(1));
  await vi.waitFor(() => expect(state().pending).toHaveLength(0));

  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 300; i++) {
    const runner = fakeRunner(url, token);
    await runner.opened;
    // Just under the pending limit each time: the replaced connection's are dropped.
    for (let seq = 2; seq <= 900; seq++) runner.send(event(seq));
    await vi.waitFor(() => expect(state().pending).toHaveLength(899));
  }
  const last = fakeRunner(url, token);
  await last.opened;
  await vi.waitFor(() => expect(state().pending).toHaveLength(0));
  for (const fn of cleanup.splice(1)) fn();
  await new Promise((resolve) => setTimeout(resolve, 200));
  gc();
  expect(process.memoryUsage().heapUsed - before).toBeLessThan(8 * 1024 * 1024);
  release();
  // 300 PGlite-backed connections: about 3 minutes on a loaded machine, past the 30 s default.
}, 180_000);

test("an upgrade still looking up its token when the hub closes is refused, and no socket stays open", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const { started, release } = holdTokenLookups(context.db);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}`, "dispand-protocol": String(PROTOCOL_VERSION) } });
  cleanup.push(() => ws.terminate());
  ws.on("error", () => {});
  const outcome = new Promise<string>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(`refused ${res.statusCode}`));
    ws.on("open", () => resolve("opened"));
  });
  await started;
  context.hub.close();
  release();

  expect(await outcome).toBe("refused 503");
  expect(context.hub.isOnline(runnerId)).toBe(false);
  expect((context.hub as unknown as { wss: { clients: Set<unknown> } }).wss.clients.size).toBe(0);
  // New upgrades are refused at once.
  expect(await upgradeStatus(url, { authorization: `Bearer ${token}`, "dispand-protocol": String(PROTOCOL_VERSION) })).toBe(503);
});

test("a connection closed mid-burst leaves nothing on the runner's allowance: the replayed burst is accepted", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  context.hub.onEvent(() => held);
  const pending = () => (context.hub as unknown as { states: Map<string, { pending: unknown[] }> }).states.get(runnerId)!.pending.length;
  const first = fakeRunner(url, token);
  await first.opened;
  first.send(hello);
  for (let seq = 1; seq <= 900; seq++) first.send(event(seq));
  await vi.waitFor(() => expect(pending()).toBe(899));
  first.ws.close();
  await first.closed;
  await vi.waitFor(() => expect(pending()).toBe(0));

  // The runner comes back and replays its unacked burst: well under the limit.
  const second = fakeRunner(url, token);
  await second.opened;
  let closedWith: number | undefined;
  void second.closed.then((code) => (closedWith = code));
  second.send(hello);
  for (let seq = 1; seq <= 900; seq++) second.send(event(seq));
  release();
  for (let seq = 1; seq <= 900; seq++) expect(await second.next()).toEqual({ type: "ack", seq });
  expect(closedWith).toBeUndefined();
});

test("at shutdown, a replaced socket that never answers the close handshake is terminated", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const auth = { Authorization: `Bearer ${token}`, "Dispand-Protocol": String(PROTOCOL_VERSION) };
  const { raw, response } = await rawUpgrade(url, "/runner/ws", auth);
  expect(response).toMatch(/^HTTP\/1\.1 101 /);
  raw.on("data", () => {}); // reads the close frame, never answers it
  const closed = new Promise((resolve) => raw.once("close", resolve));
  // A new connection replaces it: the old one is asked to close and never does.
  const next = fakeRunner(url, token);
  await next.opened;
  next.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));

  const started = Date.now();
  context.hub.close();
  await closed;
  expect(Date.now() - started).toBeLessThan(2500);
  await vi.waitFor(() => expect((context.hub as unknown as { wss: { clients: Set<unknown> } }).wss.clients.size).toBe(0));
});

test("a message refused by the protocol (a NUL in a text delta) is dropped and the connection stays usable", async () => {
  const { context, token, url } = await pairedRunner();
  const handled: number[] = [];
  context.hub.onEvent(async () => {
    handled.push(1);
  });
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  runner.send(event(1, { type: "text", delta: "a\u0000b" }));
  runner.send(event(2));
  expect(await runner.next()).toEqual({ type: "ack", seq: 2 });
  expect(handled).toEqual([1]);
  expect(runner.ws.readyState).toBe(WebSocket.OPEN);
});

test("connections end only through retire()", () => {
  const source = readFileSync(new URL("./hub.ts", import.meta.url), "utf8");
  const retire = /\n {2}private retire\([\s\S]*?\n {2}}\n/.exec(source)?.[0] ?? "";
  expect(retire).not.toBe("");
  const outside = source.replace(retire, "");
  // Nothing else removes a connection, drops queued messages or closes a socket.
  expect(outside).not.toMatch(/connections\.(delete|clear)\(|\.pending\s*=|\.pending\.(filter|splice|pop)\(|\.close\(\d|\.terminate\(\)/);
});

test("an event Postgres refuses as data (class 22) is logged, acked and dropped; the runner moves on", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const t = await captureTelemetry();
  onTestFinished(() => t.stop());
  // Validation can't foresee every value storage refuses: stand one in with a cast the handler makes.
  const handled: string[] = [];
  context.hub.onEvent(async (_r, _s, e) => {
    const delta = e.type === "text" ? e.delta : e.type;
    handled.push(delta);
    await context.db.execute(sql`select ${delta}::int`);
  });
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  runner.send(event(1, { type: "text", delta: "boom" }));
  expect(await runner.next()).toEqual({ type: "ack", seq: 1 });
  runner.send(event(2, { type: "text", delta: "2" }));
  expect(await runner.next()).toEqual({ type: "ack", seq: 2 });
  expect(runner.ws.readyState).toBe(WebSocket.OPEN);
  expect(handled).toEqual(["boom", "2"]);
  expect(t.logs()[0]).toMatchObject({ body: "runner event not storable, dropped", attributes: { runnerId, "db.response.status_code": "22P02" } });
  // A resend of the dropped seq is a duplicate now.
  runner.send(event(1, { type: "text", delta: "boom" }));
  expect(await runner.next()).toEqual({ type: "ack", seq: 1 });
  expect(handled).toHaveLength(2);
});

test("caught up: the handler runs once the events sent before hello are handled, then sends go out", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const log: string[] = [];
  context.hub.onEvent(async (_r, _s, e) => {
    log.push(`event ${e.type === "text" ? e.delta : e.type}`);
  });
  context.hub.onCaughtUp(async (id, live) => {
    expect(id).toBe(runnerId);
    expect(context.hub.isOnline(runnerId)).toBe(true);
    log.push(`caught up ${live.join(",")}`);
  });
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send({ ...hello, liveSessions: ["ses_1"], lastSeq: 2 });
  runner.send(event(1));
  expect(await runner.next()).toEqual({ type: "ack", seq: 1 });
  expect(await context.hub.send(runnerId, { type: "session.interrupt", sessionId: "ses_1" })).toBe(false);
  runner.send(event(2));
  expect(await runner.next()).toEqual({ type: "ack", seq: 2 });
  await vi.waitFor(() => expect(log).toEqual(["event d1", "event d2", "caught up ses_1"]));
  // Events after the hello's lastSeq don't reconcile again.
  runner.send(event(3));
  expect(await runner.next()).toEqual({ type: "ack", seq: 3 });
  expect(log).toEqual(["event d1", "event d2", "caught up ses_1", "event d3"]);
});

test("a failing caught-up handler drops the connection, and the next hello retries it", async () => {
  const { context, token, url } = await pairedRunner();
  vi.spyOn(console, "error").mockImplementation(() => {});
  let calls = 0;
  context.hub.onCaughtUp(async () => {
    calls++;
    if (calls === 1) throw new Error("database down");
  });
  const first = fakeRunner(url, token);
  await first.opened;
  first.send(hello);
  expect(await first.closed).toBe(1011);
  const second = fakeRunner(url, token);
  await second.opened;
  second.send(hello);
  await vi.waitFor(() => expect(calls).toBe(2));
});

test("a hello without its replay watermark is refused by the protocol: the runner is never reconciled", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  let reconciled = 0;
  context.hub.onCaughtUp(async () => {
    reconciled++;
  });
  const old = fakeRunner(url, token);
  await old.opened;
  const noWatermark = { ...(hello as Extract<RunnerToServer, { type: "hello" }>) } as Partial<Extract<RunnerToServer, { type: "hello" }>>;
  delete noWatermark.lastSeq;
  old.ws.send(JSON.stringify(noWatermark));
  old.send(event(1));
  // Not ready: the event is handled and acked (the hub keeps no session state), but nothing is reconciled.
  expect(await old.next()).toEqual({ type: "ack", seq: 1 });
  expect(reconciled).toBe(0);
  expect(context.hub.isOnline(runnerId)).toBe(false);
});

test("a v1 runner gets 426, and runners.list says it is outdated with the update command", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  expect(await upgradeStatus(url, { authorization: `Bearer ${token}`, "dispand-protocol": "1" })).toBe(426);
  // Only once the token is known: anyone else gets 401, and nothing is recorded.
  expect(await upgradeStatus(url, { authorization: "Bearer not-a-token", "dispand-protocol": "1" })).toBe(401);
  const [listed] = await call(router.runners.list, undefined, { context });
  expect(listed).toEqual(
    expect.objectContaining({
      id: runnerId,
      status: "outdated",
      updateCommand: `curl -fsSL ${context.auth.options.baseURL}/runner/install.sh | sh -s -- --update`,
    }),
  );

  // Updated: it connects with v2 and is online again, with no update command.
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  const [online] = await call(router.runners.list, undefined, { context });
  expect(online).toMatchObject({ status: "online" });
  expect(online).not.toHaveProperty("updateCommand");
  runner.ws.close();
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(false));
  const [offline] = await call(router.runners.list, undefined, { context });
  expect(offline).toMatchObject({ status: "offline" });
});

test("a runner last seen before protocol 2 is outdated", async () => {
  const { context, runnerId } = await pairedRunner();
  // What the migration does to the runners seen before it.
  await context.db.update(runners).set({ protocolVersion: 1, lastSeenAt: new Date() }).where(eq(runners.id, runnerId));
  const [listed] = await call(router.runners.list, undefined, { context });
  expect(listed).toMatchObject({ status: "outdated" });
});

test("an unknown protocol version is refused with 400", async () => {
  const { token, url } = await pairedRunner();
  for (const protocol of [String(PROTOCOL_VERSION + 1), "x", ""]) {
    expect(await upgradeStatus(url, { authorization: `Bearer ${token}`, "dispand-protocol": protocol })).toBe(400);
  }
});

test("hello records Codex's version and sign-in state, and the runner's own MCP servers", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send({ ...hello, clis: { claude: "2.1.0", codex: { version: "0.166.0", signedIn: false } }, tools: ["fetch", "brave-search"] } as RunnerToServer);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  const [listed] = await call(router.runners.list, undefined, { context });
  expect(listed?.clis).toEqual({ claude: "2.1.0", codex: { version: "0.166.0", signedIn: false } });
  expect(listed?.tools).toEqual(["fetch", "brave-search"]);
});

test("request sends tool.discover and resolves with the runner's reply to it", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  const reply = context.hub.request(runnerId, { type: "tool.discover", requestId: "req_1", tool: "fetch" });
  expect(await runner.next()).toEqual({ type: "tool.discover", requestId: "req_1", tool: "fetch" });
  // Another request id is ignored; the matching one resolves it, and nothing is acked.
  runner.send({ type: "tool.discovered", requestId: "req_other", error: "x" });
  const actions = [{ name: "fetch", description: "Fetches", inputSchema: { type: "object" } }];
  runner.send({ type: "tool.discovered", requestId: "req_1", actions });
  expect(await reply).toEqual({ type: "tool.discovered", requestId: "req_1", actions });
  runner.send(event(1));
  expect(await runner.next()).toEqual({ type: "ack", seq: 1 });
});

test("call sends tool.call and resolves only with a tool.called reply to it", async () => {
  const t = await captureTelemetry();
  onTestFinished(() => t.stop());
  const { context, runnerId, token, url } = await pairedRunner();
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  const msg = { type: "tool.call" as const, requestId: "req_c", tool: "mail", action: "search", arguments: { query: "is:unread" } };
  const reply = context.hub.call(runnerId, msg);
  expect(await runner.next()).toEqual(msg);
  // A listing's reply with the same id is not a call's: it resolves nothing.
  runner.send({ type: "tool.discovered", requestId: "req_c", actions: [] });
  runner.send({ type: "tool.called", requestId: "req_c", content: [{ type: "text", text: "[]" }], isError: false });
  expect(await reply).toEqual({ type: "tool.called", requestId: "req_c", content: [{ type: "text", text: "[]" }], isError: false });
  // Traced and counted by outcome, never with its arguments or result.
  const spans = t.spans().filter((sp) => sp.name === "runner.tool_call");
  expect(spans.map((sp) => sp.attributes["dispand.result"])).toEqual(["ok"]);
  expect(JSON.stringify(spans.map((sp) => sp.attributes))).not.toContain("is:unread");
});

test("request fails at once for an offline runner, after its timeout, and when the runner disconnects", async () => {
  const { context, runnerId, token, url } = await pairedRunner();
  const discover = (requestId: string) => ({ type: "tool.discover" as const, requestId, tool: "fetch" });
  await expect(context.hub.request(runnerId, discover("r0"))).rejects.toThrow("runner offline");
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  await expect(context.hub.request(runnerId, discover("r1"), 50)).rejects.toThrow("timed out");
  const pending = context.hub.request(runnerId, discover("r2"));
  await runner.next();
  await runner.next();
  runner.ws.close();
  await expect(pending).rejects.toThrow("runner offline");
});

test("a runner can't answer another runner's request", async () => {
  const a = await pairedRunner();
  const { pairingCode } = await call(router.runners.create, { name: "Other" }, { context: a.context });
  const other = await pair(a.context.db, pairingCode);
  const ra = fakeRunner(a.url, a.token);
  const rb = fakeRunner(a.url, other.token);
  await Promise.all([ra.opened, rb.opened]);
  ra.send(hello);
  rb.send(hello);
  await vi.waitFor(() => expect(a.context.hub.isOnline(a.runnerId) && a.context.hub.isOnline(other.runnerId)).toBe(true));
  const reply = a.context.hub.request(a.runnerId, { type: "tool.discover", requestId: "req_1", tool: "fetch" }, 300);
  rb.send({ type: "tool.discovered", requestId: "req_1", actions: [] });
  await expect(reply).rejects.toThrow("timed out");
});

test("request times out even while its write is stalled", async () => {
  const { context, runnerId } = await pairedRunner();
  // A socket under backpressure: the write never completes.
  vi.spyOn(context.hub, "send").mockReturnValue(new Promise<boolean>(() => {}));
  await expect(context.hub.request(runnerId, { type: "tool.discover", requestId: "req_s", tool: "fetch" }, 50)).rejects.toThrow("timed out");
});

test("a runner's connection is counted, each message counted and traced but streamed words, and nothing of their content leaves", async () => {
  const { context, token, url } = await pairedRunner();
  context.hub.onEvent(async () => {});
  const t = await captureTelemetry();
  onTestFinished(() => stopTelemetry());
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  runner.send({ type: "event", sessionId: "ses_1", seq: 1, event: { type: "text", delta: "sentinel-streamed-words" } });
  expect(await runner.next()).toEqual({ type: "ack", seq: 1 });
  runner.send({ type: "event", sessionId: "ses_1", seq: 2, event: { type: "result", text: "sentinel-result-text" } });
  expect(await runner.next()).toEqual({ type: "ack", seq: 2 });
  expect(t.spans().filter((x) => x.name === "runner.message").map((x) => x.attributes["dispand.message.type"])).toEqual(["hello", "event.result"]);
  const points = await t.metrics();
  expect(points).toContainEqual({ name: "dispand.runner.connections", attributes: { "dispand.result": "accepted" } });
  expect(points).toContainEqual({ name: "dispand.runner.messages", attributes: { "dispand.message.type": "event.text" } });
  const all = await t.all();
  for (const sentinel of ["sentinel-streamed-words", "sentinel-result-text", token]) expect(all).not.toContain(sentinel);
});

test("native plugin requests are owner-scoped, correlated, and counted without content", async () => {
  const t = await captureTelemetry();
  onTestFinished(() => t.stop());
  const { context, runnerId, token, url } = await pairedRunner();
  const runner = fakeRunner(url, token);
  await runner.opened;
  runner.send(hello);
  await vi.waitFor(() => expect(context.hub.isOnline(runnerId)).toBe(true));
  await expect(call(router.runners.plugins, { runnerId: "another", operation: { action: "list" } }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.runners.plugins, { runnerId, operation: { action: "remove", name: "demo", targets: ["codex"], dryRun: true } }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const pending = call(router.runners.plugins, { runnerId, operation: { action: "list" } }, { context });
  const request = await runner.next();
  expect(request.type).toBe("plugin.request");
  if (request.type !== "plugin.request") throw new Error("expected plugin request");
  runner.send({ type: "tool.discovered", requestId: request.requestId, actions: [] });
  runner.send({ type: "plugin.replied", requestId: request.requestId, report: { packages: [] } });
  expect(await pending).toEqual({ packages: [] });
  expect(t.spans().some((s) => s.name === "runner.plugins")).toBe(true);
  expect(await t.metrics()).toContainEqual({ name: "dispand.runner.plugin_operations", attributes: { "dispand.result": "ok" } });
  expect(t.logs().some((l) => l.body === "native plugin operation completed")).toBe(true);
});
