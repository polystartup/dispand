import { RunnerUpdates } from "./updates.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  type HarnessEvent,
  parseRunnerMessage,
  PROTOCOL_VERSION,
  type RunnerToServer,
  type ServerToRunner,
} from "@dispand/runner-protocol";
import { eq } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";
import type { Db } from "../db/client.ts";
import { runners } from "../db/schema.ts";
import { errorKind, logError } from "../log.ts";
import { emitLog, meter, recordError, tracer } from "../telemetry/index.ts";

const traces = tracer("runners");
const counts = meter("runners");
/** How a runner's connection attempt ended. */
const connected = (result: string) => counts.counter("dispand.runner.connections").add(1, { "dispand.result": result });
import { findRunnerByToken } from "./pairing.ts";
import { refuseUpgrade, RUNNER_WS_PATH, upgradePath } from "./upgrade.ts";

type EventHandler = (runnerId: string, sessionId: string, event: HarnessEvent, seq: number) => Promise<void>;
/**
 * Called once per connection, when the hub has handled every event the runner sent before its
 * `hello` (up to `hello.lastSeq`): `liveSessions` is what the runner still runs. The runner is
 * ready (sends go out) from then on. A failure ends the connection, so the next `hello` retries.
 */
type CaughtUpHandler = (runnerId: string, liveSessions: string[]) => Promise<void>;

// Bounds on what one runner can make the server hold, over all its connections: a larger frame
// closes its connection (1009), and so does sending faster than its events are handled, past these
// many messages or bytes waiting (1008). What was waiting is dropped, and so is what a replaced
// connection had waiting: the runner resends its unacked events on reconnect.
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PENDING_MESSAGES = 1000;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

type CommandsRequest = Extract<ServerToRunner, { type: "commands.request" }>;
type CommandsReply = Extract<RunnerToServer, { type: "commands.replied" }>;
type ModelsRequest = Extract<ServerToRunner, { type: "models.request" }>;
type ModelsReply = Extract<RunnerToServer, { type: "models.replied" }>;
type PluginRequest = Extract<ServerToRunner, { type: "plugin.request" }>;
type PluginReply = Extract<RunnerToServer, { type: "plugin.replied" }>;
type Discover = Extract<ServerToRunner, { type: "tool.discover" }>;
type Discovered = Extract<RunnerToServer, { type: "tool.discovered" }>;
type Call = Extract<ServerToRunner, { type: "tool.call" }>;
type Called = Extract<RunnerToServer, { type: "tool.called" }>;
/** A `request` waiting for its reply, from that runner only. */
type Waiting = { runnerId: string; type: "tool.discovered" | "tool.called" | "plugin.replied" | "models.replied" | "commands.replied"; resolve: (reply: Discovered | Called | PluginReply | ModelsReply | CommandsReply) => void; reject: (err: Error) => void };

/** Why `request` got no reply. */
export class RunnerRequestFailed extends Error {
  override name = "RunnerRequestFailed";
}

type Connection = {
  ws: WebSocket;
  runnerId: string;
  ownerId: string;
  /** Set once caught up after the runner's `hello`: messages flow only after it. */
  ready: boolean;
  /** From `hello` until caught up: the seq to reach and the sessions the runner reported. */
  catchUp?: { lastSeq: number; liveSessions: string[] };
  /** Ended (see `retire`): whatever else arrives is dropped. */
  retired: boolean;
};

type Pending = { conn: Connection; raw: string; bytes: number };

/** Per runner, kept across reconnects so a new connection can't overtake the old one. */
type RunnerState = {
  /** Highest seq handled and acked (mirrors `runners.last_seq`). */
  lastSeq: number;
  /**
   * Received from any of its connections, not handled yet. One drain loop handles them one at a
   * time, in order; dropping a connection's messages filters them out, and nothing else holds them.
   */
  pending: Pending[];
  pendingBytes: number;
  draining: boolean;
};

/**
 * Holds the runners' WebSocket connections. It delivers only to a connected runner: `send` says
 * whether the message was written, and keeps nothing for later. A connection is ready once
 * caught up after its `hello`; then the engine re-sends what wasn't delivered (`onCaughtUp`).
 */
export class RunnerHub {
  readonly updates = new RunnerUpdates();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  private readonly connections = new Map<string, Connection>();
  private readonly connectionOf = new WeakMap<WebSocket, Connection>();
  private readonly states = new Map<string, RunnerState>();
  /** Revoked in this process: refused even when an upgrade read the token before the revoke. */
  private readonly revoked = new Set<string>();
  /** Set by `close()`: no runner gets in any more. */
  private closing = false;
  private handler: EventHandler = async () => {};
  private caughtUpHandler: CaughtUpHandler = async () => {};
  /** `request`s waiting for their reply, by request id. */
  private readonly waiting = new Map<string, Waiting>();
  /** Last-seen writes of ended connections, until they settle: `close()` waits for them. */
  private readonly lastSeenWrites = new Set<Promise<unknown>>();

  constructor(private readonly db: Db) {}

  /**
   * Accepts a `/runner/ws` upgrade carrying `Authorization: Bearer <token>`; anything else is
   * refused. Never throws, and every path leaves the socket with an error listener.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Until `ws` takes the socket over, nothing else listens: a client reset would crash the process.
    socket.on("error", () => socket.destroy());
    try {
      const path = upgradePath(req);
      if (path === null) return refuseUpgrade(socket, 400);
      if (path !== RUNNER_WS_PATH) return refuseUpgrade(socket, 404);
      const refused = this.refusal();
      if (refused) return connected("refused"), refuseUpgrade(socket, refused);
      this.accept(req, socket, head).catch((err: unknown) => {
        logError("runner upgrade failed", err);
        refuseUpgrade(socket, 500);
      });
    } catch (err) {
      logError("runner upgrade failed", err);
      refuseUpgrade(socket, 500);
    }
  }

  /** Writes to the runner's ready connection: true once written, false if it has none or the write fails. */
  async send(runnerId: string, msg: ServerToRunner): Promise<boolean> {
    const conn = this.connections.get(runnerId);
    if (!conn?.ready) return false;
    try {
      await this.write(conn.ws, msg);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends `msg` to the runner's ready connection and waits for its reply (same `requestId`, from
   * that runner). Rejects with `RunnerRequestFailed`: "runner offline" when it has no ready
   * connection or loses it meanwhile, "timed out" past `timeoutMs`.
   */
  request(runnerId: string, msg: Discover, timeoutMs = 45_000): Promise<Discovered> {
    return this.ask(runnerId, msg, timeoutMs) as Promise<Discovered>;
  }

  /**
   * Calls one action of the runner's tool, for a poll (the runner checks it may): as `request`.
   * Traced and counted by outcome (`ok`, `error` for an action that reported one, `refused` for a
   * call the runner declined, `failed` when it is offline or timed out); never the arguments or the result.
   */
  call(runnerId: string, msg: Call, timeoutMs = 45_000): Promise<Called> {
    return traces.startActiveSpan("runner.tool_call", { attributes: { "dispand.runner.id": runnerId, "dispand.request.id": msg.requestId } }, async (span) => {
      const started = performance.now();
      let result = "failed";
      try {
        const reply = (await this.ask(runnerId, msg, timeoutMs)) as Called;
        result = reply.error !== undefined ? "refused" : reply.isError ? "error" : "ok";
        return reply;
      } catch (err) {
        recordError(span, errorKind(err));
        throw err;
      } finally {
        span.setAttribute("dispand.result", result);
        span.end();
        counts.counter("dispand.runner.tool_calls").add(1, { "dispand.result": result });
        counts.histogram("dispand.runner.tool_call.duration", { unit: "ms", description: "From a poll's call to the runner's reply" }).record(performance.now() - started, { "dispand.result": result });
      }
    });
  }

  /** Catalog discovery is correlated to its runner and never replayed. */
  commands(runnerId: string, msg: CommandsRequest): Promise<CommandsReply> {
    return traces.startActiveSpan("runner.commands", { attributes: { "dispand.runner.id": runnerId } }, async (span) => {
      let result = "failed";
      try {
        const reply = await this.ask(runnerId, msg, 25_000) as CommandsReply;
        result = reply.error ? "error" : "ok";
        return reply;
      } catch (err) {
        recordError(span, errorKind(err));
        throw err;
      } finally {
        span.setAttribute("dispand.result", result);
        span.end();
        counts.counter("dispand.runner.command_lists").add(1, { "dispand.result": result });
        emitLog("runners", result === "ok" ? "info" : "warn", "command discovery completed", { "dispand.runner.id": runnerId, "dispand.result": result });
      }
    });
  }

  models(runnerId: string, msg: ModelsRequest): Promise<ModelsReply> {
    return traces.startActiveSpan("runner.models", { attributes: { "dispand.runner.id": runnerId } }, async (span) => {
      let result = "failed";
      try {
        const reply = await this.ask(runnerId, msg, 25_000) as ModelsReply;
        result = reply.error ? "error" : "ok";
        return reply;
      } catch (err) {
        recordError(span, errorKind(err));
        throw err;
      } finally {
        span.setAttribute("dispand.result", result);
        span.end();
        counts.counter("dispand.runner.model_lists").add(1, { "dispand.result": result });
        emitLog("runners", result === "ok" ? "info" : "warn", "model discovery completed", { "dispand.runner.id": runnerId, "dispand.result": result });
      }
    });
  }

  /** Native plugin operations are never replayed after a disconnect or timeout. */
  plugins(runnerId: string, msg: PluginRequest): Promise<PluginReply> {
    return traces.startActiveSpan("runner.plugins", { attributes: { "dispand.runner.id": runnerId } }, async (span) => {
      let result = "failed";
      try {
        const reply = await this.ask(runnerId, msg, 135_000) as PluginReply;
        result = reply.report.error ? "error" : "ok";
        return reply;
      } catch (err) {
        recordError(span, errorKind(err));
        throw err;
      } finally {
        span.setAttribute("dispand.result", result);
        span.end();
        counts.counter("dispand.runner.plugin_operations").add(1, { "dispand.result": result });
        emitLog("runners", result === "ok" ? "info" : "warn", "native plugin operation completed", { "dispand.runner.id": runnerId, "dispand.result": result });
      }
    });
  }

  private ask(runnerId: string, msg: Discover | Call | PluginRequest | ModelsRequest | CommandsRequest, timeoutMs: number): Promise<Discovered | Called | PluginReply | ModelsReply | CommandsReply> {
    if (this.waiting.has(msg.requestId)) return Promise.reject(new RunnerRequestFailed("duplicate request id"));
    const reply = new Promise<Discovered | Called | PluginReply | ModelsReply | CommandsReply>((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new RunnerRequestFailed("timed out"))), timeoutMs);
      const settle = (done: () => void) => {
        clearTimeout(timer);
        this.waiting.delete(msg.requestId);
        done();
      };
      this.waiting.set(msg.requestId, {
        runnerId,
        type: msg.type === "commands.request" ? "commands.replied" : msg.type === "models.request" ? "models.replied" : msg.type === "plugin.request" ? "plugin.replied" : msg.type === "tool.call" ? "tool.called" : "tool.discovered",
        resolve: (r) => settle(() => resolve(r)),
        reject: (err) => settle(() => reject(err)),
      });
    });
    // Not awaited: a write stalled by backpressure must not hold the caller past the timeout.
    void this.send(runnerId, msg).then((written) => {
      if (!written) this.waiting.get(msg.requestId)?.reject(new RunnerRequestFailed("runner offline"));
    });
    return reply;
  }

  onEvent(handler: EventHandler): void {
    this.handler = handler;
  }

  onCaughtUp(handler: CaughtUpHandler): void {
    this.caughtUpHandler = handler;
  }

  isOnline(runnerId: string): boolean {
    return this.connections.get(runnerId)?.ready ?? false;
  }

  /**
   * Ends every runner socket, mapped or not (a replaced one may still be closing): the app is
   * shutting down, and runners reconnect to the next process. Resolves once their last-seen times
   * are written, so the database can close after.
   */
  async close(): Promise<void> {
    this.closing = true;
    for (const ws of this.wss.clients) {
      const conn = this.connectionOf.get(ws);
      if (conn) this.retire(conn, 1001, "server shutting down");
    }
    await Promise.all(this.lastSeenWrites);
  }

  /** Ends a revoked runner's connection; it can't connect again. */
  disconnect(runnerId: string): void {
    this.revoked.add(runnerId);
    const conn = this.connections.get(runnerId);
    if (conn) this.retire(conn, 4001, "revoked");
  }

  /**
   * The one admission rule, checked before the token lookup, after it (a revoke or a close can
   * happen while it runs), right before attaching, and for every message: why a runner can't be
   * in, or null if it can.
   */
  private refusal(runnerId?: string): 401 | 503 | null {
    if (this.closing) return 503;
    if (runnerId !== undefined && this.revoked.has(runnerId)) return 401;
    return null;
  }

  private async accept(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const [scheme, token] = (req.headers.authorization ?? "").split(" ");
    const runner = scheme === "Bearer" && token ? await findRunnerByToken(this.db, token) : null;
    if (!runner) return connected("unauthorized"), refuseUpgrade(socket, 401);
    const refused = this.refusal(runner.id);
    if (refused) return connected("refused"), refuseUpgrade(socket, refused);
    const protocol = req.headers["dispand-protocol"];
    if (typeof protocol === "string" && /^[0-9]{1,9}$/.test(protocol) && Number(protocol) < PROTOCOL_VERSION) {
      // An older runner: Settings shows it as outdated, with the command that updates it.
      await this.db.update(runners).set({ protocolVersion: Number(protocol) }).where(eq(runners.id, runner.id));
      connected("outdated");
      return refuseUpgrade(socket, 426, "update the runner");
    }
    if (protocol !== String(PROTOCOL_VERSION)) return connected("bad-protocol"), refuseUpgrade(socket, 400);
    connected("accepted");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, runner));
  }

  private attach(ws: WebSocket, runner: { id: string; ownerId: string; lastSeq: number }) {
    const conn: Connection = { ws, runnerId: runner.id, ownerId: runner.ownerId, ready: false, retired: false };
    this.connectionOf.set(ws, conn);
    // A malformed frame (unmasked, bad opcode…) makes `ws` emit `error` (without a listener it would
    // crash the process) and close the socket itself.
    ws.on("error", () => this.retire(conn));
    ws.on("close", () => this.retire(conn));
    // `ws` may complete the handshake later than the check above: check once more.
    if (this.refusal(runner.id)) return this.retire(conn, 1008, "refused");
    // The database's last_seq only counts on the first connection since the app started: later,
    // an older connection may still be handling an event, and its result is in memory first.
    let state = this.states.get(runner.id);
    if (!state) {
      state = { lastSeq: runner.lastSeq, pending: [], pendingBytes: 0, draining: false };
      this.states.set(runner.id, state);
    }
    const runnerState = state;
    const replaced = this.connections.get(runner.id);
    if (replaced) this.retire(replaced, 4000, "replaced by a new connection");
    this.connections.set(runner.id, conn);
    ws.on("message", (data) => {
      if (conn.retired) return;
      const raw = String(data);
      const bytes = Buffer.byteLength(raw);
      if (runnerState.pending.length >= MAX_PENDING_MESSAGES || runnerState.pendingBytes + bytes > MAX_PENDING_BYTES) {
        return this.retire(conn, 1008, "too many pending messages");
      }
      runnerState.pending.push({ conn, raw, bytes });
      runnerState.pendingBytes += bytes;
      this.drain(runnerState).catch((err: unknown) => logError("runner inbox failed", err, { runnerId: runner.id }));
    });
  }

  /** The runner's one drain loop: takes the next pending message and handles it, until none is left. */
  private async drain(state: RunnerState) {
    if (state.draining) return;
    state.draining = true;
    try {
      for (let next = state.pending.shift(); next; next = state.pending.shift()) {
        state.pendingBytes -= next.bytes;
        await this.receive(next.conn, state, next.raw);
      }
    } finally {
      state.draining = false;
    }
  }

  /**
   * The only way a connection ends, whatever the reason (socket closed, replaced, revoked, flood,
   * server error, shutdown): it leaves `connections`, its queued messages are dropped (the one in
   * flight finishes; the runner resends what wasn't acked), and its socket is closed with `code`,
   * then terminated after a second if the close handshake doesn't finish.
   */
  private retire(conn: Connection, code?: number, reason?: string) {
    if (!conn.retired) {
      conn.retired = true;
      counts.counter("dispand.runner.disconnects").add(1);
      if (this.connections.get(conn.runnerId) === conn) {
        this.connections.delete(conn.runnerId);
        // Its replies can't come any more.
        for (const w of [...this.waiting.values()]) if (w.runnerId === conn.runnerId) w.reject(new RunnerRequestFailed("runner offline"));
        const write = this.db
          .update(runners)
          .set({ lastSeenAt: new Date() })
          .where(eq(runners.id, conn.runnerId))
          .catch((err: unknown) => logError("runner last seen update failed", err, { runnerId: conn.runnerId }))
          .finally(() => this.lastSeenWrites.delete(write));
        this.lastSeenWrites.add(write);
      }
      const state = this.states.get(conn.runnerId);
      if (state) {
        state.pending = state.pending.filter((p) => p.conn !== conn);
        state.pendingBytes = state.pending.reduce((sum, p) => sum + p.bytes, 0);
      }
    }
    if (conn.ws.readyState === WebSocket.CLOSED) return;
    if (code !== undefined && conn.ws.readyState !== WebSocket.CLOSING) conn.ws.close(code, reason);
    setTimeout(() => {
      if (conn.ws.readyState !== WebSocket.CLOSED) conn.ws.terminate();
    }, 1000).unref();
  }

  private async receive(conn: Connection, state: RunnerState, raw: string) {
    // A retired connection stops: the runner resends what wasn't acked.
    if (conn.retired || conn.ws.readyState !== WebSocket.OPEN) return;
    if (this.refusal(conn.runnerId)) return;
    let msg: RunnerToServer;
    try {
      msg = parseRunnerMessage(raw);
    } catch {
      // A ProtocolError (its text may quote the message, so it isn't logged). The message is
      // dropped, not acked, and the connection stays: closing it would only bring the same message
      // back on reconnect. Postgres can't store some valid JSON (a NUL in a string), so this happens.
      return;
    }
    const type = msg.type === "event" ? `event.${msg.event.type}` : msg.type;
    counts.counter("dispand.runner.messages").add(1, { "dispand.message.type": type });
    // Streamed words are counted only; every other message is a span (the engine's work inside it).
    const handled = () => this.handle(conn, state, msg);
    try {
      await (msg.type === "event" && msg.event.type === "text"
        ? handled()
        : traces.startActiveSpan("runner.message", { attributes: { "dispand.runner.id": conn.runnerId, "dispand.message.type": type } }, async (span) => {
            try {
              await handled();
            } catch (err) {
              recordError(span, errorKind(err));
              throw err;
            } finally {
              span.end();
            }
          }));
    } catch (err) {
      // Not acked: the runner resends it after reconnecting.
      logError("runner message failed", err, { runnerId: conn.runnerId });
      this.retire(conn, 1011, "server error");
    }
  }

  private async handle(conn: Connection, state: RunnerState, msg: RunnerToServer) {
    if (msg.type === "hello") await this.hello(conn, msg);
    else if (msg.type === "tool.discovered" || msg.type === "tool.called" || msg.type === "plugin.replied" || msg.type === "models.replied" || msg.type === "commands.replied") this.reply(conn, msg);
    else await this.event(conn, state, msg);
    await this.catchUp(conn, state);
  }

  private async hello(conn: Connection, msg: Extract<RunnerToServer, { type: "hello" }>) {
    await this.db
      .update(runners)
      .set({ clis: msg.clis, tools: msg.tools, protocolVersion: PROTOCOL_VERSION, lastSeenAt: new Date() })
      .where(eq(runners.id, conn.runnerId));
    conn.catchUp = { lastSeq: msg.lastSeq, liveSessions: msg.liveSessions };
  }

  /** A reply resolves only a request of its kind sent to the runner that answers it. */
  private reply(conn: Connection, msg: Discovered | Called | PluginReply | ModelsReply | CommandsReply) {
    const w = this.waiting.get(msg.requestId);
    if (w?.runnerId === conn.runnerId && w.type === msg.type) w.resolve(msg);
  }

  /** Once the events sent before `hello` are handled: ready, then the caught-up handler. */
  private async catchUp(conn: Connection, state: RunnerState) {
    if (!conn.catchUp || state.lastSeq < conn.catchUp.lastSeq) return;
    const { liveSessions } = conn.catchUp;
    conn.catchUp = undefined;
    // Ready first: what the handler resends goes out now (the engine holds other deliveries until it is done).
    conn.ready = true;
    await this.caughtUpHandler(conn.runnerId, liveSessions);
  }

  private async event(conn: Connection, state: RunnerState, msg: Extract<RunnerToServer, { type: "event" }>) {
    if (msg.seq > state.lastSeq) {
      // The engine keeps what it needs (and drops replays itself): events aren't stored here.
      try {
        await this.handler(conn.runnerId, msg.sessionId, msg.event, msg.seq);
      } catch (err) {
        // Postgres refused the value itself (class 22, data exception): resending it would fail the
        // same way on every reconnect. Record the seq as handled and ack it; other errors (connection,
        // server) leave it unacked, so the runner resends it.
        if (!isDataError(err)) throw err;
        logError("runner event not storable, dropped", err, { runnerId: conn.runnerId });
      }
      await this.db.update(runners).set({ lastSeq: msg.seq }).where(eq(runners.id, conn.runnerId));
      state.lastSeq = msg.seq;
    }
    if (conn.ws.readyState === WebSocket.OPEN) await this.write(conn.ws, { type: "ack", seq: msg.seq });
  }

  private write(ws: WebSocket, msg: ServerToRunner): Promise<void> {
    return new Promise((resolve, reject) => ws.send(JSON.stringify(msg), (err) => (err ? reject(err) : resolve())));
  }
}

/** A Postgres data exception (SQLSTATE class 22), possibly wrapped by Drizzle. */
function isDataError(err: unknown): boolean {
  const source = (err instanceof Error && err.cause instanceof Error ? err.cause : err) as { code?: unknown } | null;
  return typeof source?.code === "string" && source.code.startsWith("22");
}

const globalForHub = globalThis as { __dispandRunnerHub?: RunnerHub };

/** The process's one hub, kept on `globalThis` so dev reloads of this module reuse it. */
export function getHub(db: Db): RunnerHub {
  return (globalForHub.__dispandRunnerHub ??= new RunnerHub(db));
}
