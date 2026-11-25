import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GRANT_HEADER, GrantChecks, GrantRelay, remaining } from "./relay.ts";

const CREDENTIAL = { authorization: "Bearer subscription-access", "chatgpt-account-id": "account-1" };

type Seen = { method: string; path: string; headers: IncomingMessage["headers"] };
const servers: Server[] = [];
const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

/** The provider stand-in: records each request; `/hold` streams until its client goes; `/redirect` and `/unauthorized` answer so. */
async function provider() {
  const seen: Seen[] = [];
  const open = new Set<ServerResponse>();
  const url = await listen((req, res) => {
    seen.push({ method: req.method!, path: req.url!, headers: req.headers });
    req.resume();
    if (req.headers["x-test"] === "redirect") return void res.writeHead(307, { location: "https://elsewhere.test/" }).end();
    if (req.headers["x-test"] === "unauthorized") return void res.writeHead(401).end();
    if (req.headers["x-test"] === "hold") {
      open.add(res);
      res.once("close", () => open.delete(res));
      res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "s=1" });
      return void res.write("data: first\n\n");
    }
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  return { url, seen, open };
}

/** Dispand stand-in: answers each check with `answer()` (undefined denies), or holds it when `answer` is "hold". */
function dispand(answer: () => number | undefined | "hold" = () => 60_000) {
  const sent: string[] = [];
  let connected = true;
  const checks: GrantChecks = new GrantChecks((msg) => {
    if (!connected) return false;
    sent.push(msg.grantId);
    const a = answer();
    if (a !== "hold") queueMicrotask(() => checks.checked({ type: "grant.checked", askId: msg.askId, ...(a === undefined ? {} : { ttlMs: a }) }));
    return true;
  }, 500);
  return { checks, sent, disconnect: () => { connected = false; checks.lost(); } };
}

async function relayFor(o: { checks: GrantChecks; upstream: string; id?: string; ttlMs?: number; clock?: () => { mono: number; wall: number }; renew?: () => Promise<unknown>; read?: () => Promise<Record<string, string>>; onLapse?: () => void }) {
  const renew = vi.fn(o.renew ?? (() => Promise.resolve(undefined)));
  const relay = new GrantRelay({
    grant: { id: o.id ?? "grant-1", enrollmentId: "enrollment-1", ttlMs: o.ttlMs ?? 60_000 }, harness: "codex", checks: o.checks,
    credential: { read: o.read ?? (() => Promise.resolve(CREDENTIAL)), renew }, upstream: o.upstream, tickMs: 20,
    ...(o.clock ? { clock: o.clock } : {}), ...(o.onLapse ? { onLapse: o.onLapse } : {}),
  });
  const url = await listen(relay.handle);
  return { relay, url, renew };
}

const post = (url: string, headers: Record<string, string> = {}, method = "POST") =>
  fetch(`${url}/responses`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }).then(async (r) => ({ status: r.status, headers: r.headers, body: r.body }));

describe("relay ›", () => {
  test("a request without its grant, or with another worker's grant, is denied, and nothing reaches the provider", async () => {
    const up = await provider();
    const { checks, sent } = dispand();
    const a = await relayFor({ checks, upstream: up.url, id: "grant-a" });
    const b = await relayFor({ checks, upstream: up.url, id: "grant-b" });
    expect((await post(a.url)).status).toBe(403);
    expect((await post(a.url, { [GRANT_HEADER]: b.relay.token })).status).toBe(403);
    expect((await post(a.url, { [GRANT_HEADER]: `${a.relay.token}x` })).status).toBe(403);
    expect(up.seen).toEqual([]);
    expect(sent).toEqual([]);
    // Its own grant goes through, checked with Dispand under that grant.
    expect((await post(a.url, { [GRANT_HEADER]: a.relay.token })).status).toBe(200);
    expect(sent).toEqual(["grant-a"]);
  });

  test("the credential replaces the worker's, the grant's token never reaches the provider, and only the model operation goes", async () => {
    const up = await provider();
    const { checks } = dispand();
    const { relay, url } = await relayFor({ checks, upstream: up.url });
    const own = { [GRANT_HEADER]: relay.token, authorization: "Bearer worker-own", "chatgpt-account-id": "worker-own", cookie: "c=1" };
    expect((await post(url, own)).status).toBe(200);
    expect(up.seen[0]!.path).toBe("/responses");
    expect(up.seen[0]!.headers.authorization).toBe(CREDENTIAL.authorization);
    expect(up.seen[0]!.headers["chatgpt-account-id"]).toBe(CREDENTIAL["chatgpt-account-id"]);
    expect(up.seen[0]!.headers[GRANT_HEADER]).toBeUndefined();
    expect(up.seen[0]!.headers.cookie).toBeUndefined();
    expect((await post(url, own, "GET")).status).toBe(403);
    expect((await fetch(`${url}/models`, { method: "POST", headers: own, body: "{}" })).status).toBe(403);
    expect((await post(url, { ...own, "x-test": "redirect" })).status).toBe(502);
    expect(up.seen.length).toBe(2);
  });

  test("a check that is denied, unanswered or can't be sent denies the request", async () => {
    const up = await provider();
    for (const answer of [() => undefined, () => "hold" as const]) {
      const { checks } = dispand(answer);
      const { relay, url } = await relayFor({ checks, upstream: up.url });
      expect((await post(url, { [GRANT_HEADER]: relay.token })).status).toBe(403);
    }
    const lost = dispand();
    lost.disconnect();
    const { relay, url } = await relayFor({ checks: lost.checks, upstream: up.url });
    expect((await post(url, { [GRANT_HEADER]: relay.token })).status).toBe(403);
    expect(up.seen).toEqual([]);
  });

  test("a request Dispand approved is not sent when Dispand is lost while its credential is read", async () => {
    const up = await provider();
    const d = dispand();
    let release!: () => void;
    const reading = new Promise<void>((r) => (release = r));
    let asked = false;
    const { relay, url } = await relayFor({ checks: d.checks, upstream: up.url, read: async () => { asked = true; await reading; return CREDENTIAL; } });
    const answer = post(url, { [GRANT_HEADER]: relay.token });
    await vi.waitFor(() => expect(asked).toBe(true));
    d.disconnect();
    release();
    expect((await answer.catch(() => ({ status: 0 }))).status).not.toBe(200);
    expect(up.seen).toEqual([]);
  });

  test("a grant whose deadline lapsed is never reopened, even when Dispand answers", async () => {
    const up = await provider();
    let now = { mono: 0, wall: 0 };
    const { checks } = dispand();
    const { relay, url } = await relayFor({ checks, upstream: up.url, clock: () => now, ttlMs: 1000 });
    now = { mono: 5000, wall: 5000 };
    expect(relay.expired).toBe(true);
    // A clock read again before the deadline doesn't reopen it.
    now = { mono: 10, wall: 10 };
    expect(relay.expired).toBe(true);
    expect((await post(url, { [GRANT_HEADER]: relay.token }).catch(() => ({ status: 0 }))).status).not.toBe(200);
    expect(up.seen).toEqual([]);
  });

  test("an idle grant is extended before its deadline, so its next request goes through", async () => {
    const up = await provider();
    let now = { mono: 0, wall: 0 };
    const { checks, sent } = dispand(() => 1000);
    const { relay, url } = await relayFor({ checks, upstream: up.url, clock: () => now, ttlMs: 1000 });
    for (const t of [600, 1200, 1800]) {
      now = { mono: t, wall: t };
      await vi.waitFor(() => expect(sent.length).toBe(t / 600), { timeout: 10_000 });
    }
    expect(relay.expired).toBe(false);
    expect((await post(url, { [GRANT_HEADER]: relay.token })).status).toBe(200);
  });

  test("a late request after the grant ended is denied, even one already waiting for its check", async () => {
    const up = await provider();
    let hold = false;
    const { checks, sent } = dispand(() => (hold ? "hold" : 60_000));
    const old = await relayFor({ checks, upstream: up.url, id: "grant-old" });
    const next = await relayFor({ checks, upstream: up.url, id: "grant-next" });
    hold = true;
    const waiting = post(old.url, { [GRANT_HEADER]: old.relay.token });
    await vi.waitFor(() => expect(sent).toContain("grant-old"));
    old.relay.revoke();
    // Cut before any answer: its connection closes.
    await expect(waiting).rejects.toThrow("fetch failed");
    hold = false;
    expect((await post(old.url, { [GRANT_HEADER]: old.relay.token })).status).toBe(403);
    // Nor with the next grant's token, on the old worker's relay.
    expect((await post(old.url, { [GRANT_HEADER]: next.relay.token })).status).toBe(403);
    expect(up.seen).toEqual([]);
  });

  const holdOpen = async (url: string, token: string) => {
    const r = await post(url, { [GRANT_HEADER]: token, "x-test": "hold" });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    const reader = r.body!.getReader();
    await reader.read();
    return reader.read().then((c) => (c.done ? "ended" : "data"), () => "cut");
  };

  test("an active stream closes on revocation", async () => {
    const up = await provider();
    const { relay, url } = await relayFor({ checks: dispand().checks, upstream: up.url });
    const closed = holdOpen(url, relay.token);
    await vi.waitFor(() => expect(up.open.size).toBe(1));
    relay.revoke();
    expect(await closed).not.toBe("data");
    await vi.waitFor(() => expect(up.open.size).toBe(0));
  });

  test("an active stream closes on losing Dispand", async () => {
    const up = await provider();
    const d = dispand();
    const { relay, url } = await relayFor({ checks: d.checks, upstream: up.url });
    const closed = holdOpen(url, relay.token);
    await vi.waitFor(() => expect(up.open.size).toBe(1));
    d.disconnect();
    expect(await closed).not.toBe("data");
    await vi.waitFor(() => expect(up.open.size).toBe(0));
  });

  test("an active stream closes at the deadline when Dispand doesn't extend it, and stays open while it does", async () => {
    const up = await provider();
    let now = { mono: 0, wall: 0 };
    let extend = true;
    const { checks, sent } = dispand(() => (extend ? 1000 : undefined));
    const { relay, url } = await relayFor({ checks, upstream: up.url, clock: () => now, ttlMs: 1000 });
    const closed = holdOpen(url, relay.token);
    await vi.waitFor(() => expect(up.open.size).toBe(1));
    // Past half the deadline: extended once, from the start of that check.
    now = { mono: 600, wall: 600 };
    await vi.waitFor(() => expect(sent.length).toBe(2));
    // Past the first deadline: still open, extended again from 1300.
    now = { mono: 1300, wall: 1300 };
    await vi.waitFor(() => expect(sent.length).toBe(3));
    expect(up.open.size).toBe(1);
    // Past that one, with no extension: closed.
    extend = false;
    now = { mono: 2400, wall: 2400 };
    expect(await closed).not.toBe("data");
    await vi.waitFor(() => expect(up.open.size).toBe(0));
  });

  test("checks count in the order they were sent: a renewal sent after a request's check still extends the grant", async () => {
    const up = await provider();
    let now = { mono: 0, wall: 0 };
    const pending: (() => void)[] = [];
    const checks: GrantChecks = new GrantChecks((msg) => {
      // Answered only when the test says, each with a fresh deadline.
      pending.push(() => checks.checked({ type: "grant.checked", askId: msg.askId, ttlMs: 1000 }));
      return true;
    }, 60_000);
    const { relay, url } = await relayFor({ checks, upstream: up.url, clock: () => now, ttlMs: 1000 });
    // A request's check at 450, then the idle renewal at 600, while it waits.
    now = { mono: 450, wall: 450 };
    const answer = post(url, { [GRANT_HEADER]: relay.token });
    await vi.waitFor(() => expect(pending.length).toBe(1));
    now = { mono: 600, wall: 600 };
    await vi.waitFor(() => expect(pending.length).toBe(2));
    // The request's answer first (until 1450), then the renewal's (until 1600).
    pending[0]!();
    expect((await answer).status).toBe(200);
    pending[1]!();
    await new Promise((r) => setTimeout(r, 50));
    now = { mono: 1500, wall: 1500 };
    expect(relay.expired).toBe(false);
  });

  test("a request whose own answer has already lapsed is denied, even while a newer check keeps the grant alive", async () => {
    const up = await provider();
    let now = { mono: 0, wall: 0 };
    const pending: (() => void)[] = [];
    const checks: GrantChecks = new GrantChecks((msg) => {
      pending.push(() => checks.checked({ type: "grant.checked", askId: msg.askId, ttlMs: 1000 }));
      return true;
    }, 60_000);
    const { relay, url } = await relayFor({ checks, upstream: up.url, clock: () => now, ttlMs: 1000 });
    now = { mono: 100, wall: 100 };
    const old = post(url, { [GRANT_HEADER]: relay.token });
    await vi.waitFor(() => expect(pending.length).toBe(1));
    // The idle renewal at 600 answers first; the request's own answer comes after its 1000 ms lapsed.
    now = { mono: 600, wall: 600 };
    await vi.waitFor(() => expect(pending.length).toBe(2));
    pending[1]!();
    await vi.waitFor(() => expect(relay.expired).toBe(false));
    await new Promise((r) => setTimeout(r, 20));
    now = { mono: 1200, wall: 1200 };
    pending[0]!();
    expect((await old).status).toBe(403);
    expect(up.seen).toEqual([]);
  });

  test("a request whose own answer lapses while its credential is read is not sent, even while the grant lives", async () => {
    const up = await provider();
    let now = { mono: 0, wall: 0 };
    let ttl = 1000;
    const { checks } = dispand(() => ttl);
    let release!: () => void;
    const reading = new Promise<void>((r) => (release = r));
    let asked = false;
    const { relay, url } = await relayFor({ checks, upstream: up.url, clock: () => now, ttlMs: 1000, read: async () => { asked = true; await reading; return CREDENTIAL; } });
    now = { mono: 100, wall: 100 };
    const answer = post(url, { [GRANT_HEADER]: relay.token });
    await vi.waitFor(() => expect(asked).toBe(true));
    // Dispand renews the grant meanwhile, from a later check; the request's own answer (100 + 1000) lapses.
    ttl = 5000;
    now = { mono: 600, wall: 600 };
    await vi.waitFor(() => expect(relay.expired).toBe(false));
    await new Promise((r) => setTimeout(r, 50));
    now = { mono: 1200, wall: 1200 };
    release();
    expect((await answer.catch(() => ({ status: 0 }))).status).toBe(403);
    expect(relay.expired).toBe(false);
    expect(up.seen).toEqual([]);
  });

  test("a lapsed grant ends there, and asks for its worker to stop", async () => {
    const up = await provider();
    let now = { mono: 0, wall: 0 };
    const onLapse = vi.fn();
    const { relay } = await relayFor({ checks: dispand(() => undefined).checks, upstream: up.url, clock: () => now, ttlMs: 1000, onLapse });
    now = { mono: 2000, wall: 2000 };
    await vi.waitFor(() => expect(onLapse).toHaveBeenCalledTimes(1));
    expect(relay.revoked).toBe(true);
  });

  test("an answer that comes after the deadline in force passed revives nothing", async () => {
    const up = await provider();
    let now = { mono: 0, wall: 0 };
    const pending: (() => void)[] = [];
    const checks: GrantChecks = new GrantChecks((msg) => {
      pending.push(() => checks.checked({ type: "grant.checked", askId: msg.askId, ttlMs: 5000 }));
      return true;
    }, 60_000);
    const onLapse = vi.fn();
    // A tick slower than the test: only the answer's own arrival can see the deadline passed.
    const relay = new GrantRelay({ grant: { id: "g", enrollmentId: "e", ttlMs: 1000 }, harness: "codex", checks, credential: { read: async () => CREDENTIAL, renew: async () => undefined }, upstream: up.url, clock: () => now, tickMs: 60_000, onLapse });
    const url = await listen(relay.handle);
    now = { mono: 100, wall: 100 };
    const answer = post(url, { [GRANT_HEADER]: relay.token });
    await vi.waitFor(() => expect(pending.length).toBe(1));
    now = { mono: 1500, wall: 1500 };
    pending[0]!();
    // The lapse closes it with every other stream.
    await expect(answer).rejects.toThrow("fetch failed");
    expect(relay.revoked).toBe(true);
    expect(onLapse).toHaveBeenCalledTimes(1);
    expect(up.seen).toEqual([]);
  });

  test("a sleep that stops the monotonic clock still ends the deadline, and a clock read backwards ends it", () => {
    const since = { mono: 100, wall: 1_000_000 };
    expect(remaining({ since, ttlMs: 1000 }, { mono: 200, wall: 1_000_100 })).toBe(900);
    // Suspended for an hour: the monotonic clock barely moved.
    expect(remaining({ since, ttlMs: 1000 }, { mono: 200, wall: 4_600_000 })).toBe(0);
    expect(remaining({ since, ttlMs: 1000 }, { mono: 50, wall: 1_000_100 })).toBe(0);
    expect(remaining({ since, ttlMs: 1000 }, { mono: 200, wall: 999_000 })).toBe(0);
    expect(remaining({ since, ttlMs: 1000 }, { mono: Number.NaN, wall: 1_000_100 })).toBe(0);
  });

  test("a provider's 401 renews in the supervisor and goes back to the CLI, which sends its request again", async () => {
    const up = await provider();
    const { relay, url, renew } = await relayFor({ checks: dispand().checks, upstream: up.url });
    expect((await post(url, { [GRANT_HEADER]: relay.token, "x-test": "unauthorized" })).status).toBe(401);
    expect(renew).toHaveBeenCalledWith(CREDENTIAL);
  });
});

describe("relay › Claude Code", () => {
  const CLAUDE = { authorization: "Bearer subscription-claude" };
  const claudeRelay = async (upstream: string, checks: GrantChecks, renew = vi.fn(() => Promise.resolve(undefined))) => {
    const relay = new GrantRelay({ grant: { id: "grant-c", enrollmentId: "enrollment-1", ttlMs: 60_000 }, harness: "claude-code", checks, credential: { read: () => Promise.resolve(CLAUDE), renew }, upstream, tickMs: 20 });
    return { relay, url: await listen(relay.handle), renew };
  };
  const send = (url: string, path: string, headers: Record<string, string>, method = "POST") =>
    fetch(`${url}${path}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }).then((r) => r.status);

  test("its grant is its bearer, swapped for the subscription's; the beta header goes, nothing else does", async () => {
    const up = await provider();
    const { checks, sent } = dispand();
    const { relay, url } = await claudeRelay(up.url, checks);
    const own = { authorization: `Bearer ${relay.token}`, "anthropic-beta": "oauth-2025-04-20", "x-api-key": "worker-own" };
    expect(await send(url, "/v1/messages?beta=true", own)).toBe(200);
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]!.path).toBe("/v1/messages?beta=true");
    expect(up.seen[0]!.headers.authorization).toBe(CLAUDE.authorization);
    expect(up.seen[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(up.seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(up.seen)).not.toContain(relay.token);
    expect(sent).toEqual(["grant-c"]);
    // The CLI's hello, a count, another bearer or the grant in Codex's header: refused, nothing sent, nothing checked.
    expect(await send(url, "/api/hello", own, "HEAD")).toBe(403);
    expect(await send(url, "/v1/messages/count_tokens", own)).toBe(403);
    expect(await send(url, "/v1/messages", { authorization: "Bearer someone-else" })).toBe(403);
    expect(await send(url, "/v1/messages", { [GRANT_HEADER]: relay.token })).toBe(403);
    expect(up.seen).toHaveLength(1);
    expect(sent).toEqual(["grant-c"]);
  });

  test("a provider's 401 goes to the supervisor with the credential it refused", async () => {
    const up = await provider();
    const { relay, url, renew } = await claudeRelay(up.url, dispand().checks);
    expect(await send(url, "/v1/messages", { authorization: `Bearer ${relay.token}`, "x-test": "unauthorized" })).toBe(401);
    expect(renew).toHaveBeenCalledWith(CLAUDE);
  });
});
