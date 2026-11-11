import { and, asc, count, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, eventFires, events, runs, scheduleFires, schedules, triggerFires, triggers, workflows, workflowVersions, type EventFireStatus, type JobCause, type ScheduleFireStatus } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { errorKind, logError } from "../log.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { latestFireBetween, nextFireAfter } from "../workflows/schedule.ts";
import { CHAIN_LIMIT, EngineError, runIssues, type Engine } from "./engine.ts";
import { eventOutputs } from "./job-def.ts";

/** How often the scheduler looks for due schedules. */
export const SCHEDULER_TICK_MS = 15_000;

const traces = tracer("scheduler");
const counts = meter("scheduler");

/** What firing one schedule came to: the run it created, or why none. */
type Fired = { runId: string | null; result: "started" | "already" | "skipped-overlap" | "refused" | EventFireStatus };

/** One fire in its own span, counted by kind and result, with how late it was claimed. */
function fired(kind: "workflow" | "trigger" | "event", at: Date, now: Date, work: () => Promise<Fired>): Promise<string | null> {
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
/** The most events, and deferred fires, one tick takes; the rest wait for the next. */
const EVENT_BATCH = 100;
const HOUR_MS = 3_600_000;

type EventRow = typeof events.$inferSelect;
type TriggerRow = typeof triggers.$inferSelect;

/** Whether a primitive trigger watches this event: its table, its operation and, for an update, one of its fields. */
function watches(trigger: TriggerRow, event: EventRow): boolean {
  const config = trigger.config;
  if (config.kind !== "primitive" || config.tableId !== event.tableId || !config.operations.includes(event.operation)) return false;
  return event.operation !== "updated" || !config.fields || config.fields.some((f) => event.changedFieldIds.includes(f));
}

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
      started.push(...(await this.claimEvents(tx, now)));
      return started;
    });
  }

  /**
   * Primitive triggers: each trigger with deferred fires gets as many of its oldest tried again
   * as it has room for, then due events are claimed (`FOR UPDATE SKIP LOCKED`), each matched
   * against the owner's enabled primitive triggers: a fire recorded per match, once
   * (`event_fires`' unique key), and the event marked processed, deferred fires included.
   */
  private async claimEvents(tx: Tx, now: Date): Promise<string[]> {
    const started: string[] = [];
    const waiting = await tx.selectDistinct({ triggerId: eventFires.triggerId }).from(eventFires).where(eq(eventFires.status, "deferred")).limit(EVENT_BATCH);
    for (const { triggerId } of waiting) {
      const [trigger] = await tx.select().from(triggers).where(eq(triggers.id, triggerId)).for("no key update", { skipLocked: true });
      if (!trigger) continue;
      const room = await this.room(tx, trigger, now);
      if (room === 0) continue;
      const fires = await tx
        .select({ id: eventFires.id, event: events })
        .from(eventFires)
        .innerJoin(events, eq(events.id, eventFires.eventId))
        .where(and(eq(eventFires.triggerId, triggerId), eq(eventFires.status, "deferred")))
        .orderBy(asc(eventFires.createdAt), asc(eventFires.id))
        .limit(room)
        .for("update", { of: eventFires, skipLocked: true });
      for (const fire of fires) {
        const runId = await this.tryFire(tx, triggerId, fire.event, fire.id, now);
        if (runId) started.push(runId);
      }
    }
    const due = await tx
      .select()
      .from(events)
      .where(isNull(events.processedAt))
      .orderBy(asc(events.createdAt), asc(events.id))
      .limit(EVENT_BATCH)
      .for("update", { skipLocked: true });
    const watching = new Map<string, TriggerRow[]>();
    for (const event of due) {
      if (!watching.has(event.ownerId)) {
        watching.set(event.ownerId, await tx.select().from(triggers).where(and(eq(triggers.ownerId, event.ownerId), eq(triggers.kind, "primitive"), eq(triggers.enabled, true))));
      }
      for (const trigger of watching.get(event.ownerId)!.filter((t) => watches(t, event))) {
        const [fire] = await tx
          .insert(eventFires)
          .values({ id: newId("fire"), ownerId: event.ownerId, triggerId: trigger.id, eventId: event.id, status: "deferred", createdAt: event.createdAt })
          .onConflictDoNothing()
          .returning({ id: eventFires.id });
        if (!fire) continue;
        const runId = await this.tryFire(tx, trigger.id, event, fire.id, now);
        if (runId) started.push(runId);
      }
      await tx.update(events).set({ processedAt: now }).where(eq(events.id, event.id));
    }
    return started;
  }

  /** How many Jobs a primitive trigger may start now: what its rate cap leaves of the last hour, and one at a time, none while one is going. */
  private async room(tx: Tx, trigger: TriggerRow, now: Date): Promise<number> {
    const [recent] = await tx
      .select({ jobs: count() })
      .from(eventFires)
      .where(and(eq(eventFires.triggerId, trigger.id), gt(eventFires.startedAt, new Date(now.getTime() - HOUR_MS))));
    const left = Math.max(0, trigger.rateCap - recent!.jobs);
    if (left === 0 || trigger.concurrency !== "one-at-a-time") return left;
    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.triggerId, trigger.id), inArray(runs.status, ["running", "waiting"])))
      .limit(1);
    return active ? 0 : 1;
  }

  /** One event's fire for one trigger, in its own span and savepoint; a failure leaves it deferred, for the next tick. */
  private async tryFire(tx: Tx, triggerId: string, event: EventRow, fireId: string, now: Date): Promise<string | null> {
    try {
      return await fired("event", event.createdAt, now, () => tx.transaction((sp) => this.fireEvent(sp, triggerId, event, fireId, now)));
    } catch (err) {
      logError("scheduler.fireEvent failed", err);
      return null;
    }
  }

  /**
   * Decides a fire, the trigger locked (`FOR NO KEY UPDATE`: it waits for itself, not for the
   * key-share lock an `event_fires` insert takes on its trigger) so that no other scheduler checks its
   * limits meanwhile, and read as it is now: no Job when it no longer watches this change, when
   * the write was by a Job of its own agent, or when the agent may no longer read the event's
   * table; deferred when it has no room; otherwise a Job, one deeper than the Job that wrote the
   * row, unless its chain is at its limit.
   */
  private async fireEvent(tx: Tx, triggerId: string, event: EventRow, fireId: string, now: Date): Promise<Fired> {
    const record = async (status: EventFireStatus, set: { runId?: string; message?: string } = {}): Promise<Fired> => {
      await tx
        .update(eventFires)
        .set({ status, ...set, ...(status === "started" ? { startedAt: now } : {}) })
        .where(eq(eventFires.id, fireId));
      return { runId: set.runId ?? null, result: status };
    };
    const [trigger] = await tx.select().from(triggers).where(eq(triggers.id, triggerId)).for("no key update");
    if (!trigger?.enabled || !watches(trigger, event)) return record("refused", { message: "The trigger no longer watches this change" });
    const writer = event.actor.type === "user" ? null : (await tx.select({ id: runs.id, agentId: runs.agentId, source: runs.source, cause: runs.cause }).from(runs).where(eq(runs.id, event.actor.runId)))[0];
    if (writer?.source === "agent" && writer.agentId === trigger.agentId) return record("skipped-same-agent");
    const [agent] = await tx.select({ bundles: agents.bundles, dataTables: agents.dataTables }).from(agents).where(eq(agents.id, trigger.agentId));
    if (!agent?.bundles.includes("data") || (agent.dataTables !== "all" && !agent.dataTables.includes(event.tableId))) {
      return record("out-of-scope", { message: "The agent may no longer read this table" });
    }
    if ((await this.room(tx, trigger, now)) === 0) return { runId: null, result: "deferred" };
    // A Job's write makes the next link of its chain; a person's or a workflow's starts one.
    const parent = writer?.source === "agent" ? writer : null;
    const cause: JobCause = parent
      ? {
          kind: "event",
          eventId: event.id,
          jobId: parent.id,
          rootJobId: (parent.cause?.kind === "event" ? parent.cause.rootJobId : undefined) ?? parent.id,
          depth: (parent.cause?.depth ?? 0) + 1,
        }
      : { kind: "event", eventId: event.id, depth: 0 };
    try {
      const runId = await tx.transaction((sp) =>
        this.engine.createJob(sp, {
          ownerId: trigger.ownerId,
          agentId: trigger.agentId,
          triggerId: trigger.id,
          cause,
          firing: { type: "event", eventId: event.id, outputs: eventOutputs(event) },
        }),
      );
      return record("started", { runId });
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      return err.message === CHAIN_LIMIT ? record("chain-limit", { message: err.message }) : record("refused", { message: err.message });
    }
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
