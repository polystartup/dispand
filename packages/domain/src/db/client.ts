import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

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
  await db.execute(sql`select 1`);
}

/**
 * Opens the database without migrating it.
 * `url` is `postgres://…` (node-postgres) or `pglite://memory` / `pglite:///path` (PGlite).
 */
export async function openDb(url: string): Promise<Db> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const location = url.slice("pglite://".length);
    return drizzle(new PGlite(location === "memory" ? undefined : location), { schema });
  }
  const { drizzle } = await import("drizzle-orm/node-postgres");
  return drizzle(url, { schema });
}

/**
 * Applies pending migrations to a database `openDb` opened.
 * `migrationsFolder` defaults to the one next to the source; a bundled server passes its own copy.
 */
export async function migrateDb(db: Db, migrationsFolder = defaultMigrationsFolder): Promise<void> {
  if (clientOf(db).end) {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
  }
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
