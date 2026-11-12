import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { ChatItem, TurnInput } from "../cloud/model-client.ts";
import { fakeModel, say, use } from "../cloud/test-model.ts";
import { proposals, questions, runs, tools as toolsTable, triggers } from "../db/schema.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { Scheduler } from "../engine/scheduler.ts";
import { newId } from "../ids.ts";
import { callPlatformTool } from "../platform/call.ts";
import { platformToolCaller } from "../platform/cloud.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { ReviewSignal } from "./review.ts";

// The Assistant's review of the workspace: each signal found and not found, read from the rows
// alone, and a scheduled review that proposes in the Inbox and applies only what is approved.

const DAY = 86_400_000;
const NOW = new Date("2026-11-12T12:00:00Z");

/** The owner with a runner harness (its runner away: Jobs stay going) and the Assistant on it, on a fixed clock. */
async function setup() {
  const base = await ownerContext();
  const context = { ...base, now: () => NOW };
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const assistant = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context });
  const review = () => call(router.workspace.review, undefined, { context });
  const kinds = async () => (await review()).map((s) => s.key);
  const agent = (name: string, more: object = {}) => call(router.agents.create, { name, harnessId: harness.id, systemPrompt: "", ...more }, { context });
  const button = (agentId: string) => call(router.triggers.create, { agentId, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  return { context, harness, assistant, review, kinds, agent, button };
}

test("an empty workspace has nothing to review: the Assistant has its chat, and reads every table itself", async () => {
  const s = await setup();
  expect(await s.review()).toEqual([]);
});

test("an agent without a trigger is a signal until it gets one", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk");
  expect(await s.review()).toEqual([{ key: `agent-without-trigger:${clerk.id}`, kind: "agent-without-trigger", agentId: clerk.id, name: "Clerk" }]);
  await s.button(clerk.id);
  expect(await s.review()).toEqual([]);
});

test("a table no agent but the Assistant works on is a signal, until one gets data on it or on every table", async () => {
  const s = await setup();
  const matters = await call(router.tables.create, { name: "Matters" }, { context: s.context });
  expect(await s.review()).toEqual([{ key: `table-not-read:${matters.id}`, kind: "table-not-read", tableId: matters.id, name: "Matters" }]);
  // configure alone, or data on another table, reads nothing of it.
  const other = await call(router.tables.create, { name: "Other" }, { context: s.context });
  const builder = await s.agent("Builder", { bundles: ["configure"], dataTables: "all" });
  const clerk = await s.agent("Clerk", { bundles: ["data"], dataTables: [other.id] });
  await s.button(builder.id);
  await s.button(clerk.id);
  expect(await s.kinds()).toEqual([`table-not-read:${matters.id}`]);
  const reader = await s.agent("Reader", { bundles: ["data"], dataTables: "all" });
  await s.button(reader.id);
  expect(await s.review()).toEqual([]);
});

test("a tool waiting for its owner's sign-in is a signal, with where to sign in; an open one is not", async () => {
  const s = await setup();
  await s.context.db.insert(toolsTable).values([
    { id: "tool_waits", ownerId: s.context.ownerId, name: "Mail", kind: "http", url: "https://mail.test/mcp", transport: "streamable-http", auth: "oauth", oauthStatus: "authorize" },
    { id: "tool_open", ownerId: s.context.ownerId, name: "Open", kind: "http", url: "https://open.test/mcp", transport: "streamable-http" },
  ] as never);
  expect(await s.review()).toEqual([{ key: "tool-needs-sign-in:tool_waits", kind: "tool-needs-sign-in", toolId: "tool_waits", name: "Mail", signInPath: "/settings/tools?tool=tool_waits" }]);
  await s.context.db.update(toolsTable).set({ oauthStatus: "connected" }).where(eq(toolsTable.id, "tool_waits"));
  expect(await s.review()).toEqual([]);
});

test("a Question open more than three days is a signal; a newer one, an answered one or a consult is not", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk");
  const { runId } = await call(router.jobs.start, { triggerId: (await s.button(clerk.id)).id }, { context: s.context });
  const ask = (kind: "question" | "approval" | "consult", ago: number, status: "pending" | "answered" = "pending") =>
    s.context.db
      .insert(questions)
      .values({ id: newId("q"), ownerId: s.context.ownerId, runId, placement: "notifications", kind, status, createdAt: new Date(NOW.getTime() - ago), payload: { kind: "permission", toolName: "Bash", input: {}, canAlwaysAllow: false } })
      .returning()
      .then((r) => r[0]!);
  const old = await ask("question", 3 * DAY + 60_000);
  await ask("approval", 3 * DAY - 60_000);
  await ask("approval", 10 * DAY, "answered");
  await ask("consult", 10 * DAY);
  expect(await s.review()).toEqual([{ key: `question-open:${old.id}`, kind: "question-open", questionId: old.id, runId, since: old.createdAt }]);
});

test("a button started four times in two weeks within one hour of the day is a signal, read in the review's time zone", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk");
  const go = await s.button(clerk.id);
  const startAt = async (at: string) => {
    const { runId } = await call(router.jobs.start, { triggerId: go.id }, { context: s.context });
    await s.context.db.update(runs).set({ createdAt: new Date(at) }).where(eq(runs.id, runId));
  };
  // 09:xx in Paris (UTC+1 in November), on four days; one of them 15 days ago, out of the window.
  for (const at of ["2026-10-28T08:10:00Z", "2026-11-02T08:05:00Z", "2026-11-04T08:40:00Z", "2026-11-09T08:55:00Z", "2026-11-12T13:00:00Z"]) await startAt(at);
  expect(await s.review()).toEqual([]);
  await startAt("2026-11-11T08:30:00Z");
  expect(await s.review()).toEqual([{ key: `recurring-button:${go.id}`, kind: "recurring-button", triggerId: go.id, agentId: clerk.id, name: "Go", starts: 4, hour: 9, timezone: "Europe/Paris" }]);
  // In the time zone the owner turned the review on in, the hour is theirs.
  await call(router.triggers.update, { id: s.assistant.reviewTriggerId!, enabled: true, config: { kind: "schedule", cron: "0 9 * * 1", timezone: "America/New_York" } }, { context: s.context });
  expect(await s.review()).toMatchObject([{ hour: 3, timezone: "America/New_York" }]);
});

test("a signal whose proposal the owner declined in the last 30 days is left out; one declined before comes back", async () => {
  const s = await setup();
  const clerk = await s.agent("Clerk");
  const key = `agent-without-trigger:${clerk.id}`;
  const { runId } = await call(router.jobs.start, { triggerId: s.assistant.triggerId }, { context: s.context });
  const [declined] = await s.context.db
    .insert(questions)
    .values({
      id: newId("q"),
      ownerId: s.context.ownerId,
      runId,
      placement: "notifications",
      kind: "approval",
      status: "answered",
      payload: { kind: "permission", toolName: "request_approval", input: { message: `Give the Clerk a button? [${key}]` }, canAlwaysAllow: false },
      answer: { kind: "permission", decision: "deny" },
      answeredAt: new Date(NOW.getTime() - 29 * DAY),
    })
    .returning();
  expect(await s.review()).toEqual([]);
  await s.context.db.update(questions).set({ answeredAt: new Date(NOW.getTime() - 31 * DAY) }).where(eq(questions.id, declined!.id));
  expect(await s.kinds()).toEqual([key]);
  // An allowance is no "no".
  await s.context.db.update(questions).set({ answeredAt: NOW, answer: { kind: "permission", decision: "allow" } }).where(eq(questions.id, declined!.id));
  expect(await s.kinds()).toEqual([key]);
});

test("workspace_review is a configure read; a Job limited to some tables isn't told of the others", async () => {
  const s = await setup();
  const mine = await call(router.tables.create, { name: "Mine" }, { context: s.context });
  const theirs = await call(router.tables.create, { name: "Theirs" }, { context: s.context });
  const asJob = async (bundles: string[], dataTables: unknown) => {
    const agent = await s.agent(`Reader ${bundles.join(" ")}`, { bundles, dataTables });
    const { runId } = await call(router.jobs.start, { triggerId: (await s.button(agent.id)).id }, { context: s.context });
    return () => callPlatformTool(s.context, { runId, ownerId: s.context.ownerId, agentId: agent.id }, "workspace_review", {});
  };
  expect(await (await asJob([], "all"))()).toEqual({ ok: false, error: "This agent may not use workspace_review" });
  const limited = await (await asJob(["configure"], [mine.id]))();
  expect(limited.ok).toBe(true);
  const named = ((limited as { output: ReviewSignal[] }).output).map((x) => x.key);
  expect(named).toContain(`table-not-read:${mine.id}`);
  expect(named).not.toContain(`table-not-read:${theirs.id}`);
});

const toolResults = (items: ChatItem[]) => items.filter((i): i is Extract<ChatItem, { role: "tool" }> => i.role === "tool");
const lastResult = (input: TurnInput) => JSON.parse(toolResults(input.items).at(-1)!.result);

/**
 * The Assistant on a cloud harness whose model reviews as the skill says: reads the signals,
 * proposes a trigger for the agent without one, asks for it, then applies it. Its review is turned
 * on, and the scheduler fires it on Monday at 09:00.
 */
async function scheduledReview() {
  const base = await ownerContext();
  let now = new Date("2026-11-15T12:00:00Z");
  const ids = { proposalId: "", key: "" };
  const model = fakeModel(
    use("workspace_review", {}),
    (input) => {
      const [signal] = lastResult(input) as ReviewSignal[];
      if (signal?.kind !== "agent-without-trigger") throw new Error("expected an agent without a trigger");
      ids.key = signal.key;
      const item = { tool: "triggers_create", input: { agentId: signal.agentId, name: "Weekly", instructions: "Do the weekly work.", config: { kind: "schedule", cron: "0 8 * * 1", timezone: "Europe/Paris" } } };
      return { toolCalls: [{ id: "p", name: "propose", args: { items: [item] } }] };
    },
    (input) => {
      ids.proposalId = lastResult(input).proposalId;
      return { toolCalls: [{ id: "r", name: "request_approval", args: { message: `Start the Clerk every Monday at 08:00? [${ids.key}]`, proposal: ids.proposalId } }] };
    },
    () => ({ toolCalls: [{ id: "a", name: "proposal_apply", args: { proposalId: ids.proposalId } }] }),
    say("Proposed one trigger."),
  );
  const engine = createEngine(base.db, base.hub, base.secrets, base.dataEvents, { tools: platformToolCaller(() => context), client: model.client });
  onTestFinished(() => engine.stop());
  const context = { ...base, engine, now: () => now };
  const cloud = await call(router.harnesses.create, { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "sk-test", model: "m", systemPrompt: "" } as never, { context });
  const assistant = await call(router.agents.ensureAssistant, { harnessId: cloud.id }, { context });
  const clerk = await call(router.agents.create, { name: "Clerk", harnessId: cloud.id, systemPrompt: "" }, { context });
  await call(router.triggers.update, { id: assistant.reviewTriggerId!, enabled: true, config: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Paris" } }, { context });
  const scheduler = new Scheduler(context.db, engine, { now: () => now });
  // Monday 16 November, 09:00 in Paris.
  now = new Date("2026-11-16T08:00:30Z");
  const [runId] = await scheduler.tick();
  if (!runId) throw new Error("the review didn't fire");
  const approval = await vi.waitFor(async () => {
    const [q] = await context.db.select().from(questions).where(eq(questions.runId, runId));
    if (!q) throw new Error("no approval yet");
    return q;
  });
  const until = (status: string) =>
    vi.waitFor(async () => {
      const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
      if (run!.status !== status) throw new Error(`run is ${run!.status}`);
    });
  const clerkTriggers = () => context.db.select().from(triggers).where(eq(triggers.agentId, clerk.id));
  return { context, model, runId, approval, until, clerkTriggers, ids, assistant };
}

test("a scheduled review proposes in the Inbox, and applies the proposal once the owner approves it", async () => {
  const r = await scheduledReview();
  const [run] = await r.context.db.select().from(runs).where(eq(runs.id, r.runId));
  expect(run).toMatchObject({ triggerId: r.assistant.reviewTriggerId });
  // No one watches a scheduled Job's chat: the request is an Inbox item, with the proposal shown whole.
  expect(r.approval).toMatchObject({ placement: "notifications", kind: "approval", proposalId: r.ids.proposalId });
  const item = (await call(router.questions.list, { status: "pending" }, { context: r.context })).find((i) => i.id === r.approval.id)!;
  expect(item.proposal!.items).toEqual([expect.objectContaining({ tool: "triggers_create" })]);
  expect(await r.clerkTriggers()).toEqual([]);

  await call(router.questions.answer, { questionId: r.approval.id, answer: { kind: "permission", decision: "allow" } }, { context: r.context });
  await r.until("succeeded");
  const [applied] = toolResults(r.model.inputs[4]!.items).slice(-1);
  expect(applied).toMatchObject({ name: "proposal_apply", isError: false });
  expect(await r.clerkTriggers()).toEqual([expect.objectContaining({ name: "Weekly", kind: "schedule", config: expect.objectContaining({ cron: "0 8 * * 1" }) })]);
});

test("a scheduled review applies nothing the owner declined", async () => {
  const r = await scheduledReview();
  await call(router.questions.answer, { questionId: r.approval.id, answer: { kind: "permission", decision: "deny", message: "Not this one." } }, { context: r.context });
  await r.until("succeeded");
  const [refused] = toolResults(r.model.inputs[4]!.items).slice(-1);
  expect(refused).toMatchObject({ name: "proposal_apply", isError: true });
  expect((await r.context.db.select().from(proposals).where(eq(proposals.id, r.ids.proposalId)))[0]!.status).toBe("declined");
  expect(await r.clerkTriggers()).toEqual([]);
});
