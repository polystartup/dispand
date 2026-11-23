import { and, asc, count, desc, eq, gt, inArray, isNull, max, notInArray } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { detached, eachScope, inRunScope, inScope, type Scope, SYSTEM } from "../db/scope.ts";
import {
  agents,
  eventFires,
  events,
  pollItems,
  polls,
  roots,
  runs,
  scheduleFires,
  schedules,
  tools,
  triggerFires,
  triggers,
  workflows,
  workflowVersions,
  type EventFireStatus,
  type JobCause,
  type PollCursor,
  type PollStatus,
  type ScheduleFireStatus,
} from "../db/schema.ts";
import { newId } from "../ids.ts";
import { type AuditEntry, recordAudit, recordAuditAfter } from "../audit/record.ts";
import { errorKind, logError } from "../log.ts";
import { say, stored } from "../messages/index.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { fillLastPoll, itemsOf, MAX_ITEM_BYTES, nextToken, noPolls, type PollCaller } from "../tools/poll.ts";
import { pollProblemText } from "../tools/pollable.ts";
import { signInOf } from "../tools/catalog.ts";
import { canonicalJson, JOB, type TriggerConfig } from "../triggers/model.ts";
import { latestFireBetween, nextFireAfter } from "../workflows/schedule.ts";
import { deferredEventFire, deferredPollItem, dueEvent, dueSchedule, dueTrigger, eventScopes, notPaused, pollScopes, scheduledScopes } from "./discovery.ts";
import { type Engine } from "./engine.ts";
import { EngineError } from "./errors.ts";
import { runIssues } from "./problems.ts";
import { newRoot, ROOT_STOPPED } from "./roots.ts";
import { eventOutputs, jobOutputs, pollOutputs } from "./job-def.ts";

/** The scopes, each workspace once. */
const unique = (scopes: Scope[]) => [...new Map(scopes.map((s) => [s.workspaceId, s])).values()];

/** How often the scheduler looks for due schedules. */
export const SCHEDULER_TICK_MS = 15_000;

const traces = tracer("scheduler");
const counts = meter("scheduler");

/** The fire statuses that end a firing for good with no Job: each leaves a `job.skipped` Audit row. */
type Skipped = "skipped-overlap" | "refused" | "skipped-same-agent" | "out-of-scope";

/** A trigger's firing that ends with no Job and won't be tried again, in `tx` with its fire's record. */
function skipped(tx: Tx, trigger: Pick<TriggerRow, "id" | "ownerId" | "agentId" | "name">, firing: "schedule" | "event" | "poll", reason: Skipped, extra: { eventId?: string; items?: number } = {}) {
  return recordAudit(tx, {
    ownerId: trigger.ownerId,
    actor: { type: "scheduler" },
    agentId: trigger.agentId,
    action: "job.skipped",
    resource: { type: "trigger", id: trigger.id },
    result: reason === "refused" || reason === "out-of-scope" ? "refused" : "ok",
    details: { triggerId: trigger.id, triggerName: trigger.name, agentId: trigger.agentId, firing, reason, ...extra },
  });
}

/**
 * A poll that ended (`poll.run`), on its trigger: the tool and action, how it ended, and how many
 * new items it recorded, never an item or its id. In the claim's transaction for one skipped
 * before its call, after the call (never throwing) for one that called.
 */
function pollRun(trigger: Pick<TriggerRow, "id" | "ownerId" | "agentId">, config: PollConfig, status: Exclude<PollStatus, "calling">, found: number): AuditEntry {
  return {
    ownerId: trigger.ownerId,
    actor: { type: "scheduler" },
    agentId: trigger.agentId,
    action: "poll.run",
    resource: { type: "trigger", id: trigger.id },
    result: status === "failed" ? "failed" : "ok",
    details: { triggerId: trigger.id, toolId: config.toolId, action: config.action, status, found },
  };
}

/** What firing one schedule came to: the run it created, or why none. */
type Fired = { runId: string | null; result: "started" | "already" | "skipped-overlap" | "refused" | EventFireStatus };

/** One fire in its own span, counted by kind and result, with how late it was claimed. */
function fired(kind: "workflow" | "trigger" | "event" | "job" | "poll", at: Date, now: Date, work: () => Promise<Fired>): Promise<string | null> {
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

/** What a poll of a tool waiting for its owner's sign-in says on its trigger. */
export const NEEDS_SIGN_IN_POLL = stored("tools.fail.pollNeedsSignIn");

/** Polls a trigger keeps, the latest (what its sheet shows). */
const POLLS_KEPT = 20;
/** Poll items inserted per statement. */
const INSERT_CHUNK = 1000;
/** Pages one poll reads of a walk; past them, the walk goes on at its next interval. */
export const MAX_WALK_PAGES = 20;

type EventRow = typeof events.$inferSelect;

/** An event whose root cause isn't paused at a checkpoint: a paused root's events wait, unclaimed, like a deferred fire. */
type TriggerRow = typeof triggers.$inferSelect;
type ItemRow = typeof pollItems.$inferSelect;
type PollConfig = Extract<TriggerConfig, { kind: "poll" }>;
/**
 * A poll claimed by a tick, whose calls are made once the claim commits: `lastPoll` and
 * `startedAt` are its walk's (the one under way, else this claim's), `token` the next page's.
 */
type Claimed = { pollId: string; trigger: TriggerRow & { config: PollConfig }; tool: typeof tools.$inferSelect; at: Date; lastPoll: string; startedAt: Date; token: string | null };
/** One page of a poll recorded: what it found, and where the walk is. */
type Page = { status: Exclude<PollStatus, "calling">; found: number; fresh: number; runIds: string[]; token: string | null };

/** An agent's name now, for a Job event's outputs; empty when it is gone. */
async function agentNameOf(tx: Tx, agentId: unknown): Promise<string> {
  if (typeof agentId !== "string") return "";
  const [agent] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
  return agent?.name ?? "";
}

/** Whether a primitive trigger watches this event: its table, its operation and, for an update, one of its fields. */
function watches(trigger: TriggerRow, event: EventRow): boolean {
  const config = trigger.config;
  if (config.kind !== "primitive" || config.tableId !== event.tableId || !(config.operations as string[]).includes(event.operation)) return false;
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
  private readonly polls: PollCaller;

  constructor(
    private readonly db: Db,
    private readonly engine: Engine,
    /** `polls` calls a poll trigger's action (`pollCaller`); without it, every poll fails. */
    opts: { now?: () => Date; polls?: PollCaller } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.polls = opts.polls ?? noPolls;
  }

  /** Ticks now (the catch-up after downtime), then every `SCHEDULER_TICK_MS`; never two at once. */
  start(): void {
    if (this.timer) return;
    // Each tick runs with no scope whoever started the scheduler, then under SYSTEM: it spans
    // every workspace, and splits its passes by workspace itself (`eachScope`).
    const run = detached(() => {
      if (this.ticking) return;
      this.ticking = inScope(SYSTEM, () => this.tick())
        .catch((err: unknown) => logError("scheduler.tick failed", err))
        .finally(() => (this.ticking = undefined));
    });
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
    // Per workspace with due work (`eachScope`): the claims in turn, then each one's poll claim,
    // whose walks run at once, after all of them. One pass, as is, on a single-tenant database.
    const now = this.now();
    const started: string[] = [];
    const claimScopes = async (db: Db) => unique([...(await scheduledScopes(db, now)), ...(await eventScopes(db)), ...(await pollScopes(db, now))]);
    await eachScope(this.db, claimScopes, async () => {
      started.push(...(await this.claim()));
    });
    const walks: Promise<string[]>[] = [];
    await eachScope(this.db, (db) => pollScopes(db, now), async () => {
      walks.push((await this.startPolls()).walks);
    });
    for (const runIds of await Promise.all(walks)) started.push(...runIds);
    await this.engine.announceCheckpoints();
    for (const runId of [...this.stalled, ...started]) {
      try {
        // In the run's own scope, not the tick's (`inRunScope`).
        await inRunScope(this.db, runId, () => this.engine.continueRun(runId));
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
        .where(dueSchedule(now))
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
        .where(dueTrigger("schedule", now))
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
      started.push(...(await this.claimDeferredItems(tx, now)));
      return started;
    });
  }

  /**
   * Poll triggers: due polls claimed in one transaction (their next time moved, a `polls` row
   * each), then each one's call made outside any transaction, at once, and its items recorded in
   * a transaction of its own. Two schedulers never call one poll for the same time: the claim
   * moves it past now under `FOR UPDATE SKIP LOCKED`. Polls of one runner's tool go one after
   * the other (a runner calls each of its tools once at a time); the others at once.
   */
  async poll(): Promise<string[]> {
    return (await this.startPolls()).walks;
  }

  /** Claims the due polls; their walks run on, the promise of the runs they start returned. */
  private async startPolls(): Promise<{ walks: Promise<string[]> }> {
    const now = this.now();
    const claimed = await this.db.transaction((tx) => this.claimPolls(tx, now));
    const queues = new Map<string, Claimed[]>();
    for (const c of claimed) {
      const key = c.tool.kind === "runner" ? `${c.tool.runnerId}\u0000${c.tool.runnerTool ?? c.tool.id}` : c.pollId;
      queues.set(key, [...(queues.get(key) ?? []), c]);
    }
    const runs = [...queues.values()].map(async (queue) => {
      const started: string[] = [];
      for (const c of queue) started.push(...(await this.runPoll(c, now)));
      return started;
    });
    return { walks: Promise.all(runs).then((r) => r.flat()) };
  }

  /**
   * Claims due polls. Each is checked before its call against the tool and the agent as they are
   * now (`pollProblem`): one that may not read its action is recorded `skipped`, with why, and
   * calls nothing.
   */
  private async claimPolls(tx: Tx, now: Date): Promise<Claimed[]> {
    const due = await tx
      .select()
      .from(triggers)
      .where(dueTrigger("poll", now))
      .orderBy(asc(triggers.nextFireAt))
      .limit(BATCH)
      .for("update", { skipLocked: true });
    const claimed: Claimed[] = [];
    for (const t of due) {
      if (t.config.kind !== "poll") continue;
      const config = t.config;
      await tx
        .update(triggers)
        .set({ nextFireAt: new Date(now.getTime() + config.interval * 1000) })
        .where(eq(triggers.id, t.id));
      const [tool] = await tx.select().from(tools).where(eq(tools.id, config.toolId));
      // A tool waiting for its owner's sign-in is called by nothing, its polls included, until it is signed in.
      const problem = (await pollProblemText(tx, t.ownerId, t.agentId, config.toolId, config.action)) ?? (tool && signInOf(tool) === "needed" ? NEEDS_SIGN_IN_POLL : null);
      const pollId = newId("poll");
      await tx.insert(polls).values({ id: pollId, ownerId: t.ownerId, triggerId: t.id, at: now, status: problem ? "skipped" : "calling", message: problem });
      const kept = tx.select({ id: polls.id }).from(polls).where(eq(polls.triggerId, t.id)).orderBy(desc(polls.at), desc(polls.id)).limit(POLLS_KEPT);
      await tx.delete(polls).where(and(eq(polls.triggerId, t.id), notInArray(polls.id, kept)));
      if (problem || !tool) {
        await recordAudit(tx, pollRun(t, config, "skipped", 0));
        counts.counter("dispand.polls").add(1, { "dispand.tool.kind": tool?.kind ?? "none", "dispand.result": "skipped" });
        continue;
      }
      // A walk under way goes on with its own query, from its next page (from its first again
      // when its continuation changed: `token` null).
      const cursor = t.pollCursor;
      if (cursor) {
        claimed.push({ pollId, trigger: { ...t, config }, tool, at: now, lastPoll: cursor.lastPoll, startedAt: new Date(cursor.startedAt), token: cursor.token });
        continue;
      }
      // `{{lastPoll}}`: when the newest recorded item was found (its walk's start), never a
      // later call's time, so nothing a poll didn't record is skipped by the next one's query.
      const [newest] = await tx.select({ at: max(pollItems.firstSeen) }).from(pollItems).where(eq(pollItems.triggerId, t.id));
      claimed.push({ pollId, trigger: { ...t, config }, tool, at: now, lastPoll: (newest?.at ?? t.createdAt).toISOString(), startedAt: now, token: null });
    }
    return claimed;
  }

  /**
   * One claimed poll: its call, then its items recorded. With a continuation, the walk's next
   * pages follow at once (one fixed query, the server's token passed on each later call), up to
   * `MAX_WALK_PAGES`; past them the walk goes on at the next interval. In a `scheduler.poll` span
   * with counts and kinds only, never an item, an argument, the result or a token.
   */
  private runPoll(c: Claimed, now: Date): Promise<string[]> {
    const kind = c.tool.kind;
    return traces.startActiveSpan("scheduler.poll", { attributes: { "dispand.trigger.id": c.trigger.id, "dispand.tool.id": c.tool.id, "dispand.tool.kind": kind } }, async (span) => {
      const started = performance.now();
      let result: Exclude<PollStatus, "calling"> = "failed";
      let pages = 0;
      let token = c.token;
      // Jobs committed by earlier pages: returned even when a later one throws, so they go on.
      const runIds: string[] = [];
      const totals = { found: 0, fresh: 0 };
      try {
        const { toolId, action, arguments: args, itemsPath, idPath, continuation } = c.trigger.config;
        const query = fillLastPoll(args, c.lastPoll) as Record<string, unknown>;
        do {
          // Checked again right before each call, against the trigger, the tool and the agent as
          // they are now: a poll may have waited for others of its runner's tool meanwhile.
          const [trigger] = await this.db.select().from(triggers).where(eq(triggers.id, c.trigger.id));
          const [tool] = await this.db.select().from(tools).where(eq(tools.id, toolId));
          const problem =
            !trigger?.enabled || canonicalJson(trigger.config) !== canonicalJson(c.trigger.config)
              ? "The trigger changed before its poll"
              : ((await pollProblemText(this.db, c.trigger.ownerId, c.trigger.agentId, toolId, action)) ?? (tool && signInOf(tool) === "needed" ? NEEDS_SIGN_IN_POLL : null));
          if (problem || !tool) {
            result = "skipped";
            await this.db.update(polls).set({ status: "skipped", message: problem ?? stored("tools.poll.gone") }).where(eq(polls.id, c.pollId));
            return runIds;
          }
          const called = await this.polls.call(tool, action, token !== null && continuation ? { ...query, [continuation.argument]: token } : query);
          pages++;
          const next = called.ok && continuation ? nextToken(called.data, continuation) : { token: null };
          const items = !called.ok ? { error: called.error } : "error" in next ? next : itemsOf(called.data, itemsPath, idPath);
          const more = called.ok && called.hasMore;
          const last = !("token" in next) || next.token === null || pages >= MAX_WALK_PAGES;
          const page = await this.db.transaction((tx) => this.recordPoll(tx, c, items, "token" in next ? next.token : null, { last, more, pages, totals }, now));
          result = page.status;
          runIds.push(...page.runIds);
          token = page.token;
        } while (token !== null && pages < MAX_WALK_PAGES && result !== "failed" && result !== "skipped");
        span.setAttributes({ "dispand.poll.found": totals.found, "dispand.poll.fresh": totals.fresh, "dispand.poll.pages": pages });
        counts.counter("dispand.poll.items").add(totals.fresh, { "dispand.tool.kind": kind });
        if (continuation && (result === "polled" || result === "baseline")) {
          const walk = token === null ? "ended" : "bounded";
          counts.counter("dispand.poll.walks").add(1, { "dispand.tool.kind": kind, "dispand.result": walk });
          counts.histogram("dispand.poll.walk.pages", { description: "Pages a poll read of its walk" }).record(pages, { "dispand.tool.kind": kind, "dispand.result": walk });
        }
        return runIds;
      } catch (err) {
        recordError(span, errorKind(err));
        logError("scheduler.poll failed", err, { ref: c.trigger.id });
        result = "failed";
        await this.db
          .update(polls)
          .set({ status: "failed", message: stored("engine.poll.failed") })
          .where(eq(polls.id, c.pollId))
          .catch(() => undefined);
        return runIds;
      } finally {
        await recordAuditAfter(this.db, pollRun(c.trigger, c.trigger.config, result, totals.fresh));
        span.setAttribute("dispand.result", result);
        span.end();
        counts.counter("dispand.polls").add(1, { "dispand.tool.kind": kind, "dispand.result": result });
        counts.histogram("dispand.poll.duration", { unit: "ms", description: "A poll, from its call to its items recorded" }).record(performance.now() - started, { "dispand.tool.kind": kind, "dispand.result": result });
      }
    });
  }

  /**
   * One page of a poll, recorded with the trigger locked (`FOR NO KEY UPDATE`): each id once
   * (`poll_items`' unique key), so an item recorded before (by this walk's earlier page, a walk
   * repeating its boundary items, a call cut short after its record, or another) starts nothing
   * again. Items are first seen when their walk began. The first walk records what exists as
   * `baseline`; later ones record new items `deferred` and start what the trigger has room for,
   * each Job in the same transaction as its item's row. A page with a `token` keeps the walk on the
   * trigger; one without ends it (the next walk's `{{lastPoll}}` moves only then), and a result
   * the server cut short (`more`) is polled again on the next tick. A trigger turned off or
   * changed during the call records nothing. The poll's row counts all its pages.
   */
  private async recordPoll(
    tx: Tx,
    c: Claimed,
    polled: ReturnType<typeof itemsOf>,
    token: string | null,
    walk: { last: boolean; more: boolean; pages: number; totals: { found: number; fresh: number } },
    now: Date,
  ): Promise<Page> {
    const finish = async (status: Exclude<PollStatus, "calling">, set: { found?: number; fresh?: number; message?: string | null } = {}, runIds: string[] = [], next: string | null = null) => {
      await tx.update(polls).set({ status, ...set }).where(eq(polls.id, c.pollId));
      return { status, found: set.found ?? 0, fresh: set.fresh ?? 0, runIds, token: next };
    };
    const [trigger] = await tx.select().from(triggers).where(eq(triggers.id, c.trigger.id)).for("no key update");
    if (!trigger?.enabled || canonicalJson(trigger.config) !== canonicalJson(c.trigger.config)) return finish("skipped", { message: stored("engine.poll.changed") });
    if ("error" in polled) return finish("failed", { message: polled.error });
    const baseline = trigger.lastCheckedAt === null;
    const values = polled.items.map((item) => ({
      id: newId("item"),
      ownerId: trigger.ownerId,
      triggerId: trigger.id,
      itemId: item.id,
      content: item.content,
      firstSeen: c.startedAt,
      status: baseline ? ("baseline" as const) : item.tooLarge ? ("refused" as const) : ("deferred" as const),
      message: item.tooLarge && !baseline ? stored("engine.poll.itemLarge", { kib: MAX_ITEM_BYTES / 1024 }) : null,
    }));
    const inserted: ItemRow[] = [];
    // In chunks: one statement's parameters are bounded.
    for (let i = 0; i < values.length; i += INSERT_CHUNK) inserted.push(...(await tx.insert(pollItems).values(values.slice(i, i + INSERT_CHUNK)).onConflictDoNothing().returning()));
    // In the order of the result.
    const order = new Map(values.map((v, i) => [v.id, i]));
    const fresh = inserted.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    walk.totals.found += polled.items.length;
    walk.totals.fresh += fresh.length;
    const noId = { count: polled.noId, path: c.trigger.config.idPath };
    const more = token !== null && walk.last ? { pages: walk.pages } : null;
    const note = polled.noId ? (more ? stored("engine.poll.noIdAndPages", { ...noId, ...more }) : stored("engine.poll.noId", noId)) : more ? stored("engine.poll.pages", more) : null;
    const set = { ...walk.totals, message: note };
    // Where the walk is: its token kept for the next page, or the walk ended.
    const cursor: PollCursor | null = token === null ? null : { lastPoll: c.lastPoll, startedAt: c.startedAt.toISOString(), token };
    await tx
      .update(triggers)
      .set({
        pollCursor: cursor,
        ...(baseline && token === null ? { lastCheckedAt: c.startedAt } : {}),
        // The server stopped at its own cap: asked again on the next tick, not after the interval.
        ...(walk.more && token === null ? { nextFireAt: now } : {}),
      })
      .where(eq(triggers.id, trigger.id));
    if (baseline) return finish("baseline", set, [], token);
    const deferred = fresh.filter((i) => i.status === "deferred");
    const runIds = deferred.length ? await this.fireItems(tx, trigger, deferred, now, await this.room(tx, trigger, now)) : [];
    return finish("polled", set, runIds, token);
  }

  /**
   * Deferred poll items, trigger by trigger (so one trigger's backlog never holds up another's):
   * as many of each trigger's oldest as it has room for, from their rows, whatever later polls return.
   */
  private async claimDeferredItems(tx: Tx, now: Date): Promise<string[]> {
    const started: string[] = [];
    const waiting = await tx.selectDistinct({ triggerId: pollItems.triggerId }).from(pollItems).where(deferredPollItem).limit(EVENT_BATCH);
    for (const { triggerId } of waiting) {
      const [trigger] = await tx.select().from(triggers).where(eq(triggers.id, triggerId)).for("no key update", { skipLocked: true });
      if (!trigger) continue;
      const room = await this.room(tx, trigger, now);
      if (room === 0 && trigger.enabled) continue;
      const items = await tx
        .select()
        .from(pollItems)
        .where(and(eq(pollItems.triggerId, triggerId), eq(pollItems.status, "deferred")))
        .orderBy(asc(pollItems.firstSeen), asc(pollItems.id))
        .limit(trigger.enabled ? room : EVENT_BATCH)
        .for("update", { of: pollItems, skipLocked: true });
      started.push(...(await this.fireItems(tx, trigger, items, now, room)));
    }
    return started;
  }

  /**
   * Decides deferred items of one locked poll trigger: refused when it is off, out of scope when
   * its agent may no longer read its action (checked again before any Job), else a Job for each
   * of the first `room`, the rest left deferred.
   */
  private async fireItems(tx: Tx, trigger: TriggerRow, items: ItemRow[], now: Date, room: number): Promise<string[]> {
    const ids = items.map((i) => i.id);
    if (ids.length === 0) return [];
    if (!trigger.enabled || trigger.config.kind !== "poll") {
      await tx.update(pollItems).set({ status: "refused", message: stored("engine.poll.triggerOff") }).where(inArray(pollItems.id, ids));
      await skipped(tx, trigger, "poll", "refused", { items: ids.length });
      return [];
    }
    const config = trigger.config;
    const problem = await pollProblemText(tx, trigger.ownerId, trigger.agentId, config.toolId, config.action);
    if (problem) {
      await tx.update(pollItems).set({ status: "out-of-scope", message: problem }).where(inArray(pollItems.id, ids));
      await skipped(tx, trigger, "poll", "out-of-scope", { items: ids.length });
      return [];
    }
    const started: string[] = [];
    for (const item of items.slice(0, room)) {
      try {
        const runId = await fired("poll", item.firstSeen, now, () => tx.transaction((sp) => this.fireItem(sp, trigger, config, item, now)));
        if (runId) started.push(runId);
      } catch (err) {
        // Rolled back to its savepoint: left deferred, for the next tick.
        logError("scheduler.fireItem failed", err);
      }
    }
    return started;
  }

  /** One item's Job, its row `started` in the same savepoint; `refused` with the engine's reason. */
  private async fireItem(tx: Tx, trigger: TriggerRow, config: PollConfig, item: ItemRow, now: Date): Promise<Fired> {
    try {
      const runId = await tx.transaction((sp) =>
        this.engine.createJob(sp, {
          ownerId: trigger.ownerId,
          agentId: trigger.agentId,
          triggerId: trigger.id,
          cause: { kind: "poll", triggerId: trigger.id, itemId: item.itemId, depth: 0 },
          firing: { type: "poll", triggerId: trigger.id, itemId: item.itemId, toolId: config.toolId, action: config.action, outputs: pollOutputs(item) },
        }),
      );
      await tx.update(pollItems).set({ status: "started", runId, startedAt: now }).where(eq(pollItems.id, item.id));
      return { runId, result: "started" };
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      await tx.update(pollItems).set({ status: "refused", message: stored(err.data.key, err.data.values) }).where(eq(pollItems.id, item.id));
      await skipped(tx, trigger, "poll", "refused", { items: 1 });
      return { runId: null, result: "refused" };
    }
  }

  /**
   * Primitive triggers: each trigger with deferred fires gets as many of its oldest tried again
   * as it has room for, then due events are claimed (`FOR UPDATE SKIP LOCKED`), each matched
   * against the owner's enabled primitive triggers: a fire recorded per match, once
   * (`event_fires`' unique key), and the event marked processed, deferred fires included.
   */
  private async claimEvents(tx: Tx, now: Date): Promise<string[]> {
    const started: string[] = [];
    const waiting = await tx.selectDistinct({ triggerId: eventFires.triggerId }).from(eventFires).where(deferredEventFire).limit(EVENT_BATCH);
    for (const { triggerId } of waiting) {
      const [trigger] = await tx.select().from(triggers).where(eq(triggers.id, triggerId)).for("no key update", { skipLocked: true });
      if (!trigger) continue;
      const room = await this.room(tx, trigger, now);
      if (room === 0) continue;
      const fires = await tx
        .select({ id: eventFires.id, event: events })
        .from(eventFires)
        .innerJoin(events, eq(events.id, eventFires.eventId))
        .leftJoin(roots, eq(roots.id, events.rootId))
        .where(and(eq(eventFires.triggerId, triggerId), eq(eventFires.status, "deferred"), notPaused))
        .orderBy(asc(eventFires.createdAt), asc(eventFires.id))
        .limit(room)
        .for("update", { of: eventFires, skipLocked: true });
      for (const fire of fires) {
        const root = await this.lockRoot(tx, fire.event);
        if (!root) continue;
        const runId = await this.tryFire(tx, triggerId, fire.event, fire.id, now, root);
        if (runId) started.push(runId);
      }
    }
    const due = await tx
      .select({ event: events })
      .from(events)
      .leftJoin(roots, eq(roots.id, events.rootId))
      .where(dueEvent)
      .orderBy(asc(events.createdAt), asc(events.id))
      .limit(EVENT_BATCH)
      .for("update", { of: events, skipLocked: true });
    // An event is its workspace's: the triggers of that workspace's agents watch it, whoever made them.
    const watching = new Map<string, TriggerRow[]>();
    for (const { event } of due) {
      if (!watching.has(event.workspaceId)) {
        const rows = await tx.select({ trigger: triggers }).from(triggers).innerJoin(agents, eq(agents.id, triggers.agentId))
          .where(and(eq(agents.workspaceId, event.workspaceId), eq(triggers.kind, "primitive"), eq(triggers.enabled, true)));
        watching.set(event.workspaceId, rows.map((r) => r.trigger));
      }
      const matching = watching.get(event.workspaceId)!.filter((t) => watches(t, event));
      if (matching.length > 0) {
        // Its root's state is read once, here: every Job its triggers call for is made, even past
        // the checkpoint, and the pause holds from the next event.
        const root = await this.lockRoot(tx, event);
        if (!root) continue;
        if (root.state !== "stopped") {
          for (const trigger of matching) {
            const [fire] = await tx
              .insert(eventFires)
              .values({ id: newId("fire"), ownerId: trigger.ownerId, triggerId: trigger.id, eventId: event.id, status: "deferred", createdAt: event.createdAt })
              .onConflictDoNothing()
              .returning({ id: eventFires.id });
            if (!fire) continue;
            const runId = await this.tryFire(tx, trigger.id, event, fire.id, now, root);
            if (runId) started.push(runId);
          }
        }
      }
      await tx.update(events).set({ processedAt: now }).where(eq(events.id, event.id));
    }
    return started;
  }

  /**
   * The event's root cause, locked until the tick commits, so that two schedulers count its Jobs
   * one after the other: the root of the Job that wrote it, or, for a person's or a workflow's
   * write, a new root of its own (kept on the event, for its deferred fires). Null when another
   * scheduler holds it or it is paused: the event waits for a later tick.
   */
  private async lockRoot(tx: Tx, event: EventRow): Promise<{ id: string; state: string } | null> {
    let rootId = event.rootId;
    if (!rootId && event.actor.type !== "user") {
      const [writer] = await tx.select({ rootId: runs.rootId }).from(runs).where(eq(runs.id, event.actor.runId));
      rootId = writer?.rootId ?? null;
    }
    if (!rootId) {
      rootId = await newRoot(tx, event.ownerId, event.workspaceId, "event", null);
      await tx.update(events).set({ rootId }).where(eq(events.id, event.id));
      event.rootId = rootId;
    }
    const [root] = await tx.select({ id: roots.id, state: roots.state }).from(roots).where(eq(roots.id, rootId)).for("update", { skipLocked: true });
    return root && root.state !== "paused" ? root : null;
  }

  /** How many Jobs a primitive or poll trigger may start now: what its rate cap leaves of the last hour, and one at a time, none while one is going. */
  private async room(tx: Tx, trigger: TriggerRow, now: Date): Promise<number> {
    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const [recent] =
      trigger.kind === "poll"
        ? await tx.select({ jobs: count() }).from(pollItems).where(and(eq(pollItems.triggerId, trigger.id), gt(pollItems.startedAt, hourAgo)))
        : await tx.select({ jobs: count() }).from(eventFires).where(and(eq(eventFires.triggerId, trigger.id), gt(eventFires.startedAt, hourAgo)));
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
  private async tryFire(tx: Tx, triggerId: string, event: EventRow, fireId: string, now: Date, root: { id: string; state: string }): Promise<string | null> {
    try {
      return await fired(event.tableId === JOB ? "job" : "event", event.createdAt, now, () => tx.transaction((sp) => this.fireEvent(sp, triggerId, event, fireId, now, root)));
    } catch (err) {
      logError("scheduler.fireEvent failed", err);
      return null;
    }
  }

  /**
   * Decides a fire, the trigger locked (`FOR NO KEY UPDATE`: it waits for itself, not for the
   * key-share lock an `event_fires` insert takes on its trigger) so that no other scheduler checks its
   * limits meanwhile, and read as it is now: no Job when it no longer watches this change, when
   * the write was by a Job of its own agent, or when
   * the agent may no longer read the event's table; deferred when it has no room; none either once its root cause was declined at a
   * checkpoint (`stopped`); otherwise a Job of that root, one deeper than the Job that wrote the
   * row (with no limit of depth: the root's checkpoints catch a loop).
   */
  private async fireEvent(tx: Tx, triggerId: string, event: EventRow, fireId: string, now: Date, root: { id: string; state: string }): Promise<Fired> {
    // The trigger once read: a firing it ends for good is audited on it.
    const read: { trigger?: TriggerRow } = {};
    const record = async (status: EventFireStatus, set: { runId?: string; message?: string } = {}): Promise<Fired> => {
      await tx
        .update(eventFires)
        .set({ status, ...set, ...(status === "started" ? { startedAt: now } : {}) })
        .where(eq(eventFires.id, fireId));
      if (read.trigger && (status === "refused" || status === "skipped-same-agent" || status === "out-of-scope")) await skipped(tx, read.trigger, "event", status, { eventId: event.id });
      return { runId: set.runId ?? null, result: status };
    };
    if (root.state === "stopped") return record("stopped", { message: ROOT_STOPPED });
    const [trigger] = await tx.select().from(triggers).where(eq(triggers.id, triggerId)).for("no key update");
    read.trigger = trigger;
    if (!trigger?.enabled || !watches(trigger, event)) return record("refused", { message: stored("engine.fire.notWatching") });
    const writerId = event.actor.type === "user" ? null : event.actor.runId;
    const writer = writerId ? (await tx.select({ id: runs.id, agentId: runs.agentId, source: runs.source, cause: runs.cause }).from(runs).where(eq(runs.id, writerId)))[0] : null;
    if (writer?.source === "agent" && writer.agentId === trigger.agentId) return record("skipped-same-agent");
    if (event.tableId !== JOB) {
      // Another Job's event (`job`, written by that Job) holds ids and a status only: any agent may be started by it.
      const [agent] = await tx.select({ bundles: agents.bundles, dataTables: agents.dataTables }).from(agents).where(eq(agents.id, trigger.agentId));
      if (!agent?.bundles.includes("data") || (agent.dataTables !== "all" && !agent.dataTables.includes(event.tableId))) {
        return record("out-of-scope", { message: stored("engine.fail.scope.tableNow") });
      }
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
    const outputs = event.tableId === JOB ? jobOutputs(event, await agentNameOf(tx, event.after.agentId)) : eventOutputs(event);
    try {
      const runId = await tx.transaction((sp) =>
        this.engine.createJob(sp, {
          ownerId: trigger.ownerId,
          agentId: trigger.agentId,
          triggerId: trigger.id,
          cause,
          firing: { type: "event", eventId: event.id, outputs },
          rootId: root.id,
        }),
      );
      return record("started", { runId });
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      return record(err.code === "STOPPED" ? "stopped" : "refused", { message: stored(err.data.key, err.data.values) });
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
        await skipped(tx, trigger, "schedule", "skipped-overlap");
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
      await record("refused", { message: stored(err.data.key, err.data.values) });
      await skipped(tx, trigger, "schedule", "refused");
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
      .where(and(eq(workflows.id, workflowId), isNull(workflows.archivedAt)));
    const [issue] = current ? await runIssues(tx, ownerId, current.def) : [{ message: say("workflows.notFound") }];
    if (issue) {
      await record("refused", { message: stored(issue.message.key, issue.message.values) });
      return { runId: null, result: "refused" };
    }
    const runId = await this.engine.createRun(tx, workflowId, { type: "schedule", scheduledFor: at.toISOString() });
    await record("started", { runId });
    return { runId, result: "started" };
  }
}
