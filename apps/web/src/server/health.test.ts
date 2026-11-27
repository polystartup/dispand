import { closeDb, createDb, Scheduler, type Engine } from "@dispand/domain";
import { expect, onTestFinished, test, vi } from "vitest";
import { handleHealth, STALE_TICK_MS } from "./health.ts";

/** The scheduler of a process that doesn't run it. */
const idle = { sinceTick: () => undefined };

test("ready once the app started and the database answers", async () => {
  const db = await createDb("pglite://memory");
  const ok = await handleHealth(async () => ({ db, scheduler: idle }));
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("ok");
  await closeDb(db);
  // The database went away: not ready.
  expect((await handleHealth(async () => ({ db, scheduler: idle }))).status).toBe(503);
});

test("not ready while the app can't start, and nothing of the error is shown", async () => {
  const res = await handleHealth(async () => {
    throw new Error("password authentication failed for user dispand at db:5432");
  });
  expect(res.status).toBe(503);
  expect(await res.text()).toBe("unavailable");
});

test("a process that runs the scheduler is unready once no tick completed for 5 minutes, its start counting as one; one that doesn't run it stays ready", async () => {
  const db = await createDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  let now = new Date("2026-11-26T12:00:00Z");
  const after = (ms: number) => (now = new Date(now.getTime() + ms));
  // The first two ticks hang in their first step until the test ends them; later ones go through.
  const held: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const settleIdleChats = () => (held.length === 2 ? Promise.resolve() : new Promise<void>((resolve, reject) => held.push({ resolve, reject })));
  const engine = { settleIdleChats, sweepEscalations: async () => {}, redrain: async () => {}, announceCheckpoints: async () => {}, continueRun: async () => {} };
  const scheduler = new Scheduler(db, engine as unknown as Engine, { now: () => now });
  const health = async () => {
    const res = await handleHealth(async () => ({ db, scheduler }));
    return [res.status, await res.text()];
  };

  // Not started, however long: this process doesn't run it.
  after(60 * 60_000);
  expect(await health()).toEqual([200, "ok"]);
  const timers = vi.spyOn(globalThis, "setInterval");
  scheduler.start();
  // The timer's callback: the test runs the next tick itself.
  const next = timers.mock.calls.at(-1)![0] as () => void;
  timers.mockRestore();
  onTestFinished(async () => {
    for (const tick of held) tick.resolve();
    await scheduler.stop();
  });
  // The start counts as a tick: the first one has 5 minutes.
  after(STALE_TICK_MS);
  expect(await health()).toEqual([200, "ok: last scheduler tick 300 s ago"]);
  after(1000);
  expect(await health()).toEqual([503, "stale: last scheduler tick 301 s ago"]);
  // The tick fails, which doesn't count: still unready once the next one started.
  held[0]!.reject(new Error("Connection terminated unexpectedly"));
  await vi.waitFor(() => {
    next();
    expect(held).toHaveLength(2);
  });
  expect(await health()).toEqual([503, "stale: last scheduler tick 301 s ago"]);
  // That one completes: ready again.
  held[1]!.resolve();
  await vi.waitFor(async () => expect(await health()).toEqual([200, "ok: last scheduler tick 0 s ago"]), { timeout: 10_000 });
  // Stopped (the app closing): it no longer runs the scheduler.
  await scheduler.stop();
  after(STALE_TICK_MS * 2);
  expect(await health()).toEqual([200, "ok"]);
});
