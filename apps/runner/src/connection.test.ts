import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call } from "@orpc/server";
import { pair, router } from "@dispand/domain";
import { type HarnessEvent, parseRunnerMessage, PROTOCOL_VERSION, type RunnerToServer, type ServerToRunner } from "@dispand/runner-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { ownerContext } from "../../../packages/domain/src/runners/test-support.ts";
import { Connection, MAX_FULL_ERRORS, WINDOW_BYTES, WINDOW_MESSAGES } from "./connection.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function seqFile() {
  const dir = await mkdtemp(join(tmpdir(), "connection-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "state.json");
}

const hello = (): Omit<Extract<RunnerToServer, { type: "hello" }>, "lastSeq"> => ({
  type: "hello",
  runnerVersion: "0.1.0",
  clis: { claude: "2.1.0" },
  tools: [],
  liveSessions: [],
});
const text = (delta: string): HarnessEvent => ({ type: "text", delta });

function connect(server: string, seqPath: string, onMessage: (m: ServerToRunner) => void = () => {}) {
  const conn = new Connection({ server, token: "tok", seqPath, hello, onMessage, backoff: { initialMs: 10, maxMs: 50 } });
  cleanup.push(() => conn.close());
  conn.start();
  return conn;
}

test("replays unacked events after reconnect", async () => {
  // A fake server: acks seq 1, then drops the socket on seq 2 without acking it.
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  cleanup.push(() => new Promise((resolve) => wss.close(resolve)));
  const sockets: { req: IncomingMessage; received: RunnerToServer[] }[] = [];
  wss.on("connection", (ws, req) => {
    const socket = { req, received: [] as RunnerToServer[] };
    sockets.push(socket);
    ws.on("message", (data) => {
      const msg = parseRunnerMessage(String(data));
      socket.received.push(msg);
      if (msg.type !== "event") return;
      if (sockets.length === 1 && msg.seq === 2) ws.terminate();
      else ws.send(JSON.stringify({ type: "ack", seq: msg.seq }));
    });
  });
  const server = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const seqPath = await seqFile();

  const conn = connect(server, seqPath);
  conn.emit("ses_1", text("a"));
  conn.emit("ses_2", text("b"));
  await vi.waitFor(() => expect(sockets[1]?.received).toHaveLength(2));
  expect(sockets[0]!.req.url).toBe("/runner/ws");
  expect(sockets[0]!.req.headers).toMatchObject({ authorization: "Bearer tok", "dispand-protocol": String(PROTOCOL_VERSION) });
  expect(sockets[0]!.received.map((m) => (m.type === "event" ? m.seq : m.type))).toEqual(["hello", 1, 2]);
  // The hello names the last event it resends, so the server can wait for it.
  expect(sockets[1]!.received).toEqual([{ ...hello(), lastSeq: 2 }, { type: "event", seq: 2, sessionId: "ses_2", event: text("b") }]);

  // The seq survives a restart of the runner.
  await vi.waitFor(() => expect(conn.unackedCount).toBe(0));
  conn.close();
  const restarted = connect(server, seqPath);
  restarted.emit("ses_1", text("c"));
  await vi.waitFor(() => expect(sockets[2]?.received).toHaveLength(2));
  // Never reused: it goes on past the checkpoint (seqs are reserved in blocks, so it may skip some).
  expect((sockets[2]!.received[1] as { seq: number }).seq).toBeGreaterThan(2);
});

test("talks to the real hub: hello first, events acked, server messages delivered", async () => {
  const context = await ownerContext();
  const { pairingCode } = await call(router.runners.create, { name: "Workstation" }, { context });
  const { runnerId, token } = await pair(context.db, pairingCode);
  const handled: [string, HarnessEvent][] = [];
  context.hub.onEvent(async (_runner, sessionId, event) => {
    handled.push([sessionId, event]);
  });
  const interrupt: ServerToRunner = { type: "session.interrupt", sessionId: "ses_1" };
  // The hub delivers only to a connected runner.
  expect(await context.hub.send(runnerId, interrupt)).toBe(false);

  const http = createServer();
  http.on("upgrade", (req, socket, head) => context.hub.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => http.close(resolve)));

  const received: ServerToRunner[] = [];
  const conn = new Connection({
    server: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    token,
    seqPath: await seqFile(),
    hello,
    onMessage: (m) => received.push(m),
  });
  cleanup.push(() => conn.close());
  conn.start();
  conn.emit("ses_1", text("x"));
  conn.emit("ses_1", { type: "turn-end" });

  await vi.waitFor(() => expect(conn.unackedCount).toBe(0), { timeout: 20_000 });
  expect(await context.hub.send(runnerId, interrupt)).toMatch(/^conn_/);
  await vi.waitFor(() => expect(received).toEqual([interrupt]), { timeout: 20_000 });
  expect(handled).toEqual([
    ["ses_1", text("x")],
    ["ses_1", { type: "turn-end" }],
  ]);
  expect(context.hub.isOnline(runnerId)).toBe(true);
});

/** A fake server that records what it receives and acks only when told to. */
async function holdingServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 * 1024 });
  await new Promise((resolve) => wss.once("listening", resolve));
  cleanup.push(() => new Promise((resolve) => wss.close(resolve)));
  const sockets: { received: RunnerToServer[]; ack: (seq: number) => void; drop: () => void }[] = [];
  wss.on("connection", (ws) => {
    const socket = {
      received: [] as RunnerToServer[],
      ack: (seq: number) => ws.send(JSON.stringify({ type: "ack", seq })),
      drop: () => ws.terminate(),
    };
    sockets.push(socket);
    // parseRunnerMessage throws on anything the protocol refuses: the test fails then.
    ws.on("message", (data) => socket.received.push(parseRunnerMessage(String(data))));
  });
  return { server: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, sockets };
}

const seqs = (received: RunnerToServer[]) => received.flatMap((m) => (m.type === "event" ? [m.seq] : []));

test("keeps what is in flight under the hub's queue limits, on reconnect too", async () => {
  const { server, sockets } = await holdingServer();
  const conn = connect(server, await seqFile());
  for (let i = 1; i <= 1200; i++) conn.emit(`ses_t${i}`, text(`d${i}`));
  await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toHaveLength(WINDOW_MESSAGES));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(seqs(sockets[0]!.received)).toHaveLength(WINDOW_MESSAGES);

  // Reconnecting resends from the oldest unacked event, within the same window.
  sockets[0]!.drop();
  await vi.waitFor(() => expect(seqs(sockets[1]?.received ?? [])).toHaveLength(WINDOW_MESSAGES));
  expect(sockets[1]!.received[0]!.type).toBe("hello");
  expect(seqs(sockets[1]!.received)[0]).toBe(1);

  // Acks open the window again; everything arrives once, in order.
  let acked = 0;
  while (acked < 1200) {
    acked = Math.max(...seqs(sockets[1]!.received));
    sockets[1]!.ack(acked);
    await vi.waitFor(() => expect(conn.unackedCount).toBe(1200 - acked));
    if (acked < 1200) await vi.waitFor(() => expect(Math.max(...seqs(sockets[1]!.received))).toBeGreaterThan(acked));
  }
  expect(seqs(sockets[1]!.received)).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
});

test("keeps the bytes in flight under the window too", async () => {
  const { server, sockets } = await holdingServer();
  const conn = connect(server, await seqFile());
  const big = "x".repeat(30_000);
  for (let i = 0; i < 300; i++) conn.emit(`ses_t${i}`, text(big));
  await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? []).length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const inFlight = sockets[0]!.received.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0);
  expect(inFlight).toBeLessThanOrEqual(WINDOW_BYTES);
  expect(seqs(sockets[0]!.received).length).toBeLessThan(300);
});

test("every event that goes out is one the protocol accepts", async () => {
  const { server, sockets } = await holdingServer();
  const conn = connect(server, await seqFile());
  conn.emit("ses_1", text("a\u0000b\ud800c"));
  conn.emit("ses_1", { type: "error", message: "e".repeat(10_000) });
  await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toHaveLength(2));
  expect(sockets[0]!.received.slice(1)).toEqual([
    { type: "event", seq: 1, sessionId: "ses_1", event: text("a\ufffdb\ufffdc") },
    { type: "event", seq: 2, sessionId: "ses_1", event: { type: "error", message: "e".repeat(4000) } },
  ]);
});

test("text deltas waiting to go out are folded per session, up to a chunk", async () => {
  const { server, sockets } = await holdingServer();
  const conn = new Connection({ server, token: "tok", seqPath: await seqFile(), hello, onMessage: () => {}, backoff: { initialMs: 10, maxMs: 50 } });
  cleanup.push(() => conn.close());
  // Not connected yet: everything waits.
  conn.emit("ses_1", text("a"));
  conn.emit("ses_1", text("b"));
  conn.emit("ses_2", text("c"));
  // "ab" isn't last any more: "d" waits without a seq, and goes out right before ses_1's next other event.
  conn.emit("ses_1", text("d"));
  conn.emit("ses_1", { type: "turn-end" });
  conn.emit("ses_1", text("x".repeat(20_000)));
  conn.emit("ses_1", text("y".repeat(20_000)));
  // Held past a chunk, ses_1's text got its seqs at once.
  expect(conn.unackedCount).toBe(6);
  conn.start();
  await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toHaveLength(6));
  const events = sockets[0]!.received.flatMap((m) => (m.type === "event" ? [[m.sessionId, m.event] as const] : []));
  expect(events.slice(0, 4)).toEqual([
    ["ses_1", text("ab")],
    ["ses_2", text("c")],
    ["ses_1", text("d")],
    ["ses_1", { type: "turn-end" }],
  ]);
  // Past a chunk, a new event starts.
  expect(events.slice(4).map(([, e]) => (e.type === "text" ? e.delta : ""))).toEqual(["x".repeat(20_000) + "y".repeat(12_000), "y".repeat(8_000)]);
  expect(seqs(sockets[0]!.received)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a full backlog ends the sessions once, keeps only errors, and recovers below half", async () => {
  const { server, sockets } = await holdingServer();
  let full = 0;
  const conn = new Connection({
    server,
    token: "tok",
    seqPath: await seqFile(),
    hello,
    onMessage: () => {},
    backoff: { initialMs: 10, maxMs: 50 },
    backlog: { maxEvents: 10, maxBytes: 1024 * 1024 },
    onBacklogFull: () => {
      full++;
      conn.emit("ses_1", { type: "error", message: "Dispand unreachable: the runner's backlog is full" });
    },
  });
  cleanup.push(() => conn.close());
  // One delta per session: nothing folds.
  for (let i = 0; i < 15; i++) conn.emit(`ses_t${i}`, text(`t${i}`));
  expect(full).toBe(1);
  expect(conn.backlogFull).toBe(true);
  expect(conn.unackedCount).toBe(11);
  conn.emit("ses_2", { type: "error", message: "boom" });
  expect(conn.unackedCount).toBe(12);

  conn.start();
  await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toHaveLength(12));
  const last = sockets[0]!.received.at(-2);
  expect(last).toMatchObject({ event: { type: "error", message: "Dispand unreachable: the runner's backlog is full" } });
  sockets[0]!.ack(5);
  await vi.waitFor(() => expect(conn.unackedCount).toBe(7));
  expect(conn.backlogFull).toBe(true);
  sockets[0]!.ack(8);
  await vi.waitFor(() => expect(conn.backlogFull).toBe(false));
  conn.emit("ses_1", text("back"));
  expect(conn.unackedCount).toBe(5);
});

test("a delta never joins one that already went out, even after the connection dropped", async () => {
  const { server, sockets } = await holdingServer();
  // A slow reconnect, so the next delta comes while disconnected.
  const conn = new Connection({ server, token: "tok", seqPath: await seqFile(), hello, onMessage: () => {}, backoff: { initialMs: 300, maxMs: 300 } });
  cleanup.push(() => conn.close());
  conn.start();
  conn.emit("ses_1", text("first"));
  await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toEqual([1]));
  // Dropped before the ack: the server may well have handled seq 1 already.
  sockets[0]!.drop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // "first" isn't acked: "second" waits, and gets its seq within a second.
  conn.emit("ses_1", text("second"));
  await vi.waitFor(() => expect(seqs(sockets[1]!.received)).toEqual([1, 2]), { timeout: 3000 });
  expect(sockets[1]!.received.slice(1)).toEqual([
    { type: "event", seq: 1, sessionId: "ses_1", event: text("first") },
    { type: "event", seq: 2, sessionId: "ses_1", event: text("second") },
  ]);
});

/** A server that acks each event `delayMs` after the one before, one at a time, as the hub handles them. */
async function slowServer(delayMs: number) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  cleanup.push(() => new Promise((resolve) => wss.close(resolve)));
  const received: Extract<RunnerToServer, { type: "event" }>[] = [];
  wss.on("connection", (ws) => {
    let handled = Promise.resolve();
    ws.on("message", (data) => {
      const msg = parseRunnerMessage(String(data));
      if (msg.type !== "event") return;
      received.push(msg);
      handled = handled.then(() => new Promise((resolve) => setTimeout(resolve, delayMs))).then(() => ws.send(JSON.stringify({ type: "ack", seq: msg.seq })));
    });
  });
  return { server: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, received };
}

const textOf = (received: RunnerToServer[], sessionId: string) =>
  received.flatMap((m) => (m.type === "event" && m.sessionId === sessionId && m.event.type === "text" ? [m.event.delta] : [])).join("");

test("a slow server gets one text event per session per round trip, however many deltas stream", async () => {
  const { server, received } = await slowServer(50);
  const conn = connect(server, await seqFile());
  const sent: Record<string, string> = { ses_1: "", ses_2: "" };
  const started = performance.now();
  // Two sessions streaming 400 deltas each, interleaved, faster than the server acks.
  for (let i = 0; i < 400; i++) {
    for (const id of ["ses_1", "ses_2"]) {
      sent[id] += `${id}:${i} `;
      conn.emit(id, text(`${id}:${i} `));
    }
    if (i % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  conn.emit("ses_1", { type: "turn-end" });
  conn.emit("ses_2", { type: "turn-end" });
  await vi.waitFor(() => expect(received.filter((m) => m.event.type === "turn-end")).toHaveLength(2), { timeout: 5000 });
  const elapsed = performance.now() - started;
  // Every character once, in order, each session's text apart from the other's.
  expect(textOf(received, "ses_1")).toBe(sent.ses_1);
  expect(textOf(received, "ses_2")).toBe(sent.ses_2);
  // A round trip takes at least 50 ms: at most one text event per session for each, not one per delta.
  const texts = received.filter((m) => m.event.type === "text").length;
  expect(texts).toBeLessThanOrEqual(2 * (Math.ceil(elapsed / 50) + 1));
  expect(texts).toBeLessThan(800 / 10);
});

test("a session's other events never overtake its held text, and don't wait behind it", async () => {
  const { server, sockets } = await holdingServer();
  const conn = connect(server, await seqFile());
  conn.emit("ses_1", text("a"));
  await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toEqual([1]));
  // "a" isn't acked: ses_1's text waits, without a seq; ses_2's first text goes out.
  conn.emit("ses_1", text("b"));
  conn.emit("ses_2", text("x"));
  conn.emit("ses_1", text("c"));
  conn.emit("ses_2", text("y"));
  // A tool call goes out at once, right behind the text streamed before it.
  conn.emit("ses_1", { type: "tool", name: "Read", status: "started" });
  conn.emit("ses_1", text("d"));
  await vi.waitFor(() => expect(seqs(sockets[0]!.received)).toEqual([1, 2, 3, 4]));
  // Once a session's text is acked, what it held goes out, even with its tool call still in flight.
  sockets[0]!.ack(3);
  await vi.waitFor(() => expect(seqs(sockets[0]!.received)).toEqual([1, 2, 3, 4, 5, 6]));
  conn.emit("ses_1", text("e"));
  conn.emit("ses_1", { type: "turn-end" });
  await vi.waitFor(() => expect(seqs(sockets[0]!.received)).toHaveLength(8));
  expect(sockets[0]!.received.flatMap((m) => (m.type === "event" ? [[m.seq, m.sessionId, m.event] as const] : []))).toEqual([
    [1, "ses_1", text("a")],
    [2, "ses_2", text("x")],
    [3, "ses_1", text("bc")],
    [4, "ses_1", { type: "tool", name: "Read", status: "started" }],
    [5, "ses_2", text("y")],
    [6, "ses_1", text("d")],
    [7, "ses_1", text("e")],
    [8, "ses_1", { type: "turn-end" }],
  ]);
});

test("a session's held text gets a seq at each chunk, so a flood still fills the backlog", async () => {
  const { server, sockets } = await holdingServer();
  let full = 0;
  const conn = new Connection({
    server, token: "tok", seqPath: await seqFile(), hello, onMessage: () => {}, backoff: { initialMs: 10, maxMs: 50 },
    backlog: { maxEvents: 10, maxBytes: 1024 * 1024 }, onBacklogFull: () => full++,
  });
  cleanup.push(() => conn.close());
  conn.start();
  conn.emit("ses_1", text("a"));
  await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toEqual([1]));
  // "a" is never acked: a session writing text as fast as it can doesn't pile it up unsequenced.
  for (let i = 0; i < 400; i++) conn.emit("ses_1", text("x".repeat(1000)));
  expect(full).toBe(1);
  expect(conn.backlogFull).toBe(true);
});

test("a reconnect in the middle of a fold sends every character once", async () => {
  const { server, sockets } = await holdingServer();
  const conn = connect(server, await seqFile());
  conn.emit("ses_1", text("a"));
  await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toEqual([1]));
  conn.emit("ses_1", text("b"));
  // Dropped before "a" is acked: the server may have handled it already.
  sockets[0]!.drop();
  conn.emit("ses_1", text("c"));
  await vi.waitFor(() => expect(seqs(sockets[1]?.received ?? [])).toContain(1));
  // "a" goes out again with its own seq, first.
  expect(sockets[1]!.received.slice(0, 2)).toEqual([{ ...hello(), lastSeq: 1 }, { type: "event", seq: 1, sessionId: "ses_1", event: text("a") }]);
  conn.emit("ses_1", text("d"));
  sockets[1]!.ack(1);
  // What a hub keeps across both connections (each seq once, in order, as hub.ts does): every character once.
  const handled = () => {
    let lastSeq = 0;
    let out = "";
    for (const m of sockets.flatMap((s) => s.received)) {
      if (m.type !== "event" || m.seq <= lastSeq) continue;
      lastSeq = m.seq;
      if (m.event.type === "text") out += m.event.delta;
    }
    return out;
  };
  await vi.waitFor(() => expect(handled()).toBe("abcd"), { timeout: 3000 });
});

describe("the backlog on disk", () => {
  async function paths() {
    const seqPath = await seqFile();
    return { seqPath, backlogPath: join(dirname(seqPath), "backlog.jsonl") };
  }
  const open = (server: string, p: { seqPath: string; backlogPath: string }) => {
    const conn = new Connection({ server, token: "tok", ...p, hello, onMessage: () => {}, backoff: { initialMs: 10, maxMs: 50 } });
    cleanup.push(() => conn.close());
    return conn;
  };

  test("a restarted runner sends what wasn't acked, with the same seqs, after hello; acked events are not sent again", async () => {
    const { server, sockets } = await holdingServer();
    const p = await paths();
    const first = open(server, p);
    first.start();
    first.emit("ses_1", text("a"));
    first.emit("ses_2", { type: "turn-end" });
    first.emit("ses_1", { type: "result", text: "done" });
    await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toEqual([1, 2, 3]));
    sockets[0]!.ack(1);
    await vi.waitFor(() => expect(first.unackedCount).toBe(2));
    first.close();
    expect(((await stat(p.backlogPath)).mode & 0o777).toString(8)).toBe("600");

    const second = open(server, p);
    expect(second.unackedCount).toBe(2);
    second.start();
    await vi.waitFor(() => expect(seqs(sockets[1]?.received ?? [])).toEqual([2, 3]));
    expect(sockets[1]!.received).toEqual([
      { ...hello(), lastSeq: 3 },
      { type: "event", seq: 2, sessionId: "ses_2", event: { type: "turn-end" } },
      { type: "event", seq: 3, sessionId: "ses_1", event: { type: "result", text: "done" } },
    ]);
    second.emit("ses_1", text("next"));
    await vi.waitFor(() => expect(seqs(sockets[1]!.received)).toHaveLength(3));
    expect(seqs(sockets[1]!.received)[2]).toBeGreaterThan(3);
  });

  test("a coalesced delta is replayed as last written; a corrupt last line is dropped, not blocking", async () => {
    const { server, sockets } = await holdingServer();
    const p = await paths();
    const first = open(server, p);
    first.emit("ses_1", text("a"));
    first.emit("ses_1", text("b"));
    first.close();
    await appendFile(p.backlogPath, '{"type":"event","seq":2,"sess');
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = open(server, p);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("dropped 1 unreadable line"));
    second.start();
    await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toEqual([1]));
    expect(sockets[0]!.received[1]).toEqual({ type: "event", seq: 1, sessionId: "ses_1", event: text("ab") });
  });

  test("acks shrink the file: it is rewritten once it is over twice the pending events", async () => {
    const { server, sockets } = await holdingServer();
    const p = await paths();
    const conn = open(server, p);
    conn.start();
    for (let i = 0; i < 10; i++) conn.emit(`ses_t${i}`, text(`t${i}`.padEnd(3000, ".")));
    await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toHaveLength(10));
    const lines = async () => (await readFile(p.backlogPath, "utf8")).split("\n").filter(Boolean).length;
    // The last delta reaches the file with the next batch.
    await vi.waitFor(async () => expect(await lines()).toBe(10), { timeout: 3000 });
    sockets[0]!.ack(8);
    await vi.waitFor(() => expect(conn.unackedCount).toBe(2));
    expect(await lines()).toBe(2);
  });

  test("coalescing a long outage's deltas keeps the file near the pending size", async () => {
    const { server } = await holdingServer();
    const p = await paths();
    const conn = open(server, p);
    // Never connected: 32,000 one-character deltas coalesce into one event, rewritten each time.
    for (let i = 0; i < 32_000; i++) conn.emit("ses_1", text("x"));
    expect(conn.unackedCount).toBe(1);
    const pending = Buffer.byteLength(JSON.stringify({ type: "event", seq: 1, sessionId: "ses_1", event: text("x".repeat(32_000)) })) + 1;
    expect((await stat(p.backlogPath)).size).toBeLessThanOrEqual(2 * pending);
  });

  test("a runner restarted with a backlog past half its limits refuses new sessions until it drains", async () => {
    const { server, sockets } = await holdingServer();
    const p = await paths();
    const backlog = { maxEvents: 10, maxBytes: 1024 * 1024 };
    const first = new Connection({ server, token: "tok", ...p, hello, onMessage: () => {}, backoff: { initialMs: 10, maxMs: 50 }, backlog });
    for (let i = 0; i < 6; i++) first.emit(`ses_t${i}`, text(`t${i}`));
    expect(first.backlogFull).toBe(false);
    first.close();

    const second = new Connection({ server, token: "tok", ...p, hello, onMessage: () => {}, backoff: { initialMs: 10, maxMs: 50 }, backlog });
    cleanup.push(() => second.close());
    expect(second.backlogFull).toBe(true);
    second.start();
    await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toHaveLength(6));
    sockets[0]!.ack(2);
    await vi.waitFor(() => expect(second.backlogFull).toBe(false));
  });

  test("a torn tail is dropped on load, so an event appended after it survives the next restart", async () => {
    const { server, sockets } = await holdingServer();
    const p = await paths();
    const first = open(server, p);
    first.emit("ses_1", { type: "turn-end" });
    first.close();
    await appendFile(p.backlogPath, '{"type":"event","seq":2,"sess');
    vi.spyOn(console, "error").mockImplementation(() => {});
    const second = open(server, p);
    second.emit("ses_2", { type: "result", text: "kept" });
    second.close();
    const third = open(server, p);
    third.start();
    await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toHaveLength(2));
    expect(sockets[0]!.received.slice(1)).toEqual([
      { type: "event", seq: 1, sessionId: "ses_1", event: { type: "turn-end" } },
      { type: "event", seq: expect.any(Number), sessionId: "ses_2", event: { type: "result", text: "kept" } },
    ]);
    expect(seqs(sockets[0]!.received)[1]).toBeGreaterThan(1);
  });

  test("an event goes out only once the seq checkpoint on disk covers it", async () => {
    const p = await paths();
    // A server that reads the checkpoint the moment each event arrives.
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => wss.once("listening", resolve));
    cleanup.push(() => new Promise((resolve) => wss.close(resolve)));
    const seen: [number, number][] = [];
    wss.on("connection", (ws) =>
      ws.on("message", (data) => {
        const msg = parseRunnerMessage(String(data));
        if (msg.type === "event") seen.push([msg.seq, (JSON.parse(readFileSync(p.seqPath, "utf8")) as { seq: number }).seq]);
      }),
    );
    const conn = open(`http://127.0.0.1:${(wss.address() as AddressInfo).port}`, p);
    conn.start();
    for (let i = 0; i < 1500; i++) conn.emit(`ses_t${i}`, text(`t${i}`));
    await vi.waitFor(() => expect(seen).toHaveLength(500));
    expect(seen.every(([seq, checkpoint]) => checkpoint >= seq)).toBe(true);
    // A restart goes on past the checkpoint: no seq is reused.
    conn.close();
    const again = open(`http://127.0.0.1:${(wss.address() as AddressInfo).port}`, { ...p, backlogPath: join(dirname(p.seqPath), "other.jsonl") });
    again.emit("ses_1", { type: "turn-end" });
    again.start();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(500));
    expect(seen.at(-1)![0]).toBeGreaterThan(1500);
  });

  test("coalesced deltas reach the disk in batches, not on every merge", async () => {
    const { server, sockets } = await holdingServer();
    const p = await paths();
    const conn = open(server, p);
    // Opening rewrites the (empty) file once: count from there.
    const base = conn.backlogStats;
    const since = () => {
      const now = conn.backlogStats;
      return { appends: now.appends - base.appends, bytes: now.bytes - base.bytes, fsyncs: now.fsyncs - base.fsyncs };
    };
    for (let i = 0; i < 32_000; i++) conn.emit("ses_1", text("x"));
    // Nothing yet: the merged delta is written by the 1 s batch, or when another event seals it.
    expect(since()).toEqual({ appends: 0, bytes: 0, fsyncs: 0 });
    conn.emit("ses_1", { type: "turn-end" });
    expect(since().appends).toBe(2);
    for (let i = 0; i < 32_000; i++) conn.emit("ses_2", text("y"));
    await vi.waitFor(() => expect(since().appends).toBe(3), { timeout: 3000 });
    const stats = since();
    expect(stats.appends).toBeLessThanOrEqual(50);
    expect(stats.fsyncs).toBeLessThanOrEqual(50);
    expect(stats.bytes).toBeLessThan(200_000);
    conn.close();
    // Everything is there after a restart.
    const again = open(server, p);
    again.start();
    await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toHaveLength(3));
    expect(sockets[0]!.received.slice(1).map((m) => (m.type === "event" ? m.event.type : ""))).toEqual(["text", "turn-end", "text"]);
  });

  test("held text reaches the file within a second, and closing writes the rest: a restart sends every character once", async () => {
    const { server, sockets } = await holdingServer();
    const p = await paths();
    const first = open(server, p);
    first.start();
    first.emit("ses_1", text("a"));
    first.emit("ses_2", text("x"));
    await vi.waitFor(() => expect(seqs(sockets[0]?.received ?? [])).toEqual([1, 2]));
    // A server that never acks: what waits gets its seq within a second, and goes on disk.
    first.emit("ses_1", text("b"));
    first.emit("ses_2", text("y"));
    await vi.waitFor(async () => expect(await readFile(p.backlogPath, "utf8")).toMatch(/"delta":"b".*\n.*"delta":"y"/s), { timeout: 3000 });
    first.emit("ses_1", text("c"));
    first.emit("ses_2", text("z"));
    first.close();

    const second = open(server, p);
    expect(second.unackedCount).toBe(6);
    second.start();
    await vi.waitFor(() => expect(seqs(sockets[1]?.received ?? [])).toEqual([1, 2, 3, 4, 5, 6]));
    expect(textOf(sockets[1]!.received, "ses_1")).toBe("abc");
    expect(textOf(sockets[1]!.received, "ses_2")).toBe("xyz");
  });
});

test("a stalled upgrade times out and the connection tries again", async () => {
  const { createServer: tcp } = await import("node:net");
  let attempts = 0;
  const open: import("node:net").Socket[] = [];
  // Accepts the TCP connection and never answers the upgrade.
  const server = tcp((socket) => {
    attempts++;
    open.push(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    for (const socket of open) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const conn = new Connection({
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: "t",
    seqPath: await seqFile(),
    hello,
    onMessage: () => {},
    backoff: { initialMs: 10, maxMs: 20 },
    handshakeTimeoutMs: 200,
  });
  cleanup.push(() => conn.close());
  conn.start();
  await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(3), { timeout: 5000 });
});

test("while the backlog is full, each session gets one error at most: the rest is dropped", async () => {
  const { server } = await holdingServer();
  const conn = new Connection({
    server,
    token: "tok",
    seqPath: await seqFile(),
    hello,
    onMessage: () => {},
    backlog: { maxEvents: 10, maxBytes: 1024 * 1024 },
    onBacklogFull: () => {
      for (const id of ["ses_1", "ses_2", "ses_3"]) conn.emit(id, { type: "error", message: "Dispand unreachable: the runner's backlog is full" });
    },
  });
  cleanup.push(() => conn.close());
  for (let i = 0; i < 11; i++) conn.emit(`ses_t${i}`, text(`t${i}`));
  expect(conn.backlogFull).toBe(true);
  expect(conn.unackedCount).toBe(13);
  // Whatever keeps coming for those sessions, errors included, is dropped.
  for (let i = 0; i < 10_000; i++) conn.emit(`ses_${(i % 3) + 1}`, { type: "error", message: `again ${i}` });
  expect(conn.unackedCount).toBe(13);
});

test("while the backlog is full, errors in total are capped: fresh session ids don't get past it", async () => {
  const { server } = await holdingServer();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const conn = new Connection({ server, token: "tok", seqPath: await seqFile(), hello, onMessage: () => {}, backlog: { maxEvents: 10, maxBytes: 1024 * 1024 } });
  cleanup.push(() => conn.close());
  for (let i = 0; i < 11; i++) conn.emit(`ses_t${i}`, text(`t${i}`));
  expect(conn.backlogFull).toBe(true);
  // A hub that keeps starting new sessions while nothing is acked: each refusal is an error for a new id.
  for (let i = 0; i < 10_000; i++) conn.emit(`ses_new_${i}`, { type: "error", message: "refused: backlog full" });
  expect(conn.unackedCount).toBeLessThanOrEqual(10 + MAX_FULL_ERRORS);
  expect(conn.unackedCount).toBe(10 + MAX_FULL_ERRORS);
});

test("the terminal errors of every session live when the backlog fills are kept, past the error cap", async () => {
  const { server } = await holdingServer();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const conn = new Connection({
    server,
    token: "tok",
    seqPath: await seqFile(),
    hello,
    onMessage: () => {},
    backlog: { maxEvents: 10, maxBytes: 1024 * 1024 },
    // 500 live sessions, each stopped with its terminal error.
    onBacklogFull: () => {
      for (let i = 0; i < 500; i++) conn.emit(`ses_live_${i}`, { type: "error", message: "Dispand unreachable: the runner's backlog is full" });
    },
  });
  cleanup.push(() => conn.close());
  for (let i = 0; i < 11; i++) conn.emit(`ses_t${i}`, text(`t${i}`));
  expect(conn.unackedCount).toBe(10 + 500);
  // Refusals of new starts afterwards: MAX_FULL_ERRORS of them, no more.
  for (let i = 0; i < 10_000; i++) conn.emit(`ses_new_${i}`, { type: "error", message: "refused: backlog full" });
  expect(conn.unackedCount).toBe(10 + 500 + MAX_FULL_ERRORS);
});
