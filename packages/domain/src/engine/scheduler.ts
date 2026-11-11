import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { runs, scheduleFires, schedules, triggerFires, triggers, workflows, workflowVersions, type ScheduleFireStatus } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { errorKind, logError } from "../log.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { latestFireBetween, nextFireAfter } from "../workflows/schedule.ts";
import { EngineError, runIssues, type Engine } from "./engine.ts";

/** How often the scheduler looks for due schedules. */
export const SCHEDULER_TICK_MS = 15_000;

const traces = tracer("scheduler");
const counts = meter("scheduler");

/** What firing one schedule came to: the run it created, or why none. */
type Fired = { runId: string | null; result: "started" | "already" | "skipped-overlap" | "refused" };

/** One fire in its own span, counted by kind and result, with how late it was claimed. */
function fired(kind: "workflow" | "trigger", at: Date, now: Date, work: () => Promise<Fired>): Promise<string | null> {
  return traces.startActiveSpan("scheduler.fire", { attributes: { "dispand.fire.kind": kind, "dispand.fire.scheduled_for": at.toISOString() } }, async (span) => {
    let result = "failed";
    try {
      const done = await work();
      result = done.result;
      if (done.runId) span.setAttribute("dispand.job.id", done.runId);
      return done.runId;
    } catch (err) {
      recordError(span, errorKind(err));
      throw err;
    } finally {
      span.setAttribute("dispand.fire.result", result);
      span.end();
      counts.counter("dispand.scheduler.fires").add(1, { "dispand.fire.kind": kind, "dispand.fire.result": result });
      counts.histogram("dispand.scheduler.lag", { unit: "ms", description: "How late a due schedule was claimed" }).record(now.getTime() - at.getTime(), { "dispand.fire.kind": kind });
    }
  });
}
/** The most schedules one tick claims; the rest wait for the next. */
const BATCH = 20;

/**
 * Fires schedules (a workflow's, and an agent's schedule triggers, whose fires are Jobs recorded
 * in `trigger_fires`), once per due time across restarts and processes. A tick claims due rows
 * (`FOR UPDATE SKIP LOCKED`), records each fire under the unique `(workflow_id, scheduled_for)`
 * and creates its run in the same transaction; runs go on after the commit, or on the next boot's
 * `recover()` if the process stops first. After downtime, missed times coalesce into one fire for
 * the latest; a fire while a run of the workflow is going is skipped, and one the workflow can't
 * run is refused, both recorded.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<unknown> | undefined;
  private readonly now: () => Date;
  /** Runs created whose `continueRun` failed: retried every tick (a restart's `recover()` covers the rest). */
  private readonly stalled = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly engine: Engine,
    opts: { now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Ticks now (the catch-up after downtime), then every `SCHEDULER_TICK_MS`; never two at once. */
  start(): void {
    if (this.timer) return;
    const run = () => {
      if (this.ticking) return;
      this.ticking = this.tick()
        .catch((err: unknown) => logError("scheduler.tick failed", err))
        .finally(() => (this.ticking = undefined));
    };
    run();
    this.timer = setInterval(run, SCHEDULER_TICK_MS);
    this.timer.unref();
  }

  /** Stops ticking and waits for a tick under way. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }

  /** Fires what is due and goes on with the runs it started (and those that failed to before); returns the new ones' ids. */
  async tick(): Promise<string[]> {
    // Each tick is the root of its own trace: the runs it creates carry its id.
    return traces.startActiveSpan("scheduler.tick", { root: true }, async (span) => {
      try {
        const started = await this.tickWork();
        span.setAttribute("dispand.scheduler.started", started.length);
        return started;
      } catch (err) {
        recordError(span, errorKind(err));
        throw err;
      } finally {
        span.end();
        counts.counter("dispand.scheduler.ticks").add(1);
      }
    });
  }

  private async tickWork(): Promise<string[]> {
    const started = await this.claim();
    for (const runId of [...this.stalled, ...started]) {
      try {
        await this.engine.continueRun(runId);
        this.stalled.delete(runId);
      } catch (err) {
        // Left as is, the run would stay `running` with nothing started, and every later fire skipped.
        this.stalled.add(runId);
        logError("scheduler.continueRun failed", err);
      }
    }
    return started;
  }

  /** The transaction of a tick: due fires recorded, their runs created (not started). */
  async claim(): Promise<string[]> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, true), lte(schedules.nextFireAt, now)))
        .orderBy(asc(schedules.nextFireAt))
        .limit(BATCH)
        .for("update", { skipLocked: true });
      const started: string[] = [];
      for (const s of due) {
        const at = latestFireBetween(s.cron, s.timezone, s.lastCheckedAt, now);
        if (at) {
          // Its own savepoint: one workflow that can't fire doesn't hold back the others. A fire
          // that failed (rolled back, nothing recorded) leaves its schedule due: the next tick
          // tries the same time again.
          try {
            const runId = await fired("workflow", at, now, () => tx.transaction((sp) => this.fire(sp, s.workflowId, s.ownerId, at)));
            if (runId) started.push(runId);
          } catch (err) {
            logError("scheduler.fire failed", err);
            continue;
          }
        }
        await tx
          .update(schedules)
          .set({ nextFireAt: nextFireAfter(s.cron, s.timezone, now), lastCheckedAt: now })
          .where(eq(schedules.workflowId, s.workflowId));
      }
      // An agent's schedule triggers, under the same rules; each fire is a Job.
      const dueTriggers = await tx
        .select()
        .from(triggers)
        .where(and(eq(triggers.kind, "schedule"), eq(triggers.enabled, true), lte(triggers.nextFireAt, now)))
        .orderBy(asc(triggers.nextFireAt))
        .limit(BATCH)
        .for("update", { skipLocked: true });
      for (const t of dueTriggers) {
        if (t.config.kind !== "schedule" || !t.lastCheckedAt) continue;
        const { cron, timezone } = t.config;
        const at = latestFireBetween(cron, timezone, t.lastCheckedAt, now);
        if (at) {
          try {
            const runId = await fired("trigger", at, now, () => tx.transaction((sp) => this.fireTrigger(sp, t, at)));
            if (runId) started.push(runId);
          } catch (err) {
            logError("scheduler.fireTrigger failed", err);
            continue;
          }
        }
        await tx
          .update(triggers)
          .set({ nextFireAt: nextFireAfter(cron, timezone, now), lastCheckedAt: now })
          .where(eq(triggers.id, t.id));
      }
      return started;
    });
  }

  /** Records the trigger's fire for `at` (once) and creates its Job, unless one is going (one at a time) or the engine refuses it. */
  private async fireTrigger(tx: Tx, trigger: typeof triggers.$inferSelect, at: Date): Promise<Fired> {
    const id = newId("fire");
    const [fire] = await tx
      .insert(triggerFires)
      .values({ id, ownerId: trigger.ownerId, triggerId: trigger.id, scheduledFor: at, status: "started" })
      .onConflictDoNothing()
      .returning({ id: triggerFires.id });
    // Already fired for this time (another process, or before a restart).
    if (!fire) return { runId: null, result: "already" };
    const record = (status: ScheduleFireStatus, set: { runId?: string; message?: string }) =>
      tx.update(triggerFires).set({ status, ...set }).where(eq(triggerFires.id, id));
    if (trigger.concurrency === "one-at-a-time") {
      const [active] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.triggerId, trigger.id), inArray(runs.status, ["running", "waiting"])))
        .limit(1);
      if (active) {
        await record("skipped-overlap", {});
        return { runId: null, result: "skipped-overlap" };
      }
    }
    const scheduledFor = at.toISOString();
    try {
      // In its own savepoint: a refusal leaves nothing of the Job behind, and the fire is kept.
      const runId = await tx.transaction((sp) =>
        this.engine.createJob(sp, {
          ownerId: trigger.ownerId,
          agentId: trigger.agentId,
          triggerId: trigger.id,
          cause: { kind: "schedule", scheduledFor, depth: 0 },
          firing: { type: "schedule", scheduledFor },
        }),
      );
      await record("started", { runId });
      return { runId, result: "started" };
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      await record("refused", { message: err.message });
      return { runId: null, result: "refused" };
    }
  }

  /** Records the fire for `at` (once) and creates its run unless one is going or the workflow can't run. */
  private async fire(tx: Tx, workflowId: string, ownerId: string, at: Date): Promise<Fired> {
    const id = newId("fire");
    const [fire] = await tx
      .insert(scheduleFires)
      .values({ id, ownerId, workflowId, scheduledFor: at, status: "started" })
      .onConflictDoNothing()
      .returning({ id: scheduleFires.id });
    // Already fired for this time (another process, or before a restart).
    if (!fire) return { runId: null, result: "already" };
    const record = (status: ScheduleFireStatus, set: { runId?: string; message?: string }) =>
      tx.update(scheduleFires).set({ status, ...set }).where(eq(scheduleFires.id, id));
    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.workflowId, workflowId), inArray(runs.status, ["running", "waiting"])))
      .limit(1);
    if (active) {
      await record("skipped-overlap", {});
      return { runId: null, result: "skipped-overlap" };
    }
    const [current] = await tx
      .select({ def: workflowVersions.def })
      .from(workflows)
      .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.version, workflows.currentVersion)))
      .where(eq(workflows.id, workflowId));
    const [issue] = current ? await runIssues(tx, ownerId, current.def) : [{ message: "The workflow no longer exists" }];
    if (issue) {
      await record("refused", { message: issue.message });
      return { runId: null, result: "refused" };
    }
    const runId = await this.engine.createRun(tx, workflowId, { type: "schedule", scheduledFor: at.toISOString() });
    await record("started", { runId });
    return { runId, result: "started" };
  }
}

const globalForScheduler = globalThis as { __dispandScheduler?: Scheduler };

/** The process's one scheduler (as `getHub`'s one hub). Call `start()` once after `engine.recover()`. */
export function getScheduler(db: Db, engine: Engine): Scheduler {
  return (globalForScheduler.__dispandScheduler ??= new Scheduler(db, engine));
}
