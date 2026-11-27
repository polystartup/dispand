import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { type HarnessEvent, parseServerMessage, PROTOCOL_VERSION, type RunnerToServer, type ServerToRunner } from "@dispand/runner-protocol";
import { WebSocket } from "ws";
import { BacklogFile } from "./backlog.ts";
import { writeDurable } from "./durable.ts";
import { protocolEvents, TEXT_CHUNK } from "./sanitize.ts";

/** The connection adds `lastSeq` itself. */
type Hello = Omit<Extract<RunnerToServer, { type: "hello" }>, "lastSeq">;

/**
 * While the backlog is full, besides the terminal error of each session live when it filled, at
 * most this many error events (one per session: refusals of new starts and the like) are kept.
 */
export const MAX_FULL_ERRORS = 100;

/** Coalesced text deltas reach the backlog file at most this late, and held text gets its seq at most this late. */
const FLUSH_MS = 1000;

/** How many seqs one checkpoint write reserves. */
const SEQ_BLOCK = 1000;

/** A ping this often, within the read timeout above 30 s `deploy/README.md` asks of a proxy. */
const PING_MS = 25_000;

/** In flight unacked at most: half the hub's 1000 messages and 8 MiB waiting per runner. */
export const WINDOW_MESSAGES = 500;
export const WINDOW_BYTES = 4 * 1024 * 1024;

export type ConnectionOptions = {
  /** The Dispand server's URL (`https://…`; `http://` dials `ws://`). */
  server: string;
  token: string;
  /** Where the last seq used is kept, so numbering goes on after a restart. */
  seqPath: string;
  /** Where unacked events are kept (`BacklogFile`), so a restarted runner sends them again. */
  backlogPath?: string;
  /** Built at each (re)connect, so it lists the sessions live at that moment (and reads what it reports then). */
  hello: () => Hello | Promise<Hello>;
  /** Every server message but acks, which the connection handles. */
  onMessage: (msg: Exclude<ServerToRunner, { type: "ack" }>) => void;
  /** A reconnect waits a random time up to `initialMs`, doubled by each attempt since the last catch-up, at most `maxMs` (default 1 s, 30 s). */
  backoff?: { initialMs: number; maxMs: number };
  /** How often it pings (default 25 s): a connection that read nothing since the last ping is ended. */
  pingMs?: number;
  /** How long an upgrade may take before the connection gives up and retries (default 15 s). */
  handshakeTimeoutMs?: number;
  /** The most kept unacked while Dispand is unreachable (default 20,000 events, 32 MiB). */
  backlog?: { maxEvents: number; maxBytes: number };
  /**
   * Called once when the backlog fills: the runner ends its sessions (their `error` events are
   * kept). Until it drains below half, only `error` events are kept and `backlogFull` is true.
   */
  onBacklogFull?: () => void;
  /** Called each time the connection to Dispand is lost: nothing that needs its word goes on meanwhile. */
  onDisconnect?: () => void;
};

function loadSeq(path: string): number {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { seq: number }).seq;
  } catch {
    return 0;
  }
}

/**
 * The runner's one WebSocket to `/runner/ws`. Events are made protocol-valid (`protocolEvents`)
 * and get a seq that keeps growing across restarts; each stays in memory until the server acks
 * it, and is sent again, oldest first, after the `hello` of the next connection. At most
 * `WINDOW_MESSAGES` events and `WINDOW_BYTES` are in flight unacked, half the hub's limits on
 * what waits for it. Pings every 25 s, ending a connection that read nothing since the last ping.
 * Reconnects after a random wait up to 1 s, doubling up to 30 s until a connection catches up; after
 * a hand-off it waits up to 1 s each time, as another process takes the runner.
 *
 * Streamed text is folded the way cloud sessions fold it: while a session has a text event the
 * server hasn't acked, its new text waits unsequenced and goes out as one event once that one is
 * acked, at most `FLUSH_MS` later, once it reaches a chunk, or right before the session's next
 * other event. A slow server then gets one text event per session per round trip (or second),
 * not one per streamed delta.
 */
export class Connection {
  private ws: WebSocket | undefined;
  private ready = false;
  private closed = false;
  private seq: number;
  /** The checkpoint on disk: every seq up to it may have been handed out. */
  private reserved: number;
  /** Oldest first; the first `sent` of them went out on the current connection. */
  /** `everSent`: written to some socket once, so its seq may be handled already and it can't change. */
  private readonly unacked: { seq: number; sessionId: string; event: HarnessEvent; raw: string; bytes: number; everSent: boolean }[] = [];
  private backlogBytes = 0;
  private full = false;
  /** Sessions whose one error was kept while the backlog is full. */
  private readonly fullErrors = new Set<string>();
  private droppedErrors = false;
  /** Errors kept while full that weren't a live session's terminal one. */
  private fullOthers = 0;
  /** True while `onBacklogFull` stops the live sessions. */
  private stoppingLive = false;
  private readonly backlog: { maxEvents: number; maxBytes: number };
  private sent = 0;
  private sentBytes = 0;
  private readonly backoff: { initialMs: number; maxMs: number };
  /** The most the next reconnect waits. */
  private delay: number;
  /** The current connection's `hello.lastSeq`: the hub acks an event past it only once caught up. */
  private helloSeq = Infinity;
  private timer: NodeJS.Timeout | undefined;

  private readonly options: ConnectionOptions;
  private readonly file: BacklogFile | undefined;
  /** The text delta being coalesced and not written yet, and the batch that will write it. */
  private dirty: Connection["unacked"][number] | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  /** Each session's latest text event not acked yet. */
  private readonly lastText = new Map<string, Connection["unacked"][number]>();
  /** Each session's text that has no seq yet: it waits for that session's text events to be acked. */
  private readonly held = new Map<string, string>();
  private holdTimer: NodeJS.Timeout | undefined;

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.seq = loadSeq(options.seqPath);
    this.reserved = this.seq;
    this.backoff = options.backoff ?? { initialMs: 1000, maxMs: 30_000 };
    this.delay = this.backoff.initialMs;
    this.backlog = options.backlog ?? { maxEvents: 20_000, maxBytes: 32 * 1024 * 1024 };
    if (options.backlogPath) {
      this.file = new BacklogFile(options.backlogPath, {
        // Each line ends with a newline.
        bytes: () => this.backlogBytes + this.unacked.length,
        raws: () => this.unacked.map((e) => e.raw),
      });
      // What a previous run left unacked goes out first, with its own seqs; it may have been sent already.
      for (const msg of this.file.load()) {
        const raw = JSON.stringify(msg);
        const bytes = Buffer.byteLength(raw);
        this.unacked.push({ seq: msg.seq, sessionId: msg.sessionId, event: msg.event, raw, bytes, everSent: true });
        this.backlogBytes += bytes;
        this.seq = Math.max(this.seq, msg.seq);
      }
      // Full until it drains below half, as if it had filled in this run: no session starts meanwhile.
      this.full = !this.drained();
    }
  }

  private drained(): boolean {
    return this.unacked.length < this.backlog.maxEvents / 2 && this.backlogBytes < this.backlog.maxBytes / 2;
  }

  get unackedCount(): number {
    return this.unacked.length;
  }

  /** True from the moment the backlog filled until it drains below half: no new session should start. */
  get backlogFull(): boolean {
    return this.full;
  }

  start(): void {
    const url = new URL("/runner/ws", this.options.server);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.options.token}`, "dispand-protocol": String(PROTOCOL_VERSION) },
      // A stalled upgrade fails, so the reconnect path takes over.
      handshakeTimeout: this.options.handshakeTimeoutMs ?? 15_000,
    });
    this.ws = ws;
    /** Its socket, and how much the socket had read at the last ping: a half-open connection sends nothing. */
    let socket: Socket | undefined;
    let read = 0;
    let pings: NodeJS.Timeout | undefined;
    /** Refused at the upgrade with 503 (`RunnerAdmission`, a server closing): another process may take it. */
    let refused = false;
    ws.on("upgrade", (res) => (socket = res.socket));
    ws.on("open", async () => {
      pings = setInterval(() => {
        // Any byte counts: a big frame still arriving on a slow link holds the pong up behind it.
        // (One being sent can't be seen: it must reach the hub within one or two pings.)
        if (socket!.bytesRead > read) {
          read = socket!.bytesRead;
          return ws.ping();
        }
        console.error("dispand-runner: nothing from Dispand since the last ping, reconnecting");
        // At once, with no close handshake to wait on: the reconnect takes over.
        ws.terminate();
      }, this.options.pingMs ?? PING_MS).unref();
      const hello = await this.options.hello();
      // Closed or replaced while the hello was read: its own close handler takes over.
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      // `lastSeq` lets the server wait for the events resent below before it reconciles sessions.
      this.helloSeq = this.unacked.at(-1)?.seq ?? 0;
      this.write(ws, JSON.stringify({ ...hello, lastSeq: this.helloSeq } satisfies RunnerToServer));
      this.ready = true;
      this.pump();
    });
    ws.on("message", (data) => this.receive(String(data)));
    ws.on("pong", () => {
      // It held for a ping: all a runner with no event past its hello's `lastSeq` can tell of a
      // catch-up (a hub failing the hello or its caught-up handler closes within moments, 1011).
      this.caughtUp();
    });
    // 426: this Dispand speaks a newer protocol; the runner keeps retrying until it is updated.
    const outdated = ": Dispand needs a newer runner, update it with install.sh --update (the command is in Settings)";
    ws.on("error", (err) => {
      if (err.message.endsWith(" 503")) refused = true;
      console.error(`dispand-runner: connection error: ${err.message}${err.message.endsWith(" 426") ? outdated : ""}`);
    });
    ws.on("close", (code, reason) => {
      clearInterval(pings);
      if (this.ws !== ws) return;
      this.ready = false;
      this.options.onDisconnect?.();
      this.sent = 0;
      this.sentBytes = 0;
      if (this.closed) return;
      // Handed off (`RunnerHub.handOff`: 4002, or 1013 for a connection admitted before it) or
      // refused at the upgrade (503): another process takes the runner, so it dials again within
      // the first wait each time; the waits other failures have grown stay as they are.
      const handedOff = refused || code === 4002 || code === 1013;
      // Random below the delay (full jitter): runners dropped together don't come back together.
      const wait = Math.round(Math.random() * (handedOff ? this.backoff.initialMs : this.delay));
      console.error(`dispand-runner: disconnected (${code} ${String(reason)}), retrying in ${wait} ms`);
      this.timer = setTimeout(() => this.start(), wait);
      if (!handedOff) this.delay = Math.min(this.delay * 2, this.backoff.maxMs);
    });
  }

  emit(sessionId: string, event: HarnessEvent): void {
    for (const e of protocolEvents(event)) this.keep(sessionId, e);
    this.pump();
  }

  private keep(sessionId: string, event: HarnessEvent) {
    // A new message's text never joins the text before it (its own deltas then join it).
    if (event.type !== "text" || event.newMessage) {
      // The session's held text goes first: its other events never overtake it.
      this.seal(sessionId);
      return this.sequence(sessionId, event);
    }
    const held = this.held.get(sessionId);
    // A text delta joins the previous one of its session while that one has never gone out.
    const last = this.unacked.at(-1);
    if (
      held === undefined &&
      last &&
      !last.everSent &&
      last.sessionId === sessionId &&
      last.event.type === "text" &&
      last.event.delta.length + event.delta.length <= TEXT_CHUNK
    ) {
      this.store(last, sessionId, { ...last.event, delta: last.event.delta + event.delta });
      return;
    }
    // Otherwise it waits, unsequenced, while the session has a text event not acked yet.
    if (held !== undefined || this.lastText.has(sessionId)) {
      this.held.set(sessionId, (held ?? "") + event.delta);
      // At a chunk it gets its seq: held text stays small and the backlog's caps count everything past it.
      if (this.held.get(sessionId)!.length >= TEXT_CHUNK) return this.seal(sessionId);
      this.holdTimer ??= setTimeout(() => {
        this.holdTimer = undefined;
        this.sealAll();
        this.flush();
        this.pump();
      }, FLUSH_MS).unref();
      return;
    }
    this.sequence(sessionId, event);
  }

  /** Gives the session's held text its seq (several events past a chunk). */
  private seal(sessionId: string) {
    const delta = this.held.get(sessionId);
    if (delta === undefined) return;
    this.held.delete(sessionId);
    for (const e of protocolEvents({ type: "text", delta })) this.sequence(sessionId, e);
  }

  private sealAll() {
    // `seal` reads the map again: sealing one session may seal another (`onBacklogFull`).
    for (const sessionId of [...this.held.keys()]) this.seal(sessionId);
  }

  /** Gives `event` the next seq and keeps it until acked, unless the backlog is full. */
  private sequence(sessionId: string, event: HarnessEvent) {
    const raw = JSON.stringify({ type: "event", seq: this.seq + 1, sessionId, event } satisfies RunnerToServer);
    if (this.full || this.unacked.length + 1 > this.backlog.maxEvents || this.backlogBytes + Buffer.byteLength(raw) > this.backlog.maxBytes) {
      if (!this.full) {
        this.full = true;
        this.fullErrors.clear();
        this.fullOthers = 0;
        this.droppedErrors = false;
        // The sessions live now are stopped: each one's terminal error is always kept (at most
        // MAX_LIVE_SESSIONS, small events), whatever the caps.
        this.stoppingLive = true;
        try {
          this.options.onBacklogFull?.();
        } finally {
          this.stoppingLive = false;
        }
      }
      // Full: one error per session at most, and besides the live sessions' terminal ones at
      // most MAX_FULL_ERRORS (refusals of new starts and the like); the rest is dropped.
      if (event.type !== "error" || this.fullErrors.has(sessionId)) return;
      if (!this.stoppingLive) {
        if (this.fullOthers >= MAX_FULL_ERRORS) {
          if (!this.droppedErrors) console.error("dispand-runner: backlog full, dropping further errors");
          this.droppedErrors = true;
          return;
        }
        this.fullOthers++;
      }
      this.fullErrors.add(sessionId);
    }
    this.seq += 1;
    // Seqs are reserved in blocks: the checkpoint on disk always covers every seq handed out,
    // durably, before its event can be sent; a restart goes on past it (gaps are fine).
    if (this.seq > this.reserved) {
      const reserved = this.seq + SEQ_BLOCK - 1;
      writeDurable(this.options.seqPath, JSON.stringify({ seq: reserved }));
      // Only once written: after a failed write, the next event writes it again instead of going out uncovered.
      this.reserved = reserved;
    }
    // A new event seals the delta before it: on disk first, in order.
    this.flush();
    const entry = { seq: this.seq, sessionId, event, raw: "", bytes: 0, everSent: false };
    this.unacked.push(entry);
    this.store(entry, sessionId, event);
    if (event.type === "text") this.lastText.set(sessionId, entry);
  }

  /** Sets an entry's event and its serialized form, keeping the backlog's byte count. */
  private store(entry: Connection["unacked"][number], sessionId: string, event: HarnessEvent) {
    this.backlogBytes -= entry.bytes;
    entry.event = event;
    entry.raw = JSON.stringify({ type: "event", seq: entry.seq, sessionId, event } satisfies RunnerToServer);
    entry.bytes = Buffer.byteLength(entry.raw);
    this.backlogBytes += entry.bytes;
    // A text delta may still grow by coalescing: it reaches the disk with the next batch, or once
    // sealed by the event after it. Any other event goes on disk before it counts as emitted.
    if (event.type === "text") {
      this.dirty = entry;
      this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS).unref();
    } else this.file?.write(entry.raw, event.type);
  }

  /** Writes the delta still being coalesced, if any. */
  private flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const entry = this.dirty;
    this.dirty = undefined;
    if (entry && this.unacked.includes(entry)) this.file?.write(entry.raw, "text");
  }

  /** What the backlog file got (tests). */
  get backlogStats(): { appends: number; bytes: number; fsyncs: number } {
    return { ...(this.file?.stats ?? { appends: 0, bytes: 0, fsyncs: 0 }) };
  }

  /** Sends a reply that isn't an event (no seq, never kept): dropped while not connected, and the server times out. */
  /** Sends `msg` now, never kept for later: false when the runner isn't connected. */
  reply(
    msg: Extract<
      RunnerToServer,
      {
        type:
          "clis.replied" | "tool.discovered" | "tool.called" | "plugin.replied" | "models.replied" | "commands.replied" | "subscription.enroll" | "grant.check";
      }
    >,
  ): boolean {
    if (!this.ready || !this.ws) return false;
    this.write(this.ws, JSON.stringify(msg));
    return true;
  }

  /** The hub caught up with this connection: the waits start over. */
  private caughtUp() {
    this.delay = this.backoff.initialMs;
  }

  close(): void {
    clearTimeout(this.holdTimer);
    this.sealAll();
    this.flush();
    this.file?.close();
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  private receive(raw: string) {
    let msg: ServerToRunner;
    try {
      msg = parseServerMessage(raw);
    } catch {
      // Its text may quote the message: not logged.
      console.error("dispand-runner: ignored an invalid message from the server");
      return;
    }
    if (msg.type !== "ack") return this.options.onMessage(msg);
    // The hub acks `hello.lastSeq` before its caught-up handler runs, and handles nothing past it
    // until that is done: an ack past it shows the connection caught up.
    if (msg.seq > this.helloSeq) this.caughtUp();
    // The hub handles a runner's events in order: an ack covers every seq up to it.
    let removed = 0;
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= msg.seq) {
      removed++;
      const acked = this.unacked.shift()!;
      if (this.lastText.get(acked.sessionId) === acked) this.lastText.delete(acked.sessionId);
      this.backlogBytes -= acked.bytes;
      if (this.sent > 0) {
        this.sent -= 1;
        this.sentBytes -= acked.bytes;
      }
    }
    if (removed > 0) this.file?.ack(msg.seq);
    if (this.full && this.drained()) this.full = false;
    // A session whose text is all acked sends what it held meanwhile, as one event.
    for (const sessionId of [...this.held.keys()]) if (!this.lastText.has(sessionId)) this.seal(sessionId);
    this.pump();
  }

  /** Sends the next unacked events while the window has room. */
  private pump() {
    if (!this.ready || !this.ws) return;
    while (this.sent < this.unacked.length && this.sent < WINDOW_MESSAGES) {
      const next = this.unacked[this.sent]!;
      if (this.sent > 0 && this.sentBytes + next.bytes > WINDOW_BYTES) break;
      next.everSent = true;
      this.write(this.ws, next.raw);
      this.sent += 1;
      this.sentBytes += next.bytes;
    }
  }

  private write(ws: WebSocket, raw: string) {
    // A failed write closes the socket: the event stays unacked and goes out again after reconnecting.
    ws.send(raw, () => {});
  }
}
