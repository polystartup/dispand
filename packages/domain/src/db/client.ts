import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import * as schema from "./schema.ts";
import { inScope, setTenancy, SYSTEM, type Tenancy } from "./scope.ts";

/** What both drivers share: callers can't reach node-postgres- or PGlite-only APIs. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
/** A transaction of `Db`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const defaultMigrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

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
 * or a node-postgres pool (a database adapter's). `tenancy` splits work that spans workspaces (default `shared`).
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
  return typeof client === "string" ? drizzle(client, { schema }) : drizzle(client, { schema });
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
