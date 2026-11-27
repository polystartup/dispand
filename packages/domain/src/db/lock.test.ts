import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { captureTelemetry } from "../telemetry/testing.ts";
import { closeDb, DatabaseLocked, lockDatabase, openDb, type Db } from "./client.ts";
import { inScope, SYSTEM } from "./scope.ts";

const SERVER = process.env.DISPAND_TEST_DATABASE_URL;

const rows = async <T>(db: Db, query: string) => ((await inScope(SYSTEM, () => db.execute(sql.raw(query)))) as unknown as { rows: T[] }).rows;
/** The engine lock in `pg_locks` (its key's high and low 32 bits), in the database `database` names. */
const engineLock = (database: string) =>
  `locktype = 'advisory' and classid = 6580595 and objid = 1885433444 and objsubid = 1 and database = (select oid from pg_database where datname = ${database})`;
/** The backends holding the engine lock. */
const holders = async (db: Db, database = "current_database()") =>
  (await rows<{ pid: number }>(db, `select pid from pg_locks where ${engineLock(database)} and granted`)).map((r) => r.pid);
/** Ends a backend, as a restart or an administrator would. */
const terminate = (db: Db, pid: number) => rows(db, `select pg_terminate_backend(${pid})`);

test("on PGlite there is nothing to take: only its own process opens it", async () => {
  const lock = await lockDatabase("pglite://memory");
  const second = await lockDatabase("pglite://memory");
  await Promise.all([lock.release(), second.release()]);
});

test.skipIf(!SERVER)("a lock its connection lost is refused at once, even with the database free: the process ends before another takes it", async () => {
  const telemetry = await captureTelemetry();
  onTestFinished(telemetry.stop);
  const admin = await openDb(SERVER!);
  onTestFinished(() => closeDb(admin));
  const lock = await lockDatabase(SERVER!);
  onTestFinished(() => lock.release());
  await expect(lockDatabase(SERVER!)).rejects.toBeInstanceOf(DatabaseLocked);
  expect(lock.refusal).toBeUndefined();
  await terminate(admin, (await holders(admin))[0]!);
  const refusal = await lock.refused;
  expect(refusal).toBeInstanceOf(DatabaseLocked);
  // Kept on the lock as well, for a start that must not begin on it; nothing took it again.
  expect(lock.refusal).toBe(refusal);
  expect(await holders(admin)).toEqual([]);
  // The loss once, by its kind and SQLSTATE only.
  expect(
    telemetry
      .logs()
      .filter((r) => r.body === "database lock lost")
      .map((r) => r.attributes),
  ).toEqual([{ "error.type": "error", "db.response.status_code": "57P01" }]);
  expect(await telemetry.all()).not.toContain("terminating connection");
});

test.skipIf(!SERVER)("a released lock is free again, and its release refuses nothing", async () => {
  const lock = await lockDatabase(SERVER!);
  await lock.release();
  expect(lock.refusal).toBeUndefined();
  await (await lockDatabase(SERVER!)).release();
});
