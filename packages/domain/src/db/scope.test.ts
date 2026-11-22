import { sql } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { migrateDb, openDb, type Db } from "./client.ts";
import { currentScope, detached, eachScope, inRunScope, inScope, shared, SYSTEM, type Tenancy } from "./scope.ts";
import { recordScopes } from "./test-support.ts";

test("currentScope is undefined outside any scope", () => {
  expect(currentScope()).toBeUndefined();
});

test("inScope replaces the outer scope and restores it", async () => {
  const outer = { userId: "user_ada" };
  const seen = await inScope(outer, async () => {
    const inner = await inScope(SYSTEM, () => currentScope());
    return [inner, currentScope()];
  });
  expect(seen).toEqual([SYSTEM, outer]);
  expect(currentScope()).toBeUndefined();
});

test("inScope awaits its work inside the scope", async () => {
  // A lazy thenable (like a Drizzle builder) runs only when awaited: it must still see the scope.
  const lazy = { then: (resolve: (value: unknown) => void) => resolve(currentScope()) };
  expect(await inScope({ workspaceId: "ws_a" }, () => lazy)).toEqual({ workspaceId: "ws_a" });
});

test("two module copies share one store", async () => {
  vi.resetModules();
  const copy = (await import(/* @vite-ignore */ "./scope.ts?copy" as string)) as typeof import("./scope.ts");
  expect(copy.inScope).not.toBe(inScope);
  expect(copy.SYSTEM).toBe(SYSTEM);
  expect(await copy.inScope({ workspaceId: "ws_a" }, () => currentScope())).toEqual({ workspaceId: "ws_a" });
  expect(await inScope({ workspaceId: "ws_b" }, () => copy.currentScope())).toEqual({ workspaceId: "ws_b" });
});

test("detached callbacks run with no scope even when fired inside one", async () => {
  const seen: unknown[] = [];
  const callback = detached((tag: string) => {
    seen.push([tag, currentScope()]);
  });
  await inScope({ workspaceId: "ws_a" }, () => callback("fired"));
  expect(seen).toEqual([["fired", undefined]]);
});

test("shared.each runs work once without calling scopes", async () => {
  const scopes = vi.fn();
  const work = vi.fn(async () => {});
  await shared.each({} as Db, scopes, work);
  expect(scopes).not.toHaveBeenCalled();
  expect(work).toHaveBeenCalledTimes(1);
});

test("shared.forRun runs work as is", async () => {
  const seen = await inScope({ workspaceId: "ws_a" }, () => shared.forRun({} as Db, "run_1", async () => currentScope()));
  expect(seen).toEqual({ workspaceId: "ws_a" });
});

test("eachScope and inRunScope use the tenancy the database was opened with", async () => {
  const calls: string[] = [];
  const tenancy: Tenancy = {
    each: async (_db, _scopes, work) => {
      calls.push("each");
      await work();
    },
    forRun: async (_db, runId, work) => {
      calls.push(`forRun ${runId}`);
      return work();
    },
  };
  const db = await openDb("postgres://unused@localhost/unused", { tenancy });
  const plain = await openDb("postgres://unused@localhost/unused");
  await eachScope(db, async () => [], async () => {});
  expect(await inRunScope(db, "run_1", async () => 7)).toBe(7);
  await eachScope(plain, async () => [], async () => {});
  expect(calls).toEqual(["each", "forRun run_1"]);
});

test("the guarded db throws outside a scope, also inside a transaction", async () => {
  const { db } = await recordScopes();
  await expect(db.execute(sql`select 1`)).rejects.toThrow("database work outside a scope");
  await expect(db.transaction((tx) => tx.execute(sql`select 1`))).rejects.toThrow("database work outside a scope");
  await expect(inScope(SYSTEM, () => db.transaction((tx) => tx.execute(sql`select 1`)))).resolves.toBeDefined();
});

test("the recorder flags a statement touching B's id under A's scope", async () => {
  const recorder = await recordScopes();
  recorder.register("run_b", "ws_b");
  await inScope({ workspaceId: "ws_a" }, () => recorder.db.execute(sql`select ${"run_b"}::text`));
  expect(recorder.statements).toEqual([expect.objectContaining({ scope: { workspaceId: "ws_a" }, params: ["run_b"] })]);
  expect(() => recorder.expectNoCrossScope()).toThrow(/run_b/);
});

test("the recorder passes when ids match", async () => {
  const recorder = await recordScopes();
  recorder.register("run_a", "ws_a");
  recorder.register("run_b", "ws_b");
  await inScope({ workspaceId: "ws_a" }, () => recorder.db.execute(sql`select ${"run_a"}::text`));
  await inScope(SYSTEM, () => recorder.db.execute(sql`select ${"run_b"}::text`));
  expect(() => recorder.expectNoCrossScope()).not.toThrow();
});

test("migrations run under SYSTEM", async () => {
  const { db, statements } = await recordScopes();
  await migrateDb(db);
  expect(statements.length).toBeGreaterThan(0);
  expect(statements.every((s) => s.scope === SYSTEM)).toBe(true);
});
