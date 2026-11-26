import { afterEach, expect, test } from "vitest";
import { createOAuthProvider, refreshTurns, setRefreshLock, type OAuthState, type OAuthStore } from "./oauth-provider.ts";

afterEach(() => setRefreshLock(undefined));

const ISSUER = "https://auth.example";
const ctx = { issuer: ISSUER };
const tokens = (n: number) => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, token_type: "Bearer" });

/** A tool's sign-in in memory, as `tools/oauth.ts` keeps it sealed; each save logged. */
function memoryStore(key: string, log: string[]): OAuthStore & { state: OAuthState } {
  const state: OAuthState = { issuers: { [ISSUER]: { tokens: tokens(1) } }, current: ISSUER };
  return {
    key,
    state,
    read: async () => structuredClone(state),
    change: async (edit) => {
      edit(state);
      log.push(`save ${state.issuers[ISSUER]?.tokens?.refresh_token}`);
    },
    reauthorize: async () => {},
  };
}

/** A connection that may refresh, as a listing or a call opens one. */
const connection = (store: OAuthStore) => createOAuthProvider(store, { kind: "use" }, "https://dispand.test", new Set());

/** One holder at a time, as processes sharing the lock would see it; each step logged. */
function sharedLock(log: string[]) {
  let tail = Promise.resolve();
  return async (key: string) => {
    const before = tail;
    let free!: () => void;
    tail = new Promise<void>((resolve) => (free = resolve));
    await before;
    log.push(`lock ${key}`);
    return () => {
      log.push(`unlock ${key}`);
      free();
    };
  };
}

test("oauth-provider: a set lock is held across the refresh and released after", async () => {
  const log: string[] = [];
  setRefreshLock(sharedLock(log));
  const store = memoryStore("tool-locked", log);
  const { provider } = connection(store);
  // The SDK reads the tokens it refreshes with, asks the server, then saves what it got.
  expect(await provider.tokens(ctx)).toMatchObject({ refresh_token: "refresh-1" });
  log.push("refresh");
  await provider.saveTokens(tokens(2), ctx);
  expect(log).toEqual(["lock tool-locked", "refresh", "save refresh-2", "unlock tool-locked"]);
  // A connection that ends before saving gives it back too.
  const ended = connection(store);
  await ended.provider.tokens(ctx);
  ended.release();
  expect(log.slice(4)).toEqual(["lock tool-locked", "unlock tool-locked"]);
  expect(refreshTurns()).toBe(0);
});

test("oauth-provider: a waiter uses the tokens the first refresh saved", async () => {
  const log: string[] = [];
  const lock = sharedLock(log);
  setRefreshLock(lock);
  const store = memoryStore("tool-shared", log);
  // Another process holds the tool's lock while it refreshes.
  const other = await lock("tool-shared");
  const { provider } = connection(store);
  const read = provider.tokens(ctx);
  // Without the lock, this connection would have read the tokens by now.
  await new Promise((resolve) => setImmediate(resolve));
  await store.change((state) => (state.issuers[ISSUER]!.tokens = tokens(2)));
  other();
  expect(await read).toMatchObject({ refresh_token: "refresh-2" });
  await provider.saveTokens(tokens(3), ctx);
  expect(log).toEqual(["lock tool-shared", "save refresh-2", "unlock tool-shared", "lock tool-shared", "save refresh-3", "unlock tool-shared"]);
  expect(refreshTurns()).toBe(0);
});

test("oauth-provider: a lock that fails gives the turn back, and the tool's next refresh still runs", async () => {
  setRefreshLock(async () => {
    throw new Error("lock lost");
  });
  const store = memoryStore("tool-failing", []);
  await expect(connection(store).provider.tokens(ctx)).rejects.toThrow("lock lost");
  expect(refreshTurns()).toBe(0);
  // One that throws before it returns a promise too.
  setRefreshLock(() => {
    throw new Error("no lock");
  });
  await expect(connection(store).provider.tokens(ctx)).rejects.toThrow("no lock");
  expect(refreshTurns()).toBe(0);
  setRefreshLock(undefined);
  const next = connection(store);
  expect(await next.provider.tokens(ctx)).toMatchObject({ refresh_token: "refresh-1" });
  next.release();
  expect(refreshTurns()).toBe(0);
});
