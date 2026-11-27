import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Client, Pool } from "pg";
import { errorCode, errorKind, logError } from "../log.ts";
import { meter } from "../telemetry/index.ts";
import * as schema from "./schema.ts";
import { inScope, setTenancy, SYSTEM, type Tenancy } from "./scope.ts";

/** What both drivers share: callers can't reach node-postgres- or PGlite-only APIs. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
/** A transaction of `Db`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const defaultMigrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const lost = meter("db").counter("dispand.db.connections.lost", { description: "Idle pool connections the database ended, by error kind" });

/**
 * Keeps the process up when PostgreSQL ends one of `pool`'s connections (a restart,
 * `pg_terminate_backend`, `idle_session_timeout`, a failover). node-postgres emits `error` on the
 * pool for an idle client and on the client itself for a checked-out one (a transaction's): with
 * no listener, Node throws it. The pool drops the dead client and opens another on the next query;
 * a statement that was using it fails to its caller. A pool that already listens (a database
 * adapter's own handling) keeps its listener alone.
 */
function keepUp(pool: Pool): void {
  pool.on("connect", (client) => client.on("error", () => {}));
  if (pool.listenerCount("error") > 0) return;
  pool.on("error", (err) => {
    logError("database connection lost", err);
    const code = errorCode(err);
    lost.add(1, { "error.type": errorKind(err), ...(code && { "db.response.status_code": code }) });
  });
}

/** The driver's client: a node-postgres pool ends, a PGlite closes. */
const clientOf = (db: Db) => (db as unknown as { $client: { end?: () => Promise<void>; close?: () => Promise<void> } }).$client;

/** Closes the connections `openDb` opened (pool or PGlite), so the process can exit. */
export async function closeDb(db: Db): Promise<void> {
  const client = clientOf(db);
  await (client.end ?? client.close)?.call(client);
}

/** Throws unless the database answers a query (the readiness probe). */
export async function pingDb(db: Db): Promise<void> {
  await inScope(SYSTEM, () => db.execute(sql`select 1`));
}

/**
 * Opens the database without migrating it.
 * `client` is a URL, `postgres://…` (node-postgres) or `pglite://memory` / `pglite:///path` (PGlite),
 * or a node-postgres pool (a database adapter's). Either pool outlives a connection the database
 * ends (`keepUp`). `tenancy` splits work that spans workspaces (default `shared`).
 */
export async function openDb(client: string | Pool, options: { tenancy?: Tenancy } = {}): Promise<Db> {
  const db = await driverFor(client);
  if (options.tenancy) setTenancy(db, options.tenancy);
  return db;
}

async function driverFor(client: string | Pool): Promise<Db> {
  if (typeof client === "string" && client.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const location = client.slice("pglite://".length);
    return drizzle(new PGlite(location === "memory" ? undefined : location), { schema });
  }
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const db = typeof client === "string" ? drizzle(client, { schema }) : drizzle(client, { schema });
  keepUp(db.$client);
  return db;
}

/**
 * Applies pending migrations to a database `openDb` opened.
 * `migrationsFolder` defaults to the package's own `drizzle` folder.
 */
export async function migrateDb(db: Db, migrationsFolder = defaultMigrationsFolder): Promise<void> {
  // Migrations span every workspace.
  await inScope(SYSTEM, async () => {
    if (clientOf(db).end) {
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
    } else {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
    }
  });
}

/** `url`'s database held for this process's engine (`lockDatabase`). */
export type DatabaseLock = {
  /**
   * Settles once the lock is lost with its connection (a restart, `pg_terminate_backend`, a server
   * gone silent): another process may take it at once, while this one's pool still writes.
   */
  refused: Promise<DatabaseLocked>;
  /** What `refused` settles with, set as it settles: a start checks it before it begins. */
  refusal?: DatabaseLocked;
  release(): Promise<void>;
};

/** `lockDatabase`'s refusal: another process runs the engine on this database. */
export class DatabaseLocked extends Error {
  constructor() {
    super("Another Dispand process runs on this database");
    this.name = "DatabaseLocked";
  }
}

/**
 * The engine lock's key: "dispand" in ASCII, past the 32 bits of the `hashtext` keys the
 * transaction locks take, so none of them can wait on it.
 */
const ENGINE_LOCK = "28263442198654564";

/** The engine lock on a connection of its own, or `DatabaseLocked` if another session holds it. */
async function takeLock(url: string): Promise<Client> {
  const { default: pg } = await import("pg");
  // Nothing is sent on it once the lock is held, so both ends probe it (TCP keepalive). This one
  // gives up on a silent server (a lost host, a failover) after about 20 s: 10 s, then Node's 10
  // probes 1 s apart. PostgreSQL gives up on a silent client sooner (15 s, below), so a lock lost
  // that way is free again by the time this process's successor starts.
  const client = new pg.Client({ connectionString: url, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  // Unheard, an `error` would end the process. Until the lock is held, a failure reaches the
  // caller through `connect` or the query instead.
  client.on("error", () => {});
  await client.connect();
  try {
    // Never ended for being idle: the lock lasts as long as the process.
    await client.query("set idle_session_timeout = 0; set tcp_keepalives_idle = 5; set tcp_keepalives_interval = 1; set tcp_keepalives_count = 10");
    const { rows } = await client.query<{ locked: boolean }>(`select pg_try_advisory_lock(${ENGINE_LOCK}) as locked`);
    if (!rows[0]?.locked) throw new DatabaseLocked();
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

/**
 * Holds `url`'s database for this process: a session advisory lock on a connection of its own,
 * outside any pool (closing the pool never waits for it), until `release`. One process per
 * database runs the engine; another that tries gets `DatabaseLocked` at once. A lock lost with its
 * connection (closed, or silent for about 20 s) settles `refused` at once: it isn't taken again, since
 * another process may hold it by then while this one's engine still writes through its pool, and the
 * process ends instead. Nothing to take on PGlite, which only its own process opens.
 */
export async function lockDatabase(url: string): Promise<DatabaseLock> {
  if (url.startsWith("pglite:")) return { refused: new Promise(() => {}), release: async () => {} };
  const client = await takeLock(url);
  let released = false;
  let refuse: (refusal: DatabaseLocked) => void = () => {};
  const lock: DatabaseLock = {
    refused: new Promise((resolve) => (refuse = resolve)),
    release: async () => {
      released = true;
      await client.end();
    },
  };
  // A lost connection emits `error` once or twice (the server's reason first, when it gives one:
  // that one is logged), then `end`.
  client.once("error", (err) => logError("database lock lost", err));
  client.once("end", () => {
    if (released) return;
    lock.refusal = new DatabaseLocked();
    refuse(lock.refusal);
  });
  return lock;
}

/** Opens the database and applies pending migrations (`openDb`, then `migrateDb`). */
export async function createDb(url: string, migrationsFolder = defaultMigrationsFolder): Promise<Db> {
  const db = await openDb(url);
  try {
    await migrateDb(db, migrationsFolder);
    return db;
  } catch (error) {
    // Startup retries on the next request. Return the failed pool or database directory first.
    await closeDb(db);
    throw error;
  }
}
