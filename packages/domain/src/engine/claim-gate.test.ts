import { call } from "@orpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { eventFires, events, organizations, pollItems, polls, runs, scheduleFires, triggerFires, triggers, user, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, refusing, runnerWithClis, secondWorkspace } from "../runners/test-support.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import { purgeArchivedPeople } from "../workspace/purge.ts";
import { claimOrganizations } from "./discovery.ts";
import { Engine } from "./engine.ts";
import type { HarnessAdapter } from "./harness.ts";
import { Scheduler } from "./scheduler.ts";

// An install that refuses an organization (`Tenancy.refusal`): the scheduler claims none of its due
// work, which stays due and fires once it is allowed again, and another organization's work fires
// in the same tick.

vi.mock("./discovery.ts", async (actual) => {
  const real = await actual<typeof import("./discovery.ts")>();
  return { ...real, claimOrganizations: vi.fn(real.claimOrganizations) };
});

class FakeAdapter implements HarnessAdapter {
  async start() {
    return true;
  }
  async send() {
    return true;
  }
  async answer() {
    return true;
  }
  async stop() {
    return true;
  }
}

const SAVED = "2026-11-05T10:05:00+01:00";
const DUE = "2026-11-05T11:00:10+01:00";
const PAST = new Date("2026-11-05T09:30:00Z");

const hourly = (agentId: string): WorkflowDef => ({
  trigger: { type: "schedule", field: { id: "n_s", key: "hourly", type: "schedule", label: "Hourly", cron: "0 * * * *", timezone: "Europe/Paris" } },
  steps: [{ id: "n_r", key: "report", type: "agent", name: "Report", agentId, prompt: "Report." }],
  edges: [{ from: "n_s", to: "n_r" }],
});

/**
 * Two organizations, A (the owner's) and B, each with a workspace holding an hourly workflow saved at
 * 10:05, and at 11:00 a due schedule trigger, a due poll, an unprocessed event, a deferred event
 * fire and a deferred poll item. `refuse` has the install refuse an organization, until lifted.
 */
async function twoOrganizations() {
  const base = await ownerContext();
  const { db, ownerId } = base;
  let now = new Date(SAVED);
  const clock = { now: () => now, set: (to: string) => (now = new Date(to)) };
  let n = 0;
  const id = (prefix: string) => `${prefix}_${++n}`;
  const made = async (context: typeof base, workspaceId: string) => {
    const { runnerId } = await runnerWithClis(context);
    const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
    const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context });
    const workflow = await call(router.workflows.create, { name: "Report" }, { context });
    await call(router.workflows.update, { id: workflow.id, name: "Report", def: hourly(agent.id) }, { context: { ...context, now: clock.now } });
    const trigger = async (kind: "schedule" | "poll" | "primitive", set: Partial<typeof triggers.$inferInsert> = {}) => {
      const config = kind === "schedule" ? { kind, cron: "0 * * * *", timezone: "Europe/Paris" } : kind === "poll" ? { kind, toolId: "tool_x", action: "list", arguments: {}, interval: 60, itemsPath: "", idPath: "id" } : { kind, tableId: "tbl_x", operations: ["created"] };
      const triggerId = id("trigger");
      await db.insert(triggers).values({ id: triggerId, ownerId, agentId: agent.id, kind, name: "Watch", config: config as never, enabled: true, ...set });
      return triggerId;
    };
    const event = async (set: Partial<typeof events.$inferInsert> = {}) => {
      const eventId = id("event");
      await db.insert(events).values({ id: eventId, workspaceId, ownerId, tableId: "tbl_x", rowId: "row_x", operation: "created", changedFieldIds: [], before: {}, after: {}, actor: { type: "user", userId: ownerId }, ...set });
      return eventId;
    };
    const scheduleTrigger = await trigger("schedule", { nextFireAt: PAST, lastCheckedAt: new Date(SAVED) });
    const pollTrigger = await trigger("poll", { nextFireAt: PAST });
    const primitive = await trigger("primitive");
    const fired = await event({ processedAt: PAST, createdAt: PAST });
    const fireId = id("fire");
    await db.insert(eventFires).values({ id: fireId, ownerId, triggerId: primitive, eventId: fired, status: "deferred", createdAt: PAST });
    const itemId = id("item");
    await db.insert(pollItems).values({ id: itemId, ownerId, triggerId: pollTrigger, itemId: "m1", content: "{}", firstSeen: PAST, status: "deferred" });
    const eventId = await event();
    return { agentId: agent.id, workflowId: workflow.id, scheduleTrigger, pollTrigger, eventId, fireId, itemId, trigger, event };
  };
  const a = await made(base, base.workspaceId);
  const inB = (await secondWorkspace(base, "ws_b")).b;
  const b = await made(inB, "ws_b");
  // B's workspace moves to an organization of its own.
  await db.insert(organizations).values({ id: "org_b" });
  await db.update(workspaces).set({ organizationId: "org_b" }).where(eq(workspaces.id, "ws_b"));

  const refuse = (organizationId: string) => refusing(db, organizationId, { key: "organization.refused", link: "/elsewhere" });
  const engine = new Engine(db, new FakeAdapter());
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(db, engine, { now: clock.now });

  /** What the scheduler did with a workspace's work. */
  const state = async (w: typeof a, all = true) => ({
    ...(all ? await rest(w) : {}),
    scheduled: (await db.select({ at: scheduleFires.scheduledFor }).from(scheduleFires).where(eq(scheduleFires.workflowId, w.workflowId)).orderBy(asc(scheduleFires.scheduledFor))).map((f) => f.at.toISOString()),
    triggered: (await db.select({ at: triggerFires.scheduledFor }).from(triggerFires).where(eq(triggerFires.triggerId, w.scheduleTrigger))).map((f) => f.at.toISOString()),
    polled: (await db.select().from(polls).where(eq(polls.triggerId, w.pollTrigger))).length,
  });
  const rest = async (w: typeof a) => ({
    processed: (await db.select({ at: events.processedAt }).from(events).where(eq(events.id, w.eventId)))[0]!.at !== null,
    fire: (await db.select({ status: eventFires.status }).from(eventFires).where(eq(eventFires.id, w.fireId)))[0]!.status,
    item: (await db.select({ status: pollItems.status }).from(pollItems).where(eq(pollItems.id, w.itemId)))[0]!.status,
  });
  const untouched = { scheduled: [], triggered: [], polled: 0, processed: false, fire: "deferred", item: "deferred" };
  return { ...base, a, b, refuse, clock, engine, scheduler, state, untouched };
}

test("a refused organization's due work stays due while another's fires in the same tick, and its overdue schedule fires once when allowed", async () => {
  const f = await twoOrganizations();
  const lift = f.refuse(f.organizationId);
  f.clock.set(DUE);
  await f.scheduler.tick();
  expect(await f.state(f.a)).toEqual(f.untouched);
  const b = await f.state(f.b);
  expect(b).toMatchObject({ scheduled: ["2026-11-05T10:00:00.000Z"], triggered: ["2026-11-05T10:00:00.000Z"], polled: 1, processed: true });
  expect([b.fire, b.item]).not.toContain("deferred");
  // Nothing of A was started.
  expect(await f.db.select().from(runs).where(inArray(runs.workflowId, [f.a.workflowId]))).toEqual([]);

  // Hours later, allowed again: one fire each, for the latest time missed, and the rest goes on.
  f.clock.set("2026-11-05T14:20:00+01:00");
  lift();
  f.refuse("org_elsewhere"); // A hook still answers, allowing A: the gated path, not the one without a hook.
  await f.scheduler.tick();
  const a = await f.state(f.a);
  expect(a).toMatchObject({ scheduled: ["2026-11-05T13:00:00.000Z"], triggered: ["2026-11-05T13:00:00.000Z"], polled: 1, processed: true });
  expect([a.fire, a.item]).not.toContain("deferred");
  await f.scheduler.tick();
  expect((await f.state(f.a)).scheduled).toEqual(["2026-11-05T13:00:00.000Z"]);
});

test("more than a batch of a refused organization's due rows doesn't hold back another organization's", async () => {
  const f = await twoOrganizations();
  f.refuse(f.organizationId);
  // A's rows come first in every claim's order: 25 schedule triggers and 25 polls due before B's, 120 events older than B's.
  for (let i = 0; i < 25; i++) {
    await f.a.trigger("schedule", { nextFireAt: new Date("2026-11-05T08:00:00Z"), lastCheckedAt: new Date(SAVED) });
    await f.a.trigger("poll", { nextFireAt: new Date("2026-11-05T08:00:00Z") });
  }
  await f.db.insert(events).values(Array.from({ length: 120 }, (_, i) => ({
    id: `event_old_${i}`, workspaceId: f.workspaceId, ownerId: f.ownerId, tableId: "tbl_x", rowId: "row_x", operation: "created" as const, changedFieldIds: [], before: {}, after: {},
    actor: { type: "user" as const, userId: f.ownerId }, createdAt: new Date("2026-11-05T08:00:00Z"),
  })));
  f.clock.set(DUE);
  await f.scheduler.tick();
  expect(await f.state(f.b)).toMatchObject({ triggered: ["2026-11-05T10:00:00.000Z"], polled: 1, processed: true });
  // A's 120 and its own unprocessed event wait.
  expect(await f.db.select({ id: events.id }).from(events).where(and(eq(events.workspaceId, f.workspaceId), isNull(events.processedAt)))).toHaveLength(121);
});

test("work that falls due after the tick asked about its organization waits for the next tick", async () => {
  const f = await twoOrganizations();
  // B refused, with only scheduled work: nothing of it is due when the tick lists organizations at
  // 10:59; its claims read the clock again at 11:00:10.
  f.refuse("org_b");
  const ticks = ["2026-11-05T10:59:00+01:00", DUE];
  await f.db.delete(eventFires).where(eq(eventFires.id, f.b.fireId));
  await f.db.delete(pollItems).where(eq(pollItems.id, f.b.itemId));
  await f.db.delete(events).where(eq(events.workspaceId, "ws_b"));
  await f.db.update(triggers).set({ nextFireAt: new Date("2026-11-05T11:00:00+01:00") }).where(inArray(triggers.id, [f.b.scheduleTrigger, f.b.pollTrigger]));
  expect(await claimOrganizations(f.db, new Date(ticks[0]!))).toEqual([f.organizationId]);
  const scheduler = new Scheduler(f.db, f.engine, { now: () => new Date(ticks.length > 1 ? ticks.shift()! : ticks[0]!) });
  const waiting = { scheduled: [], triggered: [], polled: 0 };
  await scheduler.tick();
  expect(await f.state(f.b, false)).toEqual(waiting);
  expect(await f.state(f.a)).toMatchObject({ scheduled: ["2026-11-05T10:00:00.000Z"], triggered: ["2026-11-05T10:00:00.000Z"], polled: 1, processed: true });
  await scheduler.tick();
  expect(await f.state(f.b, false)).toEqual(waiting);
});

test("the purge keeps the people archived by a refused organization, and purges another's", async () => {
  const f = await twoOrganizations();
  const old = new Date(Date.now() - 200 * 86_400_000);
  await f.db.insert(user).values([
    { id: "pat", name: "Pat", email: "pat@example.com", archivedAt: old, archivedBy: f.organizationId },
    { id: "sam", name: "Sam", email: "sam@example.com", archivedAt: old, archivedBy: "org_b" },
  ]);
  const lift = f.refuse(f.organizationId);
  expect(await purgeArchivedPeople(f, new Date())).toEqual({ purged: 1 });
  expect((await f.db.select({ id: user.id }).from(user).where(inArray(user.id, ["pat", "sam"]))).map((u) => u.id)).toEqual(["pat"]);
  // Allowed again, the next night purges them.
  lift();
  f.refuse("org_elsewhere"); // A hook still answers, allowing A: the gated path, not the one without a hook.
  expect(await purgeArchivedPeople(f, new Date())).toEqual({ purged: 1 });
});

test("with no hook, the claims list no organization and take everything due", async () => {
  const f = await twoOrganizations();
  vi.mocked(claimOrganizations).mockClear();
  f.clock.set(DUE);
  await f.scheduler.tick();
  expect(claimOrganizations).not.toHaveBeenCalled();
  for (const w of [f.a, f.b]) expect(await f.state(w)).toMatchObject({ scheduled: ["2026-11-05T10:00:00.000Z"], triggered: ["2026-11-05T10:00:00.000Z"], polled: 1, processed: true });
});
