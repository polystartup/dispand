import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

/** What both drivers share: callers can't reach node-postgres- or PGlite-only APIs. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
/** A transaction of `Db`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const defaultMigrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Closes the connections `createDb` opened (pool or PGlite), so the process can exit. */
export async function closeDb(db: Db): Promise<void> {
  const client = (db as unknown as { $client: { end?: () => Promise<void>; close?: () => Promise<void> } }).$client;
  await (client.end ?? client.close)?.call(client);
}

/** Throws unless the database answers a query (the readiness probe). */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

/**
 * Opens the database and applies pending migrations.
 * `url` is `postgres://…` (node-postgres) or `pglite://memory` / `pglite:///path` (PGlite).
 * `migrationsFolder` defaults to the one next to the source; a bundled server passes its own copy.
 */
export async function createDb(url: string, migrationsFolder = defaultMigrationsFolder): Promise<Db> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const location = url.slice("pglite://".length);
    const client = new PGlite(location === "memory" ? undefined : location);
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    return db;
  }
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const db = drizzle(url, { schema });
  await migrate(db, { migrationsFolder });
  return db;
}
