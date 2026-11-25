import type { Grant } from "@dispand/runner-protocol";
import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { agents, audit, harnesses, personalGrants, questions, runners, runs, stepRuns, subscriptionEnrollments, workspaceMembers, type RunTrigger } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { checkGrant, GRANT_TTL_MS, onGrantEnd, personalSwitch } from "../runners/grants.ts";
import { asCli, ownerContext, personContext, runnerWithClis } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { JOB_STEP } from "./job-def.ts";

// Personal placement (`runners/grants.ts`): Mia enrolled her Codex subscription on the runner,
// which has no workspace model key.

class FakeAdapter implements HarnessAdapter {
  starts: { start: StartParams; grant: Grant | undefined }[] = [];
  async start(_harness: Harness, start: StartParams, grant?: Grant) {
    this.starts.push({ start, grant });
    return true;
  }
  sent: string[] = [];
  async send(_sessionId: string, text: string) {
    this.sent.push(text);
    return true;
  }
  answered: string[] = [];
  async answer(_sessionId: string, questionId: string) {
    this.answered.push(questionId);
    return true;
  }
  async stop() {
    return true;
  }
}

afterEach(() => void (personalSwitch.on = true));

async function setup(limit = 2) {
  const context = await ownerContext();
  const mia = await personContext(context, "mia", "member");
  const { runnerId } = await runnerWithClis(context);
  await context.db.update(runners).set({ clis: { codex: { version: "0.169.0", signedIn: true } } }).where(eq(runners.id, runnerId));
  const harness = asCli(await call(router.harnesses.create, { name: "Codex", runnerId, kind: "codex", permissionMode: "default" }, { context }));
  await context.db.update(harnesses).set({ maxWorking: limit }).where(eq(harnesses.id, harness.id));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Sort the mail.", config: { kind: "manual", placement: "button" } }, { context });
  const enroll = async (id: string) => {
    await context.db.insert(subscriptionEnrollments).values({ id, workspaceId: context.workspaceId, runnerId, userId: "mia", harness: "codex", identity: `sha256:${"a".repeat(64)}` });
  };
  await enroll("enr_1");
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  /** A Job of `ownerId`, started by hand unless `firing` says otherwise; its run id once it went as far as it could. */
  const job = async (ownerId: string | null, firing: RunTrigger = { type: "manual" }) => {
    const cause = firing.type === "schedule" ? { kind: "schedule" as const, scheduledFor: firing.scheduledFor, depth: 0 } : { kind: "user" as const, depth: 0 };
    const runId = await context.db.transaction((tx) => engine.createJob(tx, { ownerId: ownerId as string, agentId: agent.id, triggerId: trigger.id, cause, firing }));
    await engine.continueRun(runId);
    return runId;
  };
  const step = async (runId: string) => (await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, JOB_STEP))))[0]!;
  const startOf = (runId: string) => adapter.starts.find((s) => s.start.runKey.startsWith(`${runId}-`));
  let seq = 0;
  const finish = (runId: string) => engine.onHarnessEvent(startOf(runId)!.start.sessionId, { type: "result", text: "Done." }, { runnerId, seq: ++seq });
  const paused = async (runId: string) => (await context.db.select({ details: audit.details }).from(audit).where(and(eq(audit.jobId, runId), eq(audit.action, "job.paused")))).map((r) => r.details);
  return { context, mia, runnerId, harness, adapter, engine, job, step, startOf, finish, enroll, paused };
}

test("the subscriber's own attended Job gets a grant on her enrollment, with a short ttl, and it ends with the action", async () => {
  const { context, runnerId, job, step, startOf, finish } = await setup();
  const ended: string[] = [];
  onTestFinished(onGrantEnd((_runner, grantId) => ended.push(grantId)));
  const runId = await job("mia");
  const { grant } = startOf(runId)!;
  expect(grant).toEqual({ id: expect.any(String), enrollmentId: "enr_1", ttlMs: GRANT_TTL_MS });
  expect(GRANT_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
  // Never stored with the step: a resume gets a grant of its own.
  expect(await step(runId)).toMatchObject({ placement: { kind: "personal", enrollmentId: "enr_1", actorId: "mia" } });
  expect((await step(runId)).start).not.toHaveProperty("grant");
  expect(await context.db.select({ stepRunId: personalGrants.stepRunId, runnerId: personalGrants.runnerId, actorId: personalGrants.actorId }).from(personalGrants)).toEqual([{ stepRunId: (await step(runId)).id, runnerId, actorId: "mia" }]);
  const [issued] = await context.db.select({ details: audit.details }).from(audit).where(eq(audit.action, "job.grantIssued"));
  expect(issued?.details).toEqual({ grantId: grant!.id, enrollmentId: "enr_1", runnerId });
  await finish(runId);
  await vi.waitFor(async () => expect(await context.db.select().from(personalGrants)).toEqual([]));
  expect(ended).toEqual([grant!.id]);
});

test("an unattended run, a run with a missing actor and a run whose actor lost access never get a grant", async () => {
  const { context, job, step, startOf, finish, paused } = await setup(1);
  // Unattended: a schedule's Job of the subscriber herself runs on no subscription; with no workspace key it can't run at all.
  const scheduled = await job("mia", { type: "schedule", scheduledFor: "2026-11-11T09:00:00.000Z" });
  expect(startOf(scheduled)).toBeUndefined();
  expect(await step(scheduled)).toMatchObject({ status: "failed", placement: null });
  expect((await step(scheduled)).error).toContain("engine.fail.personalOnly");

  // Placed while queued, then its actor goes missing or loses access: each pauses when handed its slot.
  const first = await job("mia");
  const noActor = await job("mia");
  expect(await step(noActor)).toMatchObject({ status: "pending", placement: { kind: "personal", actorId: "mia" } });
  await context.db.update(runs).set({ ownerId: null }).where(eq(runs.id, noActor));
  await finish(first);
  await vi.waitFor(async () => expect(await paused(noActor)).toEqual([{ reason: "actor" }]));
  expect(startOf(noActor)).toBeUndefined();
  expect(await step(noActor)).toMatchObject({ working: false, pendingAction: { kind: "start" } });

  const blocker = await job("mia");
  const lostAccess = await job("mia");
  expect(await step(lostAccess)).toMatchObject({ status: "pending", placement: { kind: "personal" } });
  await context.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "mia"));
  await finish(blocker);
  await vi.waitFor(async () => expect(await paused(lostAccess)).toEqual([{ reason: "access" }]));
  expect(startOf(lostAccess)).toBeUndefined();
  expect(await context.db.select().from(personalGrants)).toEqual([]);
});

test("a queued action after re-enrollment pauses: the new enrollment inherits nothing", async () => {
  const { context, job, step, startOf, finish, enroll, paused } = await setup(1);
  const first = await job("mia");
  const queued = await job("mia");
  expect(await step(queued)).toMatchObject({ status: "pending", placement: { enrollmentId: "enr_1" } });
  await context.db.delete(subscriptionEnrollments);
  await enroll("enr_2");
  await finish(first);
  await vi.waitFor(async () => expect(await paused(queued)).toEqual([{ reason: "enrollment" }]));
  expect(startOf(queued)).toBeUndefined();
  // A Job authorized after the re-enrollment runs on the new one.
  const later = await job("mia");
  expect(startOf(later)?.grant).toMatchObject({ enrollmentId: "enr_2" });
});

test("an expired grant can't be renewed or reopened, and a runner can only check its own", async () => {
  const { context, runnerId, job, startOf } = await setup();
  const { grant } = startOf(await job("mia"))!;
  const before = (await context.db.select({ expiresAt: personalGrants.expiresAt }).from(personalGrants))[0]!.expiresAt;
  expect(await checkGrant(context.db, "run_other", grant!.id)).toBeNull();
  // Renewed only by repeating the checks: a fresh ttl.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await checkGrant(context.db, runnerId, grant!.id)).toBe(GRANT_TTL_MS);
  expect((await context.db.select({ expiresAt: personalGrants.expiresAt }).from(personalGrants))[0]!.expiresAt.getTime()).toBeGreaterThan(before.getTime());
  await context.db.update(personalGrants).set({ expiresAt: new Date(Date.now() - 1) });
  expect(await checkGrant(context.db, runnerId, grant!.id)).toBeNull();
  expect(await context.db.select().from(personalGrants)).toEqual([]);
  expect(await checkGrant(context.db, runnerId, grant!.id)).toBeNull();
});

test("the per-request check denies after revocation, and the runner is told the grant ended", async () => {
  const { context, mia, runnerId, job, startOf } = await setup();
  const ended: string[] = [];
  onTestFinished(onGrantEnd((_runner, grantId) => ended.push(grantId)));
  const a = startOf(await job("mia"))!.grant!;
  const b = startOf(await job("mia"))!.grant!;
  expect(await checkGrant(context.db, runnerId, a.id)).toBe(GRANT_TTL_MS);
  // Access lost, before any removal path ran: denied at the next request.
  await context.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "mia"));
  expect(await checkGrant(context.db, runnerId, a.id)).toBeNull();
  expect(ended).toEqual([a.id]);
  await context.db.insert(workspaceMembers).values({ workspaceId: context.workspaceId, userId: "mia", role: "member" });
  // The subscriber revokes her enrollment: its grants end at once.
  expect(await checkGrant(context.db, runnerId, b.id)).toBe(GRANT_TTL_MS);
  await call(router.runners.endSubscription, { enrollmentId: "enr_1" }, { context: mia });
  expect(ended).toEqual([a.id, b.id]);
  expect(await checkGrant(context.db, runnerId, b.id)).toBeNull();
});

test("a runner with an enrollment and no workspace key is ready for its subscriber's attended run, and not for anyone else's or an unattended one", async () => {
  const { context, runnerId, job, step, startOf } = await setup();
  expect(startOf(await job("mia"))?.grant).toBeDefined();
  for (const runId of [await job(context.ownerId), await job("mia", { type: "schedule", scheduledFor: "2026-11-11T09:00:00.000Z" })]) {
    expect(startOf(runId)).toBeUndefined();
    expect((await step(runId)).error).toContain("engine.fail.personalOnly");
  }
  // With a workspace key, everyone else's runs go on it, never on her subscription.
  await context.db.update(runners).set({ clis: { codex: { version: "0.169.0", signedIn: true }, modelKeys: ["openai"] } }).where(eq(runners.id, runnerId));
  const owner = await job(context.ownerId);
  expect(startOf(owner)).toMatchObject({ grant: undefined });
  expect(await step(owner)).toMatchObject({ status: "running", placement: { kind: "workspace" } });
});

test("a personal chat's turn end retires its worker without failing it, and the next message resumes it on a grant of its own", async () => {
  const { context, mia, runnerId, engine, adapter } = await setup();
  const talk = await call(router.triggers.create, { agentId: (await context.db.select({ id: agents.id }).from(agents))[0]!.id, name: "Talk", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: talk.id }, { context: { ...mia, engine } });
  const chat = async () => (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId))).find((r) => r.start?.interactive)!;
  await vi.waitFor(async () => expect((await chat())?.placement).toMatchObject({ kind: "personal", actorId: "mia" }));
  const sessionId = (await chat()).sessionId;
  const first = adapter.starts.find((s) => s.start.sessionId === sessionId)!;
  expect(first.grant).toBeDefined();
  let seq = 0;
  const on = (sessionId: string, event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  await on(first.start.sessionId, { type: "text", delta: "How can I help?" });
  await on(first.start.sessionId, { type: "turn-end" });
  // What the runner sends when the grant ends between turns: its session retired, its worker gone, no error.
  await on(first.start.sessionId, { type: "session-ended" });
  expect(await chat()).toMatchObject({ status: "running", error: null });
  expect(await context.db.select().from(personalGrants)).toEqual([]);
  // Her next message never goes to the retired session: it starts a fresh worker, on a new grant.
  const starts = adapter.starts.length;
  await call(router.runs.sendChat, { runId, text: "And the rest?" }, { context: { ...mia, engine } });
  await vi.waitFor(() => expect(adapter.starts.length).toBe(starts + 1));
  expect(adapter.sent).toEqual([]);
  const next = adapter.starts.at(-1)!;
  expect(next.grant).toBeDefined();
  expect(next.grant!.id).not.toBe(first.grant!.id);
  expect(next.start.prompt).toContain("And the rest?");
  expect(await context.db.select({ reason: audit.details }).from(audit).where(and(eq(audit.jobId, runId), eq(audit.action, "job.paused")))).toEqual([]);
});

test("a message she queued during a personal turn goes to a fresh worker after it, never the retiring one", async () => {
  const { context, mia, runnerId, engine, adapter } = await setup();
  const talk = await call(router.triggers.create, { agentId: (await context.db.select({ id: agents.id }).from(agents))[0]!.id, name: "Talk", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: talk.id }, { context: { ...mia, engine } });
  const chat = async () => (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId))).find((r) => r.start?.interactive)!;
  await vi.waitFor(async () => expect((await chat())?.sessionId).toBeTruthy());
  const sessionId = (await chat()).sessionId!;
  let seq = 0;
  const on = (event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  await on({ type: "turn-start", turnId: "t1", interruptible: true });
  await call(router.runs.sendChat, { runId, text: "Queued meanwhile" }, { context: { ...mia, engine } });
  const starts = adapter.starts.length;
  await on({ type: "turn-end", turnId: "t1" });
  await vi.waitFor(() => expect(adapter.starts.length).toBe(starts + 1));
  expect(adapter.starts.at(-1)!.start.prompt).toContain("Queued meanwhile");
  expect(adapter.starts.at(-1)!.grant).toBeDefined();
  expect(adapter.sent).toEqual([]);
});

test("a message sent as her chat starts, that its first turn didn't take, goes to a fresh worker after that turn", async () => {
  const { context, mia, runnerId, engine, adapter } = await setup();
  const talk = await call(router.triggers.create, { agentId: (await context.db.select({ id: agents.id }).from(agents))[0]!.id, name: "Talk", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: talk.id }, { context: { ...mia, engine } });
  await call(router.runs.sendChat, { runId, text: "Sent at once" }, { context: { ...mia, engine } });
  const chat = async () => (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId))).find((r) => r.start?.interactive)!;
  await vi.waitFor(async () => expect((await chat())?.startDeliveredAt).toBeTruthy());
  const sessionId = (await chat()).sessionId!;
  let seq = 0;
  const on = (event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  // The first turn answers the start's own prompt, and ends without taking the message.
  await on({ type: "turn-start", turnId: "t1", interruptible: true });
  const starts = adapter.starts.length;
  const sent = adapter.sent.length;
  await on({ type: "turn-end", turnId: "t1" });
  await vi.waitFor(() => expect(adapter.starts.length).toBe(starts + 1));
  expect(adapter.starts.at(-1)!.start.prompt).toContain("Sent at once");
  expect(adapter.starts.at(-1)!.grant).toBeDefined();
  expect(adapter.sent.length).toBe(sent);
});

test("an answer her worker took in a finished turn stays settled, even when its worker is lost unannounced: the next message isn't paused", async () => {
  const { context, mia, runnerId, engine, adapter } = await setup();
  const talk = await call(router.triggers.create, { agentId: (await context.db.select({ id: agents.id }).from(agents))[0]!.id, name: "Talk", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: talk.id }, { context: { ...mia, engine } });
  const chat = async () => (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId))).find((r) => r.start?.interactive)!;
  await vi.waitFor(async () => expect((await chat())?.sessionId).toBeTruthy());
  const sessionId = (await chat()).sessionId!;
  let seq = 0;
  const on = (event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  await on({ type: "question", questionId: "rq_done", payload: { kind: "choice", questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }] }] } });
  const [q] = await context.db.select().from(questions).where(eq(questions.runId, runId));
  await call(router.questions.answer, { questionId: q!.id, answer: { kind: "choice", answers: { "Which?": "A" } } }, { context: { ...mia, engine } });
  await vi.waitFor(() => expect(adapter.answered).toEqual(["rq_done"]));
  await on({ type: "turn-end" });
  const starts = adapter.starts.length;
  await call(router.runs.sendChat, { runId, text: "Next" }, { context: { ...mia, engine } });
  await vi.waitFor(() => expect(adapter.starts.length).toBe(starts + 1));
  expect(adapter.starts.at(-1)!.grant).toBeDefined();
  expect(adapter.starts.at(-1)!.start.prompt).toContain("Next");
  expect(await context.db.select().from(audit).where(and(eq(audit.jobId, runId), eq(audit.action, "job.paused")))).toEqual([]);
});

test("a Claude Code subscription places nothing personally: only Codex is open", async () => {
  const { context, harness, job, step, startOf } = await setup();
  await context.db.update(harnesses).set({ kind: "claude-code" }).where(eq(harnesses.id, harness.id));
  await context.db.update(subscriptionEnrollments).set({ harness: "claude-code" });
  const runId = await job("mia");
  expect(startOf(runId)).toMatchObject({ grant: undefined });
  expect(await step(runId)).toMatchObject({ placement: { kind: "workspace" } });
  expect(await context.db.select().from(personalGrants)).toEqual([]);
});

test("with the switch off, nothing is placed personally", async () => {
  personalSwitch.on = false;
  const { context, runnerId, job, step, startOf } = await setup();
  const runId = await job("mia");
  expect(startOf(runId)).toMatchObject({ grant: undefined });
  expect(await step(runId)).toMatchObject({ status: "running", placement: { kind: "workspace" } });
  expect(await context.db.select().from(personalGrants)).toEqual([]);
  // A step placed while it was on can't spend anything once it is off.
  await context.db.update(stepRuns).set({ placement: { kind: "personal", enrollmentId: "enr_1", actorId: "mia" } }).where(eq(stepRuns.runId, runId));
  await context.db.insert(personalGrants).values({ id: "grant_x", workspaceId: context.workspaceId, stepRunId: (await step(runId)).id, runnerId, enrollmentId: "enr_1", actorId: "mia", expiresAt: new Date(Date.now() + 60_000) });
  expect(await checkGrant(context.db, runnerId, "grant_x")).toBeNull();
});

test("another person's answer doesn't continue the subscriber's action: it pauses, delivered or carried by a resume", async () => {
  const { context, runnerId, adapter, engine, job, step, startOf, paused } = await setup();
  const { answered } = adapter;
  const choice = { kind: "choice" as const, questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }] }] };
  let seq = 100;
  const ask = async (runId: string, rq: string) => {
    await engine.onHarnessEvent(startOf(runId)!.start.sessionId, { type: "question", questionId: rq, payload: choice }, { runnerId, seq: ++seq });
    return (await context.db.select().from(questions).where(eq(questions.runId, runId)))[0]!;
  };
  // Her own answer goes.
  const own = await job("mia");
  await engine.answer((await ask(own, "rq_1")).id, { kind: "choice", answers: { Which: "A" } }, { type: "user", userId: "mia" });
  await vi.waitFor(() => expect(answered).toEqual(["rq_1"]));
  // An answer recorded from another person (as a manager may give one) and not delivered yet: the
  // lost session's resume would carry it in its prompt, so it pauses instead.
  const other = await job("mia");
  const q = await ask(other, "rq_2");
  await context.db.update(questions).set({ status: "answered", answer: { kind: "choice", answers: { Which: "A" } }, answeredAt: new Date(), answeredBy: { type: "user", userId: context.ownerId } }).where(eq(questions.id, q.id));
  const starts = adapter.starts.length;
  await engine.onHarnessEvent(startOf(other)!.start.sessionId, { type: "error", kind: "not-running", message: "gone" }, { runnerId, seq: ++seq });
  await vi.waitFor(async () => expect(await paused(other)).toEqual([{ reason: "actor" }]));
  expect(answered).toEqual(["rq_1"]);
  expect(adapter.starts).toHaveLength(starts);
  expect(await step(other)).toMatchObject({ working: false, pendingAction: { kind: "resume" } });
  expect(await context.db.select().from(personalGrants).where(eq(personalGrants.stepRunId, (await step(other)).id))).toEqual([]);
});

describe("personal-approvals", () => {
  const choice = { kind: "choice" as const, questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }] }] };

  /** Setup, plus a manager who may answer the Approvals the subscriber's Jobs ask (here, addressed to them). */
  async function approvals() {
    const s = await setup();
    // Every procedure call goes to the engine under test.
    const max = { ...(await personContext(s.context, "max", "manager")), engine: s.engine };
    const mia = { ...s.mia, engine: s.engine };
    const context = { ...s.context, engine: s.engine };
    let seq = 100;
    /** Her Job asks `rq`; the question is addressed to the manager, who answers it through the Inbox. */
    const answeredByManager = async (rq: string) => {
      const runId = await s.job("mia");
      await s.engine.onHarnessEvent(s.startOf(runId)!.start.sessionId, { type: "question", questionId: rq, payload: choice }, { runnerId: s.runnerId, seq: ++seq });
      const [q] = await s.context.db.update(questions).set({ ownerId: "max", addresseeId: "max", route: null }).where(eq(questions.runId, runId)).returning();
      await call(router.questions.answer, { questionId: q!.id, answer: { kind: "choice", answers: { "Which?": "A" } } }, { context: max });
      await vi.waitFor(async () => expect((await s.context.db.select({ consent: questions.consent }).from(questions).where(eq(questions.id, q!.id)))[0]?.consent).toEqual({ state: "awaiting", enrollmentId: "enr_1" }));
      return { runId, questionId: q!.id };
    };
    const consent = (questionId: string, as = mia) => call(router.questions.consent, { questionId }, { context: as });
    return { ...s, context, max, answeredByManager, consent };
  }

  test("a manager's answer waits for the subscriber's consent, keeping the worker that asked; her consent delivers it, once", async () => {
    const { context, adapter, answeredByManager, consent, paused, step } = await approvals();
    const { runId, questionId } = await answeredByManager("rq_1");
    // Recorded as the manager's, not delivered, not paused: the worker and its grant stay.
    expect((await context.db.select({ answeredBy: questions.answeredBy, grantId: questions.grantId }).from(questions).where(eq(questions.id, questionId)))[0]).toEqual({ answeredBy: { type: "user", userId: "max" }, grantId: adapter.starts[0]!.grant!.id });
    expect(adapter.answered).toEqual([]);
    expect(await paused(runId)).toEqual([]);
    expect(await context.db.select().from(personalGrants).where(eq(personalGrants.stepRunId, (await step(runId)).id))).toHaveLength(1);
    // Its worker keeps its slot; the wait is audited.
    expect(await step(runId)).toMatchObject({ working: true, status: "running" });
    expect(await context.db.select({ resourceType: audit.resourceType, resourceId: audit.resourceId, details: audit.details }).from(audit).where(eq(audit.action, "question.awaitingConsent"))).toEqual([{ resourceType: "question", resourceId: questionId, details: { enrollmentId: "enr_1" } }]);
    await consent(questionId);
    await vi.waitFor(() => expect(adapter.answered).toEqual(["rq_1"]));
    const [audited] = await context.db.select({ actor: audit.actor, resourceType: audit.resourceType, resourceId: audit.resourceId, details: audit.details }).from(audit).where(eq(audit.action, "question.consented"));
    expect(audited).toEqual({ actor: { type: "user", userId: "mia" }, resourceType: "question", resourceId: questionId, details: { enrollmentId: "enr_1" } });
    // Single use: nothing is left to consent to.
    await expect(consent(questionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(adapter.answered).toEqual(["rq_1"]);
  });

  test("the subscriber finds the answers awaiting her consent in her Inbox and on the Job; nobody else is told they are theirs", async () => {
    const { context, max, mia, answeredByManager, consent } = await approvals();
    const ava = { ...(await personContext(context, "ava", "member")), engine: context.engine };
    const { runId, questionId } = await answeredByManager("rq_1");
    const inbox = (as: typeof mia, status: "pending" | "all" = "pending") => call(router.questions.list, { status }, { context: as });
    const own = await inbox(mia);
    expect(own).toMatchObject([{ id: questionId, status: "answered", consent: "awaiting", yoursToConsent: true }]);
    // The manager who answered sees it done, as anyone else would: not theirs to consent to.
    for (const other of [max, context, ava]) for (const q of await inbox(other, "all")) expect(q).not.toHaveProperty("yoursToConsent");
    expect(await inbox(ava, "all")).toEqual([]);
    const job = await call(router.runs.get, { runId }, { context: mia });
    expect(job.questions).toMatchObject([{ id: questionId, yoursToConsent: true }]);
    expect(job.steps.find((x) => x.nodeId === JOB_STEP)).toMatchObject({ credential: "personal" });
    const owners = await call(router.runs.get, { runId }, { context });
    expect(owners.questions[0]).not.toHaveProperty("yoursToConsent");
    // No view names the enrollment, its subscriber's digest or her placement.
    for (const view of [own, job, owners, await inbox(max, "all")]) {
      const json = JSON.stringify(view);
      for (const secret of ["enr_1", "a".repeat(64), "actorId", "enrollmentId"]) expect(json).not.toContain(secret);
    }
    // Done items of no step and no consent stay in the manager's history.
    expect((await inbox(max, "all")).map((q) => q.id)).toContain(questionId);
    // Stopped, her Job's answer is no longer hers to consent to.
    const [stepRow] = await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, JOB_STEP)));
    await context.db.update(stepRuns).set({ status: "failed" }).where(eq(stepRuns.id, stepRow!.id));
    expect(await inbox(mia)).toEqual([]);
    await context.db.update(stepRuns).set({ status: stepRow!.status }).where(eq(stepRuns.id, stepRow!.id));
    // Given: nothing is left for her to consent to, and it leaves her Inbox.
    await consent(questionId);
    expect(await inbox(mia)).toEqual([]);
    for (const q of await inbox(mia, "all")) expect(q).not.toHaveProperty("yoursToConsent");
    // A done item of no step and no consent (as a checkpoint's Approval) stays in its addressee's history.
    await context.db.update(questions).set({ stepRunId: null, consent: null, deliveredAt: null }).where(eq(questions.id, questionId));
    expect((await inbox(max, "all")).map((q) => q.id)).toContain(questionId);
  });

  test("a paused action shows why, and the answer it couldn't take waits for its recovery", async () => {
    const { context, mia, answeredByManager, consent, step } = await approvals();
    const jobStep = async (runId: string) => (await call(router.runs.get, { runId }, { context: mia })).steps.find((x) => x.nodeId === JOB_STEP);
    const expired = await answeredByManager("rq_1");
    expect(await jobStep(expired.runId)).not.toHaveProperty("paused");
    await context.db.update(personalGrants).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(personalGrants.stepRunId, (await step(expired.runId)).id));
    await consent(expired.questionId);
    await vi.waitFor(async () => expect(await jobStep(expired.runId)).toMatchObject({ credential: "personal", paused: "worker" }));
    const job = await call(router.runs.get, { runId: expired.runId }, { context: mia });
    expect(job.questions).toMatchObject([{ id: expired.questionId, status: "answered", recovery: true }]);
    expect(job.questions[0]).not.toHaveProperty("yoursToConsent");
    // Stopped, it is no longer paused, and its answer waits for nothing.
    const [stepRow] = await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, expired.runId), eq(stepRuns.nodeId, JOB_STEP)));
    await context.db.update(stepRuns).set({ status: "failed" }).where(eq(stepRuns.id, stepRow!.id));
    const stopped = await call(router.runs.get, { runId: expired.runId }, { context: mia });
    expect(stopped.steps.find((x) => x.nodeId === JOB_STEP)).not.toHaveProperty("paused");
    expect(stopped.questions[0]).not.toHaveProperty("recovery");
    await context.db.update(stepRuns).set({ status: stepRow!.status }).where(eq(stepRuns.id, stepRow!.id));
    // Handed a slot again, it shows no reason while it holds one.
    await context.db.update(stepRuns).set({ working: true }).where(eq(stepRuns.runId, expired.runId));
    expect(await jobStep(expired.runId)).not.toHaveProperty("paused");
  });

  test("consent from someone else, or for another answer, does nothing", async () => {
    const { context, adapter, max, answeredByManager, consent } = await approvals();
    const a = await answeredByManager("rq_a");
    const b = await answeredByManager("rq_b");
    // The manager who answered, and the workspace's owner, can't consent in her place.
    for (const other of [max, context]) await expect(consent(a.questionId, other)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await context.db.select().from(audit).where(eq(audit.action, "question.consented"))).toEqual([]);
    // Her consent to one answer continues that one only.
    await consent(a.questionId);
    await vi.waitFor(() => expect(adapter.answered).toEqual(["rq_a"]));
    expect((await context.db.select({ consent: questions.consent, deliveredAt: questions.deliveredAt }).from(questions).where(eq(questions.id, b.questionId)))[0]).toEqual({ consent: { state: "awaiting", enrollmentId: "enr_1" }, deliveredAt: null });
  });

  test("an answer whose pending request isn't restored stays paused: the worker that asked is gone", async () => {
    const { context, runnerId, adapter, engine, answeredByManager, consent, paused, startOf, step } = await approvals();
    // Its grant ended (a newer worker's, or past its deadline): the request lives in no worker.
    const expired = await answeredByManager("rq_1");
    await context.db.update(personalGrants).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(personalGrants.stepRunId, (await step(expired.runId)).id));
    await consent(expired.questionId);
    await vi.waitFor(async () => expect(await paused(expired.runId)).toEqual([{ reason: "worker" }]));
    expect(await step(expired.runId)).toMatchObject({ working: false, pendingAction: { kind: "deliver" } });
    // Its session lost: the resume would carry the answer into a replacement, so it pauses, and consent doesn't change that.
    const lost = await answeredByManager("rq_2");
    const starts = adapter.starts.length;
    await engine.onHarnessEvent(startOf(lost.runId)!.start.sessionId, { type: "error", kind: "not-running", message: "gone" }, { runnerId, seq: 999 });
    await vi.waitFor(async () => expect(await paused(lost.runId)).toEqual([{ reason: "actor" }]));
    await consent(lost.questionId);
    expect(adapter.starts).toHaveLength(starts);
    expect(adapter.answered).toEqual([]);
  });

  test("the subscriber's own answer to a request in a lost worker isn't carried into a replacement: the action pauses", async () => {
    const { context, mia, runnerId, adapter, engine, job, startOf, paused } = await approvals();
    const runId = await job("mia");
    const sessionId = startOf(runId)!.start.sessionId;
    await engine.onHarnessEvent(sessionId, { type: "question", questionId: "rq_own", payload: choice }, { runnerId, seq: 500 });
    const [q] = await context.db.select().from(questions).where(eq(questions.runId, runId));
    await call(router.questions.answer, { questionId: q!.id, answer: { kind: "choice", answers: { "Which?": "A" } } }, { context: mia });
    // The worker that asked is lost before the answer is confirmed there: no replacement restores the request.
    const starts = adapter.starts.length;
    await engine.onHarnessEvent(sessionId, { type: "error", kind: "not-running", message: "gone" }, { runnerId, seq: 501 });
    await vi.waitFor(async () => expect(await paused(runId)).toEqual([{ reason: "worker" }]));
    expect(adapter.starts).toHaveLength(starts);
  });

  test("the subscriber's own answer, given after her lost worker was replaced, reaches no worker: the action pauses", async () => {
    const { context, mia, runnerId, adapter, engine, job, startOf, paused } = await approvals();
    const runId = await job("mia");
    const sessionId = startOf(runId)!.start.sessionId;
    await engine.onHarnessEvent(sessionId, { type: "question", questionId: "rq_late", payload: choice }, { runnerId, seq: 600 });
    // Lost while the request waits: a replacement starts, without it.
    const starts = adapter.starts.length;
    await engine.onHarnessEvent(sessionId, { type: "error", kind: "not-running", message: "gone" }, { runnerId, seq: 601 });
    await vi.waitFor(() => expect(adapter.starts.length).toBe(starts + 1));
    const [q] = await context.db.select().from(questions).where(eq(questions.runId, runId));
    await call(router.questions.answer, { questionId: q!.id, answer: { kind: "choice", answers: { "Which?": "A" } } }, { context: mia });
    await vi.waitFor(async () => expect(await paused(runId)).toEqual([{ reason: "worker" }]));
    expect(adapter.answered).toEqual([]);
    expect(adapter.sent).toEqual([]);
    // The pause ended the replacement's grant mid-turn: what its stopped worker reports leaves the step paused, not failed.
    await engine.onHarnessEvent(sessionId, { type: "error", message: "this action's personal grant ended" }, { runnerId, seq: 602 });
    const [now] = await context.db.select().from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
    expect(now).toMatchObject({ status: "running", error: null, pendingAction: { paused: "worker" } });
    // A replacement started on its recovery holds a grant of its own: its errors count again.
    await context.db.insert(personalGrants).values({ id: "grant_next", workspaceId: context.workspaceId, stepRunId: now!.id, runnerId, enrollmentId: "enr_1", actorId: "mia", expiresAt: new Date(Date.now() + 60_000) });
    await engine.onHarnessEvent(sessionId, { type: "error", message: "the CLI failed" }, { runnerId, seq: 603 });
    expect((await context.db.select().from(stepRuns).where(eq(stepRuns.sessionId, sessionId)))[0]).toMatchObject({ status: "failed" });
  });

  test("a consent under a replaced enrollment continues nothing, nor one whose answerer may no longer answer", async () => {
    const { context, adapter, answeredByManager, consent, enroll, paused } = await approvals();
    const replaced = await answeredByManager("rq_1");
    const lostRight = await answeredByManager("rq_2");
    await context.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "max"));
    await consent(lostRight.questionId);
    await vi.waitFor(async () => expect(await paused(lostRight.runId)).toEqual([{ reason: "approver" }]));
    await context.db.delete(subscriptionEnrollments);
    await enroll("enr_2");
    await consent(replaced.questionId);
    await vi.waitFor(async () => expect(await paused(replaced.runId)).toEqual([{ reason: "enrollment" }]));
    expect(adapter.answered).toEqual([]);
  });
});

test("a workspace-credential step says so, and pauses nothing", async () => {
  personalSwitch.on = false;
  const { context, job } = await setup();
  const runId = await job("mia");
  const view = (await call(router.runs.get, { runId }, { context })).steps.find((x) => x.nodeId === JOB_STEP);
  expect(view).toMatchObject({ credential: "workspace" });
  expect(view).not.toHaveProperty("paused");
});
