import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { call } from "@orpc/server";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { onTestFinished } from "vitest";
import { createAuth } from "../auth.ts";
import { DataEvents } from "../data/events.ts";
import { createDb, type Db } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { createSecretBox } from "../secrets.ts";
import { createMcpConnector } from "../tools/mcp.ts";
import { RunnerHub } from "./hub.ts";

let shared: Promise<Db> | undefined;

/**
 * The worker's database, emptied: call it once per test. A PGlite takes seconds and hundreds of MB
 * to boot, so each worker opens one, migrated once, and truncates every public table (as the
 * database lists them, so new tables are covered) for each test that asks for it.
 */
export async function testDb(): Promise<Db> {
  shared ??= createDb("pglite://memory");
  const db = await shared;
  await db.execute(sql`do $$ begin
    execute (select 'truncate ' || string_agg(format('%I', tablename), ', ') || ' restart identity cascade' from pg_tables where schemaname = 'public');
  end $$`);
  return db;
}

/** The worker's database, emptied, through a client that records the statements it sends (CI has no Postgres). */
export async function recordingDb() {
  const statements: string[] = [];
  const { $client } = (await testDb()) as unknown as { $client: PGlite };
  const db = drizzle($client, { schema, logger: { logQuery: (query) => statements.push(query) } }) as unknown as Db;
  return { db, statements };
}

/**
 * The context requests get, on an emptied database with no owner yet. When the test ends, it stops
 * what still uses the database, in the order the server shuts down: the hub's sockets, then the
 * engine's starts and deliveries still under way, which would write into the next test's tables.
 */
export async function emptyContext() {
  const db = await testDb();
  const auth = createAuth(db, { baseURL: "https://dispand.test", secret: "test-secret-test-secret-test-secret", rateLimit: false });
  const hub = new RunnerHub(db);
  const secrets = createSecretBox(randomBytes(32));
  const dataEvents = new DataEvents();
  const engine = createEngine(db, hub, secrets, dataEvents);
  onTestFinished(async () => {
    await hub.close();
    await engine.stop();
  });
  const filesDir = await mkdtemp(join(tmpdir(), "dispand-files-"));
  onTestFinished(() => rm(filesDir, { recursive: true, force: true }));
  const setupCode = "test-setup-code-0123456789";
  return { db, auth, hub, engine, dataEvents, secrets, tools: createMcpConnector(), filesDir, setupCode, headers: new Headers(), resHeaders: new Headers() };
}

/** An emptied database with the owner signed in: the context their requests get. */
export async function ownerContext() {
  const context = await emptyContext();
  const owner = { name: "Ada", email: "ada@example.com", password: "correct horse battery", setupCode: context.setupCode };
  const { ownerId } = await call(router.auth.setup, owner, { context });
  const res = await context.auth.api.signInEmail({ body: { email: owner.email, password: owner.password }, returnHeaders: true });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { ...context, ownerId, headers: new Headers({ cookie }) };
}

/** Narrows a harness view to a CLI one, for tests that made it so. */
export function asCli<H extends { type: string }>(harness: H): Extract<H, { type: "cli" }> {
  if (harness.type !== "cli") throw new Error("expected a CLI harness");
  return harness as Extract<H, { type: "cli" }>;
}
