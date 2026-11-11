import { readFileSync } from "node:fs";
import {
  type HarnessEvent,
  parseServerMessage,
  PROTOCOL_VERSION,
  type RunnerToServer,
  type ServerToRunner,
} from "@dispand/runner-protocol";
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

/** Coalesced text deltas reach the backlog file at most this late. */
const FLUSH_MS = 1000;

/** How many seqs one checkpoint write reserves. */
const SEQ_BLOCK = 1000;

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
  /** Built at each (re)connect, so it lists the sessions live at that moment. */
  hello: () => Hello;
  /** Every server message but acks, which the connection handles. */
  onMessage: (msg: Exclude<ServerToRunner, { type: "ack" }>) => void;
  backoff?: { initialMs: number; maxMs: number };
  /** How long an upgrade may take before the connection gives up and retries (default 15 s). */
  handshakeTimeoutMs?: number;
  /** The most kept unacked while Dispand is unreachable (default 20,000 events, 32 MiB). */
  backlog?: { maxEvents: number; maxBytes: number };
  /**
   * Called once when the backlog fills: the runner ends its sessions (their `error` events are
   * kept). Until it drains below half, only `error` events are kept and `backlogFull` is true.
   */
  onBacklogFull?: () => void;
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
 * what waits for it. Reconnects with a backoff of 1 s doubling up to 30 s.
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
  private delay: number;
  private timer: NodeJS.Timeout | undefined;

  private readonly options: ConnectionOptions;
  private readonly file: BacklogFile | undefined;
  /** The text delta being coalesced and not written yet, and the batch that will write it. */
  private dirty: Connection["unacked"][number] | undefined;
  private flushTimer: NodeJS.Timeout | undefined;

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
    ws.on("open", () => {
      this.delay = this.backoff.initialMs;
      // `lastSeq` lets the server wait for the events resent below before it reconciles sessions.
      this.write(ws, JSON.stringify({ ...this.options.hello(), lastSeq: this.unacked.at(-1)?.seq ?? 0 } satisfies RunnerToServer));
      this.ready = true;
      this.pump();
    });
    ws.on("message", (data) => this.receive(String(data)));
    // 426: this Dispand speaks a newer protocol; the runner keeps retrying until it is updated.
    const outdated = ": Dispand needs a newer runner, update it with install.sh --update (the command is in Settings)";
    ws.on("error", (err) => console.error(`dispand-runner: connection error: ${err.message}${err.message.endsWith(" 426") ? outdated : ""}`));
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ready = false;
      this.sent = 0;
      this.sentBytes = 0;
      if (this.closed) return;
      console.error(`dispand-runner: disconnected (${code} ${String(reason)}), retrying in ${this.delay} ms`);
      this.timer = setTimeout(() => this.start(), this.delay);
      this.delay = Math.min(this.delay * 2, this.backoff.maxMs);
    });
  }

  emit(sessionId: string, event: HarnessEvent): void {
    for (const e of protocolEvents(event)) this.keep(sessionId, e);
    this.pump();
  }

  private keep(sessionId: string, event: HarnessEvent) {
    // A text delta joins the previous one of its session while that one has never gone out.
    const last = this.unacked.at(-1);
    if (
      event.type === "text" &&
      last &&
      !last.everSent &&
      last.sessionId === sessionId &&
      last.event.type === "text" &&
      last.event.delta.length + event.delta.length <= TEXT_CHUNK
    ) {
      this.store(last, sessionId, { type: "text", delta: last.event.delta + event.delta });
      return;
    }
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
      this.reserved = this.seq + SEQ_BLOCK - 1;
      writeDurable(this.options.seqPath, JSON.stringify({ seq: this.reserved }));
    }
    // A new event seals the delta before it: on disk first, in order.
    this.flush();
    const entry = { seq: this.seq, sessionId, event, raw: "", bytes: 0, everSent: false };
    this.unacked.push(entry);
    this.store(entry, sessionId, event);
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
  reply(msg: Extract<RunnerToServer, { type: "tool.discovered" | "tool.called" }>): void {
    if (this.ready && this.ws) this.write(this.ws, JSON.stringify(msg));
  }

  close(): void {
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
    // The hub handles a runner's events in order: an ack covers every seq up to it.
    let removed = 0;
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= msg.seq) {
      removed++;
      const acked = this.unacked.shift()!;
      this.backlogBytes -= acked.bytes;
      if (this.sent > 0) {
        this.sent -= 1;
        this.sentBytes -= acked.bytes;
      }
    }
    if (removed > 0) this.file?.ack(msg.seq);
    if (this.full && this.drained()) this.full = false;
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
