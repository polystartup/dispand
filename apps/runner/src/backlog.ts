import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { parseRunnerMessage, type RunnerToServer } from "@dispand/runner-protocol";
import { writeAll, writeDurable } from "./durable.ts";

type Event = Extract<RunnerToServer, { type: "event" }>;

/** Events whose loss would leave the server with a wrong picture: written to disk before going on. */
const DURABLE = new Set(["result", "error", "outputs-accepted", "question", "turn-end", "cli-session"]);
/** Text deltas reach the disk at most this late. */
const SYNC_MS = 1000;
/** Below this, the file isn't rewritten however much of it is dead. */
const MIN_COMPACT_BYTES = 16 * 1024;

/**
 * The unacked events, kept on disk so a restarted runner sends them again: an append-only JSONL
 * file (mode 0600) of event messages and acks. A later line for the same seq replaces the
 * earlier one (a coalesced delta), an ack line drops every seq up to it. One rule keeps it
 * clean and small: it is rewritten from the pending events alone (temp file, fsync, rename) when
 * it is loaded, which drops a torn tail before anything is appended after it, and whenever it
 * grows past twice their size.
 */
export class BacklogFile {
  private readonly path: string;
  /** The events not acked yet, as the connection holds them: their serialized bytes, and the lines themselves. */
  private readonly pending: { bytes(): number; raws(): string[] };
  private fd: number;
  private size = 0;
  private syncTimer: NodeJS.Timeout | undefined;
  private closed = false;
  /** What reached the file since it was opened: appended lines and rewrites, their bytes, and fsyncs. */
  readonly stats = { appends: 0, bytes: 0, fsyncs: 0 };

  constructor(path: string, pending: { bytes(): number; raws(): string[] }) {
    this.path = path;
    this.pending = pending;
    this.fd = openSync(path, "a", 0o600);
  }

  /** The unacked events in the file, oldest first, then the file rewritten with only them. Unreadable lines are dropped and logged. */
  load(): Event[] {
    const events = new Map<number, Event>();
    let lastAck = 0;
    let bad = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as { type?: string; seq?: unknown };
        if (record.type === "ack" && Number.isSafeInteger(record.seq)) lastAck = Math.max(lastAck, record.seq as number);
        else {
          const msg = parseRunnerMessage(line);
          if (msg.type !== "event") throw new Error("not an event");
          events.set(msg.seq, msg);
        }
      } catch {
        bad++;
      }
    }
    if (bad > 0) console.error(`dispand-runner: dropped ${bad} unreadable line(s) of ${this.path}`);
    const unacked = [...events.values()].filter((e) => e.seq > lastAck).sort((a, b) => a.seq - b.seq);
    this.rewrite(unacked.map((e) => JSON.stringify(e)));
    return unacked;
  }

  /** Appends an event message (new, or replacing the line of its seq); durable kinds are synced before returning. */
  write(raw: string, kind: string): void {
    if (this.closed) return;
    this.append(`${raw}\n`);
    if (this.compacted()) return;
    if (DURABLE.has(kind)) this.sync();
    else this.syncTimer ??= setTimeout(() => this.sync(), SYNC_MS).unref();
  }

  /** Records an ack of every seq up to `seq`. */
  ack(seq: number): void {
    if (this.closed) return;
    this.append(`${JSON.stringify({ type: "ack", seq })}\n`);
    this.compacted();
  }

  close(): void {
    if (this.closed) return;
    this.sync();
    closeSync(this.fd);
    this.closed = true;
  }

  private append(text: string) {
    writeAll((f, b, o, l) => writeSync(f, b, o, l), this.fd, text);
    this.size += Buffer.byteLength(text);
    this.stats.appends++;
    this.stats.bytes += Buffer.byteLength(text);
  }

  /** Rewrites the file from the pending events once it is over twice their size; true if it did. */
  private compacted(): boolean {
    if (this.size <= Math.max(2 * this.pending.bytes(), MIN_COMPACT_BYTES)) return false;
    this.rewrite(this.pending.raws());
    return true;
  }

  /** Replaces the file with `raws`, atomically and synced. */
  private rewrite(raws: string[]) {
    const text = raws.map((raw) => `${raw}\n`).join("");
    writeDurable(this.path, text);
    this.stats.bytes += Buffer.byteLength(text);
    this.stats.fsyncs += 2;
    closeSync(this.fd);
    this.fd = openSync(this.path, "a", 0o600);
    this.size = Buffer.byteLength(text);
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
  }

  private sync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    if (this.closed) return;
    fsyncSync(this.fd);
    this.stats.fsyncs++;
  }
}
