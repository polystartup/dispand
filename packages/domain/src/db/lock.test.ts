import { sql } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { captureTelemetry } from "../telemetry/testing.ts";
import { closeDb, DatabaseLocked, lockDatabase, openDb, type Db } from "./client.ts";
import { inScope, SYSTEM } from "./scope.ts";

const SERVER = process.env.DISPAND_TEST_DATABASE_URL;

const rows = async <T>(db: Db, query: string) => ((await inScope(SYSTEM, () => db.execute(sql.raw(query)))) as unknown as { rows: T[] }).rows;
/** The engine lock in `pg_locks` (its key's high and low 32 bits), in the database `database` names. */
const engineLock = (database: string) =>
  `locktype = 'advisory' and classid = 6580595 and objid = 1885433444 and objsubid = 1 and database = (select oid from pg_database where datname = ${database})`;
/** The backends holding the engine lock, and how many wait for it. */
const holders = async (db: Db, database = "current_database()") => (await rows<{ pid: number }>(db, `select pid from pg_locks where ${engineLock(database)} and granted`)).map((r) => r.pid);
const waiters = async (db: Db) => (await rows<{ pid: number }>(db, `select pid from pg_locks where ${engineLock("current_database()")} and not granted`)).length;
/** Ends a backend, as a restart or an administrator would. */
const terminate = (db: Db, pid: number) => rows(db, `select pg_terminate_backend(${pid})`);
const logged = (telemetry: Awaited<ReturnType<typeof captureTelemetry>>) => telemetry.logs().map((r) => r.body);

test("on PGlite there is nothing to take: only its own process opens it", async () => {
  const lock = await lockDatabase("pglite://memory");
  const second = await lockDatabase("pglite://memory");
  await Promise.all([lock.release(), second.release()]);
});

test.skipIf(!SERVER)("a lock its connection lost is taken again, and stays refused to another process", async () => {
  const telemetry = await captureTelemetry();
  onTestFinished(telemetry.stop);
  const admin = await openDb(SERVER!);
  onTestFinished(() => closeDb(admin));
  const lock = await lockDatabase(SERVER!);
  onTestFinished(() => lock.release());
  await expect(lockDatabase(SERVER!)).rejects.toBeInstanceOf(DatabaseLocked);
  const [pid] = await holders(admin);
  await terminate(admin, pid!);
  // The process stays up and holds the database again, on a connection of its own.
  await vi.waitFor(() => expect(logged(telemetry)).toContain("database lock taken again"), { timeout: 10_000 });
  const [again] = await holders(admin);
  expect(again).toBeDefined();
  expect(again).not.toBe(pid);
  expect(lock.refusal).toBeUndefined();
  await expect(lockDatabase(SERVER!)).rejects.toBeInstanceOf(DatabaseLocked);
  await lock.release();
  // Released, it is free again.
  await (await lockDatabase(SERVER!)).release();
  // The loss once, by its kind and SQLSTATE only.
  expect(telemetry.logs().filter((r) => r.body === "database lock lost").map((r) => r.attributes)).toEqual([{ "error.type": "error", "db.response.status_code": "57P01" }]);
  expect(await telemetry.all()).not.toContain("terminating connection");
});

test.skipIf(!SERVER)("a lock lost while the database can't be reached is tried again every 5 s until it is taken", async () => {
  const telemetry = await captureTelemetry();
  onTestFinished(telemetry.stop);
  const admin = await openDb(SERVER!);
  onTestFinished(() => closeDb(admin));
  // A database of its own, closed to new connections below as a restarting server would be.
  const name = "dispand_lock_test";
  await rows(admin, `drop database if exists ${name} with (force)`);
  await rows(admin, `create database ${name}`);
  onTestFinished(async () => {
    await rows(admin, `drop database if exists ${name} with (force)`);
  });
  const url = new URL(SERVER!);
  url.pathname = `/${name}`;
  const lock = await lockDatabase(url.toString());
  onTestFinished(() => lock.release());
  const timers = vi.spyOn(globalThis, "setTimeout");
  onTestFinished(() => timers.mockRestore());
  await rows(admin, `alter database ${name} allow_connections false`);
  await terminate(admin, (await holders(admin, `'${name}'`))[0]!);
  // Tried again at once, the connection refused: again in 5 s.
  await vi.waitFor(() => expect(timers).toHaveBeenCalledWith(expect.any(Function), 5_000), { timeout: 10_000 });
  expect(logged(telemetry)).not.toContain("database lock taken again");
  await rows(admin, `alter database ${name} allow_connections true`);
  await vi.waitFor(() => expect(logged(telemetry)).toContain("database lock taken again"), { timeout: 10_000 });
  expect(await holders(admin, `'${name}'`)).toHaveLength(1);
});

test.skipIf(!SERVER)("a lock another process took while its connection was gone is refused to it", async () => {
  const admin = await openDb(SERVER!);
  onTestFinished(() => closeDb(admin));
  const lock = await lockDatabase(SERVER!);
  onTestFinished(() => lock.release());
  let settled = false;
  void lock.refused.then(() => (settled = true));
  // Another process waits for it on a session of its own (`closeDb` ends that session, and its lock).
  const other = await openDb(SERVER!);
  onTestFinished(() => closeDb(other));
  const taken = rows(other, "select pg_advisory_lock(28263442198654564)");
  await vi.waitFor(async () => expect(await waiters(admin)).toBe(1), { timeout: 10_000 });
  expect(settled).toBe(false);
  expect(lock.refusal).toBeUndefined();
  await terminate(admin, (await holders(admin))[0]!);
  await taken;
  const refusal = await lock.refused;
  expect(refusal).toBeInstanceOf(DatabaseLocked);
  // Kept on the lock as well, for a start that must not begin on it.
  expect(lock.refusal).toBe(refusal);
  expect(await holders(admin)).toHaveLength(1);
});
