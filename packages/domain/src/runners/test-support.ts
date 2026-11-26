import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { call } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { onTestFinished } from "vitest";
import { createAuth } from "../auth.ts";
import { DataEvents } from "../data/events.ts";
import { closeDb, createDb, openDb, type Db } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { ACTIVE_RUN } from "../engine/discovery.ts";
import type { Engine } from "../engine/engine.ts";
import { createSecretBox } from "../secrets.ts";
import { createMcpConnector } from "../tools/mcp.ts";
import { RunnerHub } from "./hub.ts";
import { ORGANIZATION_HEADER, WORKSPACE_HEADER } from "../workspace/authorize.ts";

let shared: Promise<Db> | undefined;

/**
 * The worker's database, emptied: call it once per test. A PGlite takes seconds and hundreds of MB
 * to boot, so each worker opens one, migrated once, and truncates every public table (as the
 * database lists them, so new tables are covered) for each test that asks for it. Fixtures insert
 * several workspaces, so the one-workspace limit is off; `limitOn` turns it on for the test.
 */
export async function testDb(): Promise<Db> {
  shared ??= workerDb();
  const db = await shared;
  await db.execute(sql`do $$ begin
    execute (select 'truncate ' || string_agg(format('%I', tablename), ', ') || ' restart identity cascade' from pg_tables where schemaname = 'public');
  end $$`);
  await db.execute(sql`alter table workspaces disable trigger workspaces_limit`);
  return db;
}

/**
 * A PGlite, or with `DISPAND_TEST_DATABASE_URL` (`postgres://…`, a server for these tests only:
 * `dispand_test_<worker>` is dropped and made afresh) a database of that server behind a
 * connection pool: what a PGlite's one connection never shows (two transactions interleaving)
 * happens there. The fixtures that record statements (`recordingDb`, `recordScopes`) wrap a
 * PGlite's client: their tests need PGlite.
 */
async function workerDb(): Promise<Db> {
  // The database session runs outside UTC, so a time written or read in the wrong zone fails a test.
  const zone = "America/Phoenix";
  const url = process.env.DISPAND_TEST_DATABASE_URL;
  if (!url) {
    const db = await createDb("pglite://memory");
    await db.execute(sql.raw(`set timezone to '${zone}'`));
    return db;
  }
  const name = `dispand_test_${process.env.VITEST_POOL_ID ?? "0"}`;
  const server = await openDb(url);
  await server.execute(sql.raw(`drop database if exists ${name} with (force)`));
  await server.execute(sql.raw(`create database ${name}`));
  // Every connection of the pool, not only one session.
  await server.execute(sql.raw(`alter database ${name} set timezone to '${zone}'`));
  await closeDb(server);
  const own = new URL(url);
  own.pathname = `/${name}`;
  return createDb(own.toString());
}

/** Turns the install's one-workspace limit back on in the worker's database until the next `testDb()`. */
export async function limitOn(db: Db): Promise<void> {
  await db.execute(sql`alter table workspaces enable trigger workspaces_limit`);
}

/** `db` (default: the worker's database, emptied) through a client that records the statements it sends (CI has no Postgres). */
export async function recordingDb(over?: Db) {
  const statements: string[] = [];
  const { $client } = (over ?? (await testDb())) as unknown as { $client: PGlite };
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
  // No cloud session reaches a provider: a turn waits until its Job is stopped, so a Job on a test
  // harness stays running for the whole test instead of failing whenever the provider answers.
  const engine = createEngine(db, hub, secrets, dataEvents, { client: () => ({ turn: () => new Promise(() => {}) }) });
  onTestFinished(async () => {
    await hub.close();
    await engine.stop();
  });
  const filesDir = await mkdtemp(join(tmpdir(), "dispand-files-"));
  onTestFinished(() => rm(filesDir, { recursive: true, force: true }));
  const setupCode = "test-setup-code-0123456789";
  return { db, authDb: db, auth, hub, engine, dataEvents, secrets, tools: createMcpConnector(), filesDir, setupCode, headers: new Headers(), resHeaders: new Headers() };
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
  const [workspace] = await context.db.select({ workspaceId: schema.workspaces.id, organizationId: schema.workspaces.organizationId }).from(schema.workspaces);
  return { ...context, ownerId, ...workspace!, headers: new Headers({ cookie }) };
}

/**
 * A second workspace of the owner's organization, and the owner's requests pinned to each (with two,
 * a request names its workspace). What a test makes through `b` is the second workspace's, and so is
 * every row it names: a database may keep each reference within one workspace.
 */
export async function secondWorkspace(owner: Awaited<ReturnType<typeof ownerContext>>, workspaceId = "ws_b") {
  await owner.db.insert(schema.workspaces).values({ id: workspaceId, organizationId: owner.organizationId });
  const at = (id: string) => ({ ...owner, workspaceId: id, headers: new Headers({ cookie: owner.headers.get("cookie")!, [ORGANIZATION_HEADER]: owner.organizationId, [WORKSPACE_HEADER]: id }) });
  return { a: at(owner.workspaceId), b: at(workspaceId) };
}

/** A runner and a harness on it, inserted in `workspaceId`, for a fixture's agent of that workspace. */
export async function harnessIn(db: Db, workspaceId: string, ownerId: string, harnessId = `harness_${workspaceId}`) {
  const runnerId = `runner_${harnessId}`;
  await db.insert(schema.runners).values({ id: runnerId, workspaceId, ownerId, name: "Elsewhere" });
  await db.insert(schema.harnesses).values({ id: harnessId, workspaceId, ownerId, name: "Elsewhere", runnerId, kind: "claude-code", permissionMode: "default" });
  return { runnerId, harnessId };
}

/**
 * Another person of the owner's organization, signed in on the same app: an organization member
 * with `role` in the owner's workspace. Gives the context their requests get.
 */
export async function personContext(owner: Awaited<ReturnType<typeof ownerContext>>, id: string, role: "manager" | "member") {
  const email = `${id}@example.com`;
  const password = `${id}'s password`;
  await owner.db.insert(schema.user).values({ id, name: id, email });
  await owner.db.insert(schema.account).values({ id: `acct_${id}`, accountId: id, providerId: "credential", userId: id, password: await (await owner.auth.$context).password.hash(password) });
  await owner.db.insert(schema.organizationMembers).values({ organizationId: owner.organizationId, userId: id, role: "member" });
  await owner.db.insert(schema.workspaceMembers).values({ workspaceId: owner.workspaceId, userId: id, role });
  const res = await owner.auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { ...owner, ownerId: id, headers: new Headers({ cookie }) };
}

/**
 * Approves a Job's proposal as `userId`'s answer to its approval does (`questions.answer`), straight
 * in the rows: the proposal approved, its approval answered by them, so a manager's item checks them.
 */
export async function approveAs(db: Db, proposalId: string, userId: string) {
  const [proposal] = await db.select({ runId: schema.proposals.runId }).from(schema.proposals).where(eq(schema.proposals.id, proposalId));
  const questionId = `q_${proposalId}`;
  await db.insert(schema.questions).values({
    id: questionId, ownerId: userId, addresseeId: userId, runId: proposal!.runId, placement: "notifications", kind: "approval", status: "answered", proposalId,
    payload: { kind: "permission", toolName: "request_approval", input: { proposal: proposalId }, canAlwaysAllow: false },
    answer: { kind: "permission", decision: "allow" }, answeredAt: new Date(), answeredBy: { type: "user", userId },
  });
  await db.update(schema.proposals).set({ status: "approved", questionId }).where(eq(schema.proposals.id, proposalId));
}

/** A fixture runner whose last report detected both CLIs. */
export async function runnerWithClis(context: Awaited<ReturnType<typeof ownerContext>>, name = "Workstation") {
  const runner = await call(router.runners.create, { name }, { context });
  await context.db.update(schema.runners).set({
    clis: { claude: "2.1.248", codex: { version: "0.166.0", signedIn: true } },
    lastSeenAt: new Date(),
  }).where(eq(schema.runners.id, runner.runnerId));
  return runner;
}

/** Starts a real Job in the owner's workspace so owner-session tests reach the procedure's guard. */
export async function jobIdentity(context: Awaited<ReturnType<typeof ownerContext>>, agentId?: string) {
  if (!agentId) {
    const { runnerId } = await runnerWithClis(context, "Job runner");
    const harness = await call(router.harnesses.create, { name: "Job harness", runnerId, kind: "codex", permissionMode: "default" }, { context });
    const agent = await call(router.agents.create, { name: "Job agent", harnessId: harness.id, systemPrompt: "" }, { context });
    agentId = agent.id;
  }
  const trigger = await call(router.triggers.create, { name: "Start", agentId, instructions: "Start the job", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  return { runId, ownerId: context.ownerId, workspaceId: context.workspaceId, agentId };
}

/** Makes a test Job one a schedule fired: no person stands behind it, so it has no person's rights. */
export async function firedBySchedule(context: { db: Db }, runId: string) {
  await context.db.update(schema.runs).set({ cause: { kind: "schedule", scheduledFor: new Date().toISOString(), depth: 0 } }).where(eq(schema.runs.id, runId));
}

/**
 * What `read` gives once it gives something, read again at each event of the run (each published
 * once its change is written): it waits as long as the run's work takes, where a poll gives up
 * after a fixed time.
 */
export function whenRun<T>(engine: Engine, runId: string, read: () => Promise<T | undefined>): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () =>
      read().then((value) => {
        if (value === undefined) return;
        unsubscribe();
        resolve(value);
      }, reject);
    const unsubscribe = engine.events.subscribe(runId, () => void check());
    void check();
  });
}

/** The run once it has ended (`whenRun`). */
export function runEnded(engine: Engine, runId: string): Promise<typeof schema.runs.$inferSelect> {
  return whenRun(engine, runId, async () => {
    const [run] = await engine.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    return run && !ACTIVE_RUN.includes(run.status) ? run : undefined;
  });
}

/** Narrows a harness view to a CLI one, for tests that made it so. */
export function asCli<H extends { type: string }>(harness: H): Extract<H, { type: "cli" }> {
  if (harness.type !== "cli") throw new Error("expected a CLI harness");
  return harness as Extract<H, { type: "cli" }>;
}
export { openGuardedDb, recordScopes } from "../db/test-support.ts";
