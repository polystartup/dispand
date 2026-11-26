import { call } from "@orpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { audit, harnesses, runs, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { launchedStep, asCli, ownerContext, runnerWithClis } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import { EngineError } from "./errors.ts";
import type { HarnessAdapter } from "./harness.ts";

// Two engine paths on one run, at once: a stop against the step's end, or against a question the
// step asks. Each takes the run's row first (`lockRun`), so on PostgreSQL behind a pool
// (`DISPAND_TEST_DATABASE_URL`) the second waits for the first instead of deadlocking. There, each
// race is also forced into the order that deadlocked (`forced`). On PGlite's one connection the
// paths still interleave by transaction.

const ROUNDS = 25;
const FORCED = 3;
/** How long a forced round waits for each transaction to reach its lock: a loaded machine takes seconds. */
const WAIT = { timeout: 10_000 };
const pooled = !!process.env.DISPAND_TEST_DATABASE_URL;

const settle = (p: Promise<unknown>): Promise<PromiseSettledResult<unknown>> => p.then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));

/** The other sessions of this database: waiting for a lock (`waiting`), or doing anything at all. */
async function sessions(db: Db, waiting: boolean): Promise<number> {
  const filter = waiting ? sql`wait_event_type = 'Lock'` : sql`state <> 'idle'`;
  const { rows } = (await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and ${filter}`)) as unknown as { rows: { n: number }[] };
  return rows[0]!.n;
}

/**
 * The step's row is held by another transaction while `step` (a session event) waits for it, then
 * `stop` runs until it waits too, then the row is let go. Without the run locked first, the stop
 * holds the run and waits for the step, which the event takes first and then needs the run (its
 * question's foreign key, or its step's row written twice, whose foreign keys are checked again).
 */
async function forced(db: Db, runId: string, step: () => Promise<unknown>, stop: () => Promise<unknown>) {
  // Nothing of an earlier round still under way.
  await vi.waitFor(async () => expect(await sessions(db, false)).toBe(0), WAIT);
  let held!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => (held = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const holder = db.transaction(async (tx) => {
    await tx.select({ id: stepRuns.id }).from(stepRuns).where(eq(stepRuns.runId, runId)).for("no key update");
    held();
    await gate;
  });
  await locked;
  try {
    const first = settle(step());
    await vi.waitFor(async () => expect(await sessions(db, true)).toBe(1), WAIT);
    const second = settle(stop());
    await vi.waitFor(async () => expect(await sessions(db, true)).toBe(2), WAIT);
    release();
    return await Promise.all([first, second]);
  } finally {
    release();
    await holder;
  }
}

class Adapter implements HarnessAdapter {
  start = async () => true;
  send = async () => true;
  answer = async () => true;
  stop = async () => true;
}

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "acceptEdits" }, { context }));
  // Every Job's step runs at once: none waits for a slot.
  await context.db.update(harnesses).set({ maxWorking: 100 }).where(eq(harnesses.id, harness.id));
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Write a note.", config: { kind: "manual", placement: "button" } }, { context });
  const engine = new Engine(context.db, new Adapter());
  onTestFinished(() => engine.stop());
  let seq = 0;
  /** A Job whose one step's session is running. */
  const job = async () => {
    const runId = await engine.startJob(trigger.id, context.ownerId);
    return { runId, sessionId: (await launchedStep(context.db, runId)).sessionId };
  };
  const emit = (sessionId: string, event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  /** `race(job)` for each of `FORCED` Jobs forced into the order that deadlocked (on PostgreSQL), then for `ROUNDS` Jobs at once. */
  const races = async (race: (j: { runId: string; sessionId: string }, i: number) => [() => Promise<unknown>, () => Promise<unknown>]) => {
    const ids: string[] = [];
    const results: PromiseSettledResult<unknown>[] = [];
    for (let i = 0; pooled && i < FORCED; i++) {
      const j = await job();
      ids.push(j.runId);
      results.push(...(await forced(context.db, j.runId, ...race(j, i))));
    }
    const batch = [];
    for (let i = 0; i < ROUNDS; i++) batch.push(await job());
    ids.push(...batch.map((j) => j.runId));
    results.push(...(await Promise.all(batch.flatMap((j, i) => race(j, FORCED + i).map((go) => settle(go()))))));
    // Each race ends without an error but a stop refused because the run had ended first.
    expect(results.flatMap((r) => (r.status === "rejected" && !(r.reason instanceof EngineError && r.reason.code === "CLOSED") ? [r.reason] : []))).toEqual([]);
    return ids;
  };
  /** Each run ended once: no step of it open, one `job.finished` or `job.failed` row each. */
  const endedOnce = async (ids: string[]) => {
    expect(await context.db.select().from(stepRuns).where(and(inArray(stepRuns.runId, ids), inArray(stepRuns.status, ["pending", "running", "waiting"])))).toEqual([]);
    const ends = await context.db.select({ jobId: audit.jobId }).from(audit).where(and(inArray(audit.jobId, ids), inArray(audit.action, ["job.finished", "job.failed"])));
    expect(ends.map((e) => e.jobId).sort()).toEqual([...ids].sort());
  };
  return { db: context.db, engine, emit, races, endedOnce };
}

test("a stop raced against its step's end: one end of the Job, never a deadlock", async () => {
  const { db, engine, emit, races, endedOnce } = await setup();
  // The step ends with its result, or (every other one) fails.
  const ids = await races(({ runId, sessionId }, i) => [
    () => emit(sessionId, i % 2 ? { type: "error", message: "Gone." } : { type: "result", text: "Done." }),
    () => engine.stopRun(runId),
  ]);
  const ended = await db.select({ status: runs.status }).from(runs).where(inArray(runs.id, ids));
  expect(ended.map((r) => r.status).filter((s) => s !== "succeeded" && s !== "failed")).toEqual([]);
  await endedOnce(ids);
  // 8 s alone, several times that with other suites running: past the 30 s default.
}, 120_000);

test("a stop raced against a question its step asks: the Job ends once, never a deadlock", async () => {
  const { db, engine, emit, races, endedOnce } = await setup();
  const ids = await races(({ runId, sessionId }, i) => [
    () => emit(sessionId, { type: "question", questionId: `rq_${i}`, payload: { kind: "permission", toolName: "Bash", input: { command: "npm test" }, canAlwaysAllow: false } }),
    () => engine.stopRun(runId),
  ]);
  expect((await db.select({ status: runs.status }).from(runs).where(inArray(runs.id, ids))).map((r) => r.status)).toEqual(ids.map(() => "failed"));
  await endedOnce(ids);
}, 120_000);
