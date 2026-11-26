import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import type { Db } from "../db/client.ts";
import { chatQueue, cloudSessions, eventFires, events, pollItems, questions, roots, runs, schedules, stepRuns, triggers } from "../db/schema.ts";
import { inScope, setTenancy, shared, SYSTEM, type Scope } from "../db/scope.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, ownerContext, recordScopes, secondWorkspace } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import type { HarnessAdapter } from "./harness.ts";
import { Scheduler } from "./scheduler.ts";
import { eventScopes, pollScopes, recoverScopes, scheduledScopes } from "./discovery.ts";

// What `shared.each` never runs: each listing of a loop, on two workspaces. Work due in B lists
// B's scope; A, with its agent and workflow but nothing due, is never listed.

const NOW = new Date("2026-06-01T12:00:00Z");
const PAST = new Date("2026-06-01T11:00:00Z");

async function twoWorkspaces() {
  const base = await ownerContext();
  const b = { organizationId: base.organizationId, workspaceId: "ws_b" };
  const made = async (context: typeof base) => {
    const { runnerId } = await runnerWithClis(context);
    const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
    const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context });
    const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
    return { agentId: agent.id, workflowId: workflow.id };
  };
  await made(base);
  // The second agent and workflow, made in B with its own runner and harness.
  const inB = await made((await secondWorkspace(base, b.workspaceId)).b);
  const ownerId = base.ownerId;
  let n = 0;
  const id = (prefix: string) => `${prefix}_${++n}`;
  /** A run in B, with `status`, and a step of it. */
  const run = async (status: "running" | "succeeded", step: Partial<typeof stepRuns.$inferInsert> = {}) => {
    const runId = id("run");
    await base.db.insert(runs).values({ id: runId, workspaceId: b.workspaceId, ownerId, workflowId: inB.workflowId, version: 1, status });
    const stepId = id("step");
    await base.db.insert(stepRuns).values({ id: stepId, runId, nodeId: "n_note", status: "succeeded", ...step });
    return { runId, stepId };
  };
  const trigger = async (kind: "schedule" | "poll" | "primitive", set: Partial<typeof triggers.$inferInsert> = {}) => {
    const triggerId = id("trigger");
    const config = kind === "schedule" ? { kind, cron: "* * * * *", timezone: "UTC" } : kind === "poll" ? { kind, toolId: "tool_x", action: "list", arguments: {}, interval: 60, itemsPath: "", idPath: "id" } : { kind, tableId: "tbl_x", operations: ["created"] };
    await base.db.insert(triggers).values({ id: triggerId, ownerId, agentId: inB.agentId, kind, name: "Watch", config: config as never, enabled: true, ...set });
    return triggerId;
  };
  const event = async () => {
    const eventId = id("event");
    await base.db.insert(events).values({ id: eventId, workspaceId: b.workspaceId, ownerId, tableId: "tbl_x", rowId: "row_x", operation: "created", changedFieldIds: [], before: {}, after: {}, actor: { kind: "person", userId: ownerId } as never });
    return eventId;
  };
  return { db: base.db, ownerId, b, inB, run, trigger, event, id };
}

type Fixture = Awaited<ReturnType<typeof twoWorkspaces>>;
type Listing = (db: Db, now: Date) => Promise<Scope[]>;

const cases: [string, Listing, (f: Fixture) => Promise<unknown>][] = [
  ["a due schedule", scheduledScopes, async (f) =>
    f.db.insert(schedules).values({ workflowId: f.inB.workflowId, ownerId: f.ownerId, cron: "* * * * *", timezone: "UTC", nextFireAt: PAST, lastCheckedAt: PAST })],
  ["a due schedule trigger", scheduledScopes, async (f) => f.trigger("schedule", { nextFireAt: PAST, lastCheckedAt: PAST })],
  ["an unprocessed event", eventScopes, async (f) => f.event()],
  ["a deferred event fire", eventScopes, async (f) => {
    const [triggerId, eventId] = [await f.trigger("primitive"), await f.event()];
    await f.db.update(events).set({ processedAt: PAST });
    await f.db.insert(eventFires).values({ id: f.id("fire"), ownerId: f.ownerId, triggerId, eventId, status: "deferred", createdAt: PAST });
  }],
  ["a due poll trigger", pollScopes, async (f) => f.trigger("poll", { nextFireAt: PAST })],
  ["a deferred poll item", pollScopes, async (f) =>
    f.db.insert(pollItems).values({ id: f.id("item"), ownerId: f.ownerId, triggerId: await f.trigger("poll"), itemId: "m1", content: "{}", firstSeen: PAST, status: "deferred" })],
  ["an active run", recoverScopes, async (f) => f.run("running")],
  ["a pending chat message of an ended run", recoverScopes, async (f) => {
    const { runId, stepId } = await f.run("succeeded");
    await f.db.insert(chatQueue).values({ id: f.id("queued"), ownerId: f.ownerId, runId, stepRunId: stepId, text: "Hi" });
  }],
  ["a step queued for a slot", recoverScopes, async (f) => f.run("succeeded", { queuedAt: PAST })],
  ["a step handed a slot to deliver", recoverScopes, async (f) => f.run("succeeded", { working: true, pendingAction: { kind: "deliver" } as never })],
  ["a held step of a root that went on", recoverScopes, async (f) => {
    const rootId = f.id("root");
    await f.db.insert(roots).values({ id: rootId, workspaceId: f.b.workspaceId, ownerId: f.ownerId, kind: "person" as never });
    const { runId } = await f.run("succeeded", { status: "waiting", sessionId: "ses_held", pendingAction: { kind: "start" } as never });
    await f.db.update(runs).set({ rootId }).where(eq(runs.id, runId));
  }],
  ["a pending consult of an ended consulted run", recoverScopes, async (f) => {
    const asking = await f.run("succeeded");
    const consulted = await f.run("succeeded");
    await f.db.insert(questions).values({ id: f.id("q"), ownerId: f.ownerId, runId: asking.runId, kind: "consult", placement: "chat", payload: {} as never, status: "pending", consultRunId: consulted.runId });
  }],
  ["a cloud session of a live step", recoverScopes, async (f) => {
    const { stepId } = await f.run("succeeded", { status: "running" });
    await f.db.insert(cloudSessions).values({ id: f.id("cs"), stepRunId: stepId, harnessId: "h_x", start: {} as never, status: "running" } as never);
  }],
];

for (const [name, listing, make] of cases) {
  test(`${listing.name} lists B's scope for ${name}, never an idle workspace`, async () => {
    const f = await twoWorkspaces();
    expect(await listing(f.db, NOW)).toEqual([]);
    await make(f);
    expect(await listing(f.db, NOW)).toEqual([f.b]);
  });
}

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

/** Like `shared` (work once, as is), but it calls each listing and keeps what it returned. */
function listingTenancy(db: Db) {
  const listed: Scope[][] = [];
  setTenancy(db, { async each(db, scopes, work) {
    listed.push(await scopes(db));
    await work();
  }, forRun: shared.forRun });
  onTestFinished(() => setTenancy(db, shared));
  return listed;
}

test("a tick claims in the workspaces with due work, then polls in those with polls", async () => {
  const f = await twoWorkspaces();
  await f.trigger("schedule", { nextFireAt: PAST, lastCheckedAt: PAST });
  await f.trigger("poll", { nextFireAt: PAST });
  const listed = listingTenancy(f.db);
  const engine = new Engine(f.db, new FakeAdapter());
  onTestFinished(() => engine.stop());
  await new Scheduler(f.db, engine, { now: () => NOW }).tick();
  // First the deadline sweep's pass (no routed question lapsed anywhere), then the claims and the polls.
  expect(listed).toEqual([[], [f.b], [f.b]]);
});

test("recover goes on in the workspaces with work to recover", async () => {
  const f = await twoWorkspaces();
  await f.run("running");
  const listed = listingTenancy(f.db);
  const engine = new Engine(f.db, new FakeAdapter());
  onTestFinished(() => engine.stop());
  await engine.recover();
  expect(listed).toEqual([[f.b]]);
});

test("the scheduler's ticks run under SYSTEM, whatever scope started it", { tags: ["pglite-only"] }, async () => {
  const f = await twoWorkspaces();
  const recorder = await recordScopes(f.db);
  const engine = new Engine(recorder.db, new FakeAdapter());
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(recorder.db, engine, { now: () => NOW });
  await inScope({ workspaceId: "ws_elsewhere" }, () => scheduler.start());
  await scheduler.stop();
  expect(recorder.statements.length).toBeGreaterThan(0);
  expect(new Set(recorder.statements.map((s) => s.scope))).toEqual(new Set([SYSTEM]));
});
