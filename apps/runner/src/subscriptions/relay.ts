// The model relay of a personal worker: its only model transport. One relay per grant, served on
// that worker's own network (where only the worker and the supervisor are), so a request reaching
// it comes from that worker; it must also present its grant's token. Each request is checked with
// Dispand (`grant.check`) before the supervisor attaches the subscription's credential, which the
// worker never holds. Its streams close when the grant ends, when Dispand is lost and at the
// deadline; a late request, from this worker or another, is never assigned to another grant.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Grant, RunnerToServer, ServerToRunner } from "@dispand/runner-protocol";

/** The header a personal worker's CLI sends its grant's token in (`codex/config.ts`): never in a URL, so never in a transcript. */
export const GRANT_HEADER = "x-dispand-grant";

/** Where each personal CLI's model operations go, and which ones: nothing else is sent with the credential. */
export const SUBSCRIPTION_PROVIDERS = {
  codex: { upstream: "https://chatgpt.com/backend-api/codex", operations: ["/responses"] },
} as const;
export type SubscriptionHarness = keyof typeof SUBSCRIPTION_PROVIDERS;

/** The headers the relay attaches, read at each request (`codex/personal.ts`). */
export type Credential = Record<string, string>;
export type CredentialSource = {
  read(): Promise<Credential | undefined>;
  /** After the provider refused `rejected`: renews in the supervisor. */
  renew(rejected: Credential): Promise<unknown>;
};

/** Never forwarded from the worker: its own credentials, its grant, and what belongs to one hop. */
const DROPPED = new Set(["host", "connection", "keep-alive", "upgrade", "transfer-encoding", "content-length", "authorization", "x-api-key", "proxy-authorization", "proxy-connection", "cookie", "chatgpt-account-id", GRANT_HEADER]);
/** Never sent back to the worker: what belongs to one hop, and what could carry a session of the provider's. */
const DROPPED_BACK = new Set([...DROPPED, "set-cookie", "content-encoding"]);

type Check = Extract<RunnerToServer, { type: "grant.check" }>;
type Checked = Extract<ServerToRunner, { type: "grant.checked" }>;

/** How long Dispand has to answer a check before the request is denied. */
export const CHECK_TIMEOUT_MS = 10_000;

/**
 * The runner's asks to Dispand, by `askId`: each answers with a fresh deadline, or nothing when the
 * grant doesn't hold, the runner isn't connected or Dispand doesn't answer in time. Losing the
 * connection answers every pending ask with nothing and closes every relay's streams.
 */
export class GrantChecks {
  private readonly send: (msg: Check) => boolean;
  private readonly timeoutMs: number;
  private readonly asks = new Map<string, (ttlMs: number | undefined) => void>();
  private readonly lostListeners = new Set<() => void>();

  constructor(send: (msg: Check) => boolean, timeoutMs = CHECK_TIMEOUT_MS) {
    this.send = send;
    this.timeoutMs = timeoutMs;
  }

  check(grantId: string): Promise<number | undefined> {
    const askId = randomUUID();
    return new Promise((resolve) => {
      const done = (ttlMs: number | undefined) => {
        clearTimeout(timer);
        this.asks.delete(askId);
        resolve(ttlMs);
      };
      const timer = setTimeout(() => done(undefined), this.timeoutMs);
      this.asks.set(askId, done);
      if (!this.send({ type: "grant.check", askId, grantId })) done(undefined);
    });
  }

  /** Dispand's answer to a check this runner sent; any other is ignored. */
  checked(reply: Checked): void {
    this.asks.get(reply.askId)?.(reply.ttlMs);
  }

  /** The connection to Dispand is gone: nothing pending can be confirmed, and no stream stays open. */
  lost(): void {
    for (const done of [...this.asks.values()]) done(undefined);
    for (const listener of [...this.lostListeners]) listener();
  }

  onLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }
}

/** Two clocks, read together: the monotonic one stops while the machine sleeps, the wall clock doesn't. */
export type Clock = () => { mono: number; wall: number };
const systemClock: Clock = () => ({ mono: performance.now(), wall: Date.now() });

/**
 * A deadline measured from `since` (taken before its check was sent): over once either clock has
 * moved `ttlMs` past it, so a sleep that stops the monotonic clock doesn't extend it. A clock that
 * reads backwards or not at all ends it (it can't be bounded).
 */
export type Deadline = { since: { mono: number; wall: number }; ttlMs: number };
export function remaining(deadline: Deadline, now: { mono: number; wall: number }): number {
  const mono = now.mono - deadline.since.mono;
  const wall = now.wall - deadline.since.wall;
  if (!(mono >= 0) || !(wall >= 0)) return 0;
  return Math.max(0, deadline.ttlMs - Math.max(mono, wall));
}

export type GrantRelayOptions = {
  grant: Grant;
  harness: SubscriptionHarness;
  checks: GrantChecks;
  credential: CredentialSource;
  /** When the grant arrived: its first deadline counts from there. */
  since?: { mono: number; wall: number };
  /** Tests only: where the provider's operations go. */
  upstream?: string;
  /** Called once when the grant lapses: its worker stops, as on `grant.end`. */
  onLapse?: () => void;
  clock?: Clock;
  /** How often open streams are held against the deadline (and renewed before it). */
  tickMs?: number;
};

export class GrantRelay {
  /** What the worker presents with each request: its grant's, and no other relay's. Never a credential. */
  readonly token = randomBytes(32).toString("base64url");
  readonly grantId: string;
  private readonly o: GrantRelayOptions;
  private readonly clock: Clock;
  private deadline: Deadline;
  private ended = false;
  private readonly streams = new Set<() => void>();
  private readonly ticker: NodeJS.Timeout;
  private extending = false;
  private readonly offLost: () => void;

  constructor(options: GrantRelayOptions) {
    this.o = options;
    this.grantId = options.grant.id;
    this.clock = options.clock ?? systemClock;
    this.deadline = { since: options.since ?? this.clock(), ttlMs: options.grant.ttlMs };
    this.offLost = options.checks.onLost(() => this.closeStreams());
    // For its whole life, not only while a stream is open: a grant left to lapse can't be used again.
    this.ticker = setInterval(() => this.tick(), options.tickMs ?? 1000).unref();
  }

  /** Whether the grant is over here: nothing goes through this relay again. */
  get revoked(): boolean {
    return this.ended;
  }

  /** Whether its deadline has passed with no check extending it. */
  get expired(): boolean {
    return this.left() <= 0;
  }

  /** The grant ended (or its session did): its streams close now, and every later request is denied. */
  revoke(): void {
    this.ended = true;
    clearInterval(this.ticker);
    this.offLost();
    this.closeStreams();
  }

  /** Its deadline passed: for good, so the grant ends here, with its worker. */
  private lapse(): void {
    if (this.ended) return;
    this.revoke();
    this.o.onLapse?.();
  }

  private closeStreams(): void {
    for (const close of [...this.streams]) close();
  }

  /** Once its deadline is seen passed, for good: a clock corrected afterwards doesn't reopen it. */
  private lapsed = false;

  private left(): number {
    const left = this.lapsed ? 0 : remaining(this.deadline, this.clock());
    if (left <= 0) this.lapsed = true;
    return left;
  }

  /**
   * Closes every stream at the deadline, after asking Dispand once to extend it when half of it is
   * left. Once it has passed, nothing extends it: every request is closed before its check answers.
   */
  private tick(): void {
    const left = this.left();
    if (left <= 0) return this.lapse();
    if (this.extending || left > this.deadline.ttlMs / 2) return;
    this.extending = true;
    const since = this.clock();
    void this.o.checks.check(this.grantId).then((ttlMs) => {
      this.extending = false;
      // A check sent after this one already answered: its word holds, not this older ask's.
      if (this.newer(since)) return;
      if (ttlMs === undefined) return this.closeStreams();
      // The deadline in force first: an answer that comes after it passed revives nothing.
      if (this.left() <= 0) return this.lapse();
      this.deadline = { since, ttlMs };
      // And the new one: an answer already past when it came ends the grant now.
      if (this.left() <= 0) this.lapse();
    });
  }

  /** Whether the deadline in force comes from a check sent after `since`: checks count in the order they were sent. */
  private newer(since: { mono: number }): boolean {
    return this.deadline.since.mono > since.mono;
  }

  private presented(req: IncomingMessage): boolean {
    const sent = req.headers[GRANT_HEADER];
    if (typeof sent !== "string") return false;
    const [a, b] = [Buffer.from(sent), Buffer.from(this.token)];
    return a.length === b.length && timingSafeEqual(a, b);
  }

  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const deny = (status = 403) => void (res.headersSent ? res.destroy() : res.writeHead(status).end());
    // Nothing is read of the body before every check passed.
    if (this.ended || !this.presented(req)) return deny();
    const provider = SUBSCRIPTION_PROVIDERS[this.o.harness];
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://relay").pathname;
    } catch {
      return deny(400);
    }
    if (req.method !== "POST" || !(provider.operations as readonly string[]).includes(path)) return deny();
    // Tracked from here: a revocation, a lost Dispand or the deadline cancels it at any step below.
    const abort = new AbortController();
    const close = () => {
      abort.abort();
      res.destroy();
    };
    this.streams.add(close);
    res.once("close", () => {
      abort.abort();
      this.streams.delete(close);
    });
    // This request's own check, from before it is sent: never a remembered answer.
    const since = this.clock();
    const ttlMs = await this.o.checks.check(this.grantId);
    if (ttlMs === undefined) return deny();
    // The deadline in force first: an answer that comes after it passed revives nothing.
    if (this.left() <= 0) {
      this.lapse();
      return deny();
    }
    // Dispand's latest word sets the grant's deadline, a shorter one too (a lapsed grant stays lapsed).
    if (!this.newer(since)) this.deadline = { since, ttlMs };
    if (this.left() <= 0) this.lapse();
    const own = { since, ttlMs };
    // The one rule, at every step until it is sent: not cancelled, the grant alive, and this request's own answer still holding.
    const live = () => !this.ended && !abort.signal.aborted && this.left() > 0 && remaining(own, this.clock()) > 0;
    if (!live()) return deny();
    const credential = await this.o.credential.read();
    if (!credential || !live()) return deny();
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !DROPPED.has(k)) headers[k] = v;
      const upstream = await fetch(`${this.o.upstream ?? provider.upstream}${path}`, {
        method: "POST", headers: { ...headers, ...credential },
        body: Readable.toWeb(req) as ReadableStream, duplex: "half", redirect: "manual", signal: abort.signal,
      } as RequestInit);
      // Never followed: the credential goes only to the provider's own origin.
      if (upstream.status >= 300 && upstream.status < 400) return deny(502);
      // Renewed in the supervisor; the CLI sends its request again, which reads the renewed credential.
      if (upstream.status === 401) void this.o.credential.renew(credential).catch(() => undefined);
      const out: Record<string, string> = {};
      upstream.headers.forEach((v, k) => { if (!DROPPED_BACK.has(k)) out[k] = v; });
      res.writeHead(upstream.status, out);
      if (!upstream.body) return void res.end();
      const body = Readable.fromWeb(upstream.body as never);
      // Each chunk is held against the deadline too: a timer may fire late after a sleep.
      body.on("data", () => { if (this.left() <= 0) close(); }).on("error", () => res.destroy()).pipe(res);
    } catch {
      deny(502);
    }
  };
}
