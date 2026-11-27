import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "drizzle-orm";
import pg from "pg";
import ts from "typescript";
import { expect, onTestFinished, test, vi } from "vitest";
import { captureTelemetry } from "../telemetry/testing.ts";
import { closeDb, openDb, pingDb, type Db } from "./client.ts";
import { inScope, SYSTEM } from "./scope.ts";

// PostgreSQL ending a pool's connection (a restart, `pg_terminate_backend`, `idle_session_timeout`,
// a failover) makes node-postgres emit `error`, which with no listener ends the process.

const SERVER = process.env.DISPAND_TEST_DATABASE_URL;
const LOST = "dispand.db.connections.lost";
const poolOf = (db: Db) => (db as unknown as { $client: pg.Pool }).$client;
/** What node-postgres emits for a connection the server ended, with a sentinel no telemetry may carry. */
const ended = () => Object.assign(new Error("terminating connection due to administrator command SENTINEL"), { code: "57P01" });

test("openDb listens on the pool it opens or gets, and on each client the pool opens", async () => {
  const telemetry = await captureTelemetry();
  onTestFinished(telemetry.stop);
  // Never connected: the events are emitted by hand.
  for (const db of [await openDb("postgres://localhost:1/none"), await openDb(new pg.Pool({ connectionString: "postgres://localhost:1/none" }))]) {
    onTestFinished(() => closeDb(db));
    const pool = poolOf(db);
    pool.emit("error", ended(), new EventEmitter());
    const client = new EventEmitter();
    pool.emit("connect", client);
    client.emit("error", ended());
  }
  const counted = (await telemetry.metrics()).filter((m) => m.name === LOST);
  expect(counted).toEqual([{ name: LOST, attributes: { "error.type": "Error", "db.response.status_code": "57P01" } }]);
  expect(telemetry.logs().filter((r) => r.body === "database connection lost")).toHaveLength(2);
  expect(await telemetry.all()).not.toContain("SENTINEL");
});

test("a pool that already listens for errors keeps its own listener alone", async () => {
  const telemetry = await captureTelemetry();
  onTestFinished(telemetry.stop);
  const pool = new pg.Pool({ connectionString: "postgres://localhost:1/none" });
  const own = vi.fn();
  pool.on("error", own);
  const db = await openDb(pool);
  onTestFinished(() => closeDb(db));
  pool.emit("error", ended(), new EventEmitter());
  expect(own).toHaveBeenCalledOnce();
  expect((await telemetry.metrics()).filter((m) => m.name === LOST)).toEqual([]);
  // A checked-out client is still kept from throwing.
  const client = new EventEmitter();
  pool.emit("connect", client);
  client.emit("error", ended());
});

const backendPid = async (db: Db) => {
  const result = await inScope(SYSTEM, () => db.execute(sql`select pg_backend_pid() as pid`));
  return (result as unknown as { rows: { pid: number }[] }).rows[0]!.pid;
};

/** Ends one backend from a connection of its own, as a restart or an administrator would. */
async function terminate(pid: number) {
  const admin = new pg.Client({ connectionString: SERVER });
  await admin.connect();
  try {
    await admin.query("select pg_terminate_backend($1)", [pid]);
  } finally {
    await admin.end();
  }
}

// Waits on `remove` and `end`, never with an `error` listener of the test's: one would keep the
// process up whatever openDb does.
test.skipIf(!SERVER)("an idle connection the server ends doesn't end the process, and the next query opens another", async () => {
  const telemetry = await captureTelemetry();
  onTestFinished(telemetry.stop);
  const db = await openDb(SERVER!);
  onTestFinished(() => closeDb(db));
  const pid = await backendPid(db);
  const removed = new Promise((resolve) => poolOf(db).once("remove", resolve));
  await terminate(pid);
  await removed;
  expect(await telemetry.metrics()).toContainEqual({ name: LOST, attributes: { "error.type": "error", "db.response.status_code": "57P01" } });
  expect(await backendPid(db)).not.toBe(pid);
});

test.skipIf(!SERVER)("a connection the server ends inside a transaction fails that transaction, not the process", async () => {
  const db = await openDb(SERVER!);
  onTestFinished(() => closeDb(db));
  const pool = poolOf(db);
  let client: pg.PoolClient | undefined;
  pool.once("acquire", (c: pg.PoolClient) => (client = c));
  const transaction = inScope(SYSTEM, () =>
    db.transaction(async (tx) => {
      const pid = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as { rows: { pid: number }[] };
      const gone = new Promise((resolve) => client!.once("end", resolve));
      await terminate(pid.rows[0]!.pid);
      // The client has emitted its `error` while still checked out.
      await gone;
      await tx.execute(sql`select 1`);
    }),
  );
  await expect(transaction).rejects.toThrow();
  await pingDb(db);
});

test.skipIf(!SERVER)("a connection the server ends while a transaction begins gives its pool slot back", async () => {
  const db = await openDb(SERVER!);
  onTestFinished(() => closeDb(db));
  const pool = poolOf(db);
  // The transaction's `begin` waits until the server has ended the client's connection.
  pool.once("acquire", (client: pg.PoolClient & { processID: number }) => {
    const query = client.query;
    client.query = (async (...args: Parameters<typeof query>) => {
      client.query = query;
      const gone = new Promise((resolve) => client.once("end", resolve));
      await terminate(client.processID);
      await gone;
      return (query as (...a: unknown[]) => unknown).apply(client, args);
    }) as typeof query;
  });
  await expect(inScope(SYSTEM, () => db.transaction(async () => {}))).rejects.toThrow();
  expect(pool.totalCount).toBe(0);
  await expect(inScope(SYSTEM, () => db.transaction(async (tx) => tx.execute(sql`select 1`)))).resolves.toBeDefined();
});

// Every file that loads node-postgres (or drizzle's driver for it, which makes a pool from a URL).
// A new one fails here until its pools go through `openDb` (which keeps them up) and it is listed.
const ALLOWED: Record<string, string> = {
  "packages/domain/src/db/client.ts": "opens the pools, and keeps each up (`keepUp`); the database lock's own clients listen for their errors",
  "packages/domain/src/db/connection-loss.test.ts": "this file's pools, through openDb; its admin client lives for one query",
  "packages/domain/src/data/files.test.ts": "a pool on PGlite's client, through openDb",
  "apps/web/package-check/entry.ts": "a database adapter's pool, through openDb",
};
const PG = ["pg", "drizzle-orm/node-postgres"];

/** Whether `path` loads node-postgres: an import, export, `import … = require`, `import()` or `require` of it that isn't type-only. */
function loadsPg(path: string): boolean {
  const text = readFileSync(path, "utf8");
  if (!/["'`](?:pg|drizzle-orm\/node-postgres)["'`]/.test(text)) return false;
  let loads = false;
  const visit = (node: ts.Node) => {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) && node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) specifier = node.moduleSpecifier;
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly) specifier = node.moduleSpecifier;
    else if (ts.isExternalModuleReference(node) && !node.parent.isTypeOnly) specifier = node.expression;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === "require"))
      specifier = node.arguments[0];
    if (specifier && ts.isStringLiteralLike(specifier) && PG.includes(specifier.text)) loads = true;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
  return loads;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

test("every file that loads node-postgres is one whose pools go through openDb", () => {
  const root = join(import.meta.dirname, "../../../..");
  const loading = ["apps", "packages"]
    .flatMap((dir) => sources(join(root, dir)))
    .filter(loadsPg)
    .map((file) => relative(root, file))
    .sort();
  expect(loading).toEqual(Object.keys(ALLOWED).sort());
});
