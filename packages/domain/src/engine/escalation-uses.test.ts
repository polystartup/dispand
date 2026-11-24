import { call } from "@orpc/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { agentEscalations, agents, audit, organizationMembers, pushSubscriptions, questions, type Route, stepRuns, user, workspaceMembers } from "../db/schema.ts";
import { subscriptionKeysAad } from "../push/keys.ts";
import { PushSender, type Send } from "../push/sender.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext, personContext, runnerWithClis } from "../runners/test-support.ts";
import { NOBODY_TEXT, REFUSED_TEXT } from "./routing.ts";

// Check at use (`engine/routing.ts`): every place that uses an escalation (a question routed to a
// person outside a chat) re-checks its addressee first, through `Engine.checkEscalation`, in its
// own transaction. This test lists those uses and fails when a file reads a question's person
// addressee without being one of them (or saying why it isn't), or a listed use stops checking.

const SRC = join(import.meta.dirname, "..");

/** The uses: each file, what it does with an escalation. Each calls `checkEscalation` before going on. */
const USES: Record<string, string[]> = {
  "questions/procedures.ts": ["listing"],
  "push/sender.ts": ["notifying, and each retry"],
};

/** Files that read a question's addressee and are no use of one, with why. */
const NOT_USES: Record<string, string> = {
  "db/schema.ts": "the column itself",
  "engine/engine.ts": "the check itself; answering (`Engine.answer` checks in the transaction that records the answer); and the deadline sweep (`sweepEscalations`), which moves a lapsed hop on through the same `moveOn`",
  "engine/routing.ts": "the rule the check applies",
  "engine/interactions.ts": "the Audit row of a question as it is recorded",
  "engine/views.ts": "shows a question's addressee and hop on its Job's page, to whoever may read the run: never answers or notifies",
  "runners/test-support.ts": "a test helper's insert",
  "engine/roots.ts": "writes a checkpoint's Approval, which is no escalation",
  "plugins/resolve.ts": "writes a plugin update's Approval, which is no escalation",
  "assistant/review.ts": "counts stale items for the Assistant's review: never shows, answers or notifies one",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [relative(SRC, path)] : [];
  });
}

test("every reader of a question's person addressee is a listed use that checks it, or says why it is none", () => {
  const readers = files(SRC).filter((f) => /\baddresseeId\b/.test(readFileSync(join(SRC, f), "utf8")));
  expect(readers.filter((f) => !(f in USES) && !(f in NOT_USES))).toEqual([]);
  for (const f of Object.keys(USES)) expect(readFileSync(join(SRC, f), "utf8"), f).toMatch(/checkEscalation\(/);
});

const choice = { kind: "choice" as const, questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }], multiSelect: false }] };

/** The owner's agent, made by Bob (a member), with a Job; `escalation(to, route)` adds a pending one addressed to `to`. */
async function setup() {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_bob", name: "Bob", email: "bob@example.com" });
  await context.db.insert(organizationMembers).values({ organizationId: context.organizationId, userId: "user_bob", role: "member" });
  await context.db.insert(workspaceMembers).values({ workspaceId: context.workspaceId, userId: "user_bob", role: "member" });
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", escalateMode: "auto" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  let n = 0;
  const escalation = async (to: string, route: Route) => {
    // PGlite's clock ticks in milliseconds: an item asked in a subscription's millisecond would tie with it.
    await new Promise((resolve) => setTimeout(resolve, 3));
    const id = `q_esc_${++n}`;
    await context.db.insert(questions).values({ id, ownerId: to, addresseeId: to, route, runId, stepRunId: step!.id, sessionId: step!.sessionId!, runnerQuestionId: `rq_${n}`, placement: "notifications", kind: "question", payload: choice, status: "pending" });
    return id;
  };
  const row = async (id: string) => (await context.db.select().from(questions).where(eq(questions.id, id)))[0]!;
  const actions = async (id: string) => (await context.db.select().from(audit).where(eq(audit.resourceId, id))).map((r) => [r.action, r.details]);
  const setAgent = (values: Partial<typeof agents.$inferInsert>) => context.db.update(agents).set(values).where(eq(agents.id, agent.id));
  return { context, agentId: agent.id, escalation, row, actions, setAgent };
}

describe("escalation uses", () => {
  test("listing: an escalation whose agent may no longer ask a person is settled before the Inbox is read, and isn't listed", async () => {
    const s = await setup();
    await s.setAgent({ ownerId: s.context.ownerId });
    const id = await s.escalation(s.context.ownerId, { hop: 2, reason: "noFit", tried: [s.context.ownerId] });
    expect((await call(router.questions.list, { status: "pending" }, { context: s.context })).map((q) => q.id)).toEqual([id]);
    await s.setAgent({ escalateMode: "disabled" });
    expect(await call(router.questions.list, { status: "pending" }, { context: s.context })).toEqual([]);
    expect(await s.row(id)).toMatchObject({ status: "answered", answer: { kind: "choice", answers: { "Which region?": REFUSED_TEXT } } });
    expect(await s.actions(id)).toContainEqual(["question.unanswered", { from: s.context.ownerId, hop: 2, reason: "not_allowed", hops: 1 }]);
  });

  test("answering: an escalation whose addressee may no longer be asked moves on, and the answer is refused", async () => {
    const s = await setup();
    await s.setAgent({ ownerId: s.context.ownerId });
    const id = await s.escalation(s.context.ownerId, { hop: 2, reason: "noFit", tried: [s.context.ownerId] });
    await s.setAgent({ escalateMode: "disabled" });
    await expect(call(router.questions.answer, { questionId: id, answer: { kind: "choice", answers: { "Which region?": "EU" } } }, { context: s.context })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await s.row(id)).toMatchObject({ status: "answered", answer: { answers: { "Which region?": REFUSED_TEXT } } });
  });

  test("a picked member lists and answers their escalation; taken off the whitelist, their listing moves it to the creator and their answer is refused", async () => {
    const s = await setup();
    const ann = await personContext(s.context, "user_ann", "member");
    await s.setAgent({ ownerId: s.context.ownerId, escalateMode: "whitelist" });
    await s.context.db.insert(agentEscalations).values({ agentId: s.agentId, userId: "user_ann" });
    const picked = { hop: 1 as const, reason: "picked" as const, tried: ["user_ann"] };
    const first = await s.escalation("user_ann", picked);
    expect((await call(router.questions.list, { status: "pending" }, { context: ann })).map((q) => q.id)).toEqual([first]);
    await call(router.questions.answer, { questionId: first, answer: { kind: "choice", answers: { "Which region?": "EU" } } }, { context: ann });
    expect(await s.row(first)).toMatchObject({ status: "answered", answeredBy: { type: "user", userId: "user_ann" } });
    const second = await s.escalation("user_ann", picked);
    const third = await s.escalation("user_ann", picked);
    await s.context.db.delete(agentEscalations).where(eq(agentEscalations.userId, "user_ann"));
    expect(await call(router.questions.list, { status: "pending" }, { context: ann })).toEqual([]);
    expect(await s.row(second)).toMatchObject({ status: "pending", addresseeId: s.context.ownerId, route: { hop: 2, reason: "creator", tried: ["user_ann", s.context.ownerId] } });
    await expect(call(router.questions.answer, { questionId: third, answer: { kind: "choice", answers: { "Which region?": "EU" } } }, { context: ann })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("answering checks in the answer's own transaction: someone the escalation moved away from can't answer it", async () => {
    const s = await setup();
    await s.setAgent({ ownerId: "user_bob" });
    // Moved to Bob after the owner read it: the owner's answer, recorded now, is refused and changes nothing.
    const id = await s.escalation("user_bob", { hop: 2, reason: "noFit", tried: ["user_bob"] });
    await expect(s.context.engine.answer(id, { kind: "choice", answers: { "Which region?": "EU" } }, { type: "user", userId: s.context.ownerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await s.row(id)).toMatchObject({ status: "pending", addresseeId: "user_bob" });
  });

  test("notifying and each retry: a removed addressee's escalation moves to the next hop, whose person the next flush reaches", async () => {
    const s = await setup();
    await s.setAgent({ ownerId: "user_bob" });
    const sent: string[] = [];
    const send = vi.fn<Send>(async (subscription) => void sent.push(subscription.endpoint));
    const sender = new PushSender(s.context.db, s.context.engine, s.context.secrets, { subject: "mailto:push@example.com", send, windowMs: 10_000, retryMs: 60_000 });
    onTestFinished(() => sender.stop());
    await call(router.push.subscribe, { endpoint: "https://push.example.com/owner", keys: { p256dh: "p256dh-key", auth: "auth-key" }, language: "en" }, { context: s.context });
    // Bob has a device too: the flush that would reach it checks him first, and moves the question instead.
    await s.context.db.insert(pushSubscriptions).values({ id: "push_bob", ownerId: "user_bob", endpoint: "https://push.example.com/bob", keys: s.context.secrets.seal(JSON.stringify({ p256dh: "k", auth: "a" }), subscriptionKeysAad("https://push.example.com/bob")), label: "Phone", language: "en" });
    const id = await s.escalation("user_bob", { hop: 2, reason: "noFit", tried: ["user_bob"] });
    await s.context.db.delete(workspaceMembers).where(and(eq(workspaceMembers.userId, "user_bob")));
    await sender.flush();
    expect(await s.row(id)).toMatchObject({ status: "pending", addresseeId: s.context.ownerId, ownerId: s.context.ownerId, route: { hop: 3, reason: "orgOwner", tried: ["user_bob", s.context.ownerId] } });
    expect(await s.actions(id)).toContainEqual(["question.rerouted", { from: "user_bob", to: s.context.ownerId, hop: 2, reason: "not_allowed" }]);
    await sender.flush();
    expect(sent).toEqual(["https://push.example.com/owner"]);
    // A retry checks again: with no hop left once the owner's escalation is disabled, it is settled and nothing goes.
    const later = await s.escalation(s.context.ownerId, { hop: 3, reason: "orgOwner", tried: [s.context.ownerId] });
    await s.setAgent({ escalateMode: "disabled" });
    await sender.flush();
    expect(sent).toHaveLength(1);
    expect(await s.row(later)).toMatchObject({ status: "answered" });
  });

  test("a hop with nobody left settles the question answered by nobody's text", async () => {
    const s = await setup();
    // Hop 3, and the owner removed from being it: no hop is left.
    const id = await s.escalation("user_bob", { hop: 3, reason: "orgOwner", tried: ["user_bob"] });
    await s.context.engine.checkEscalation(id, { type: "scheduler" });
    expect(await s.row(id)).toMatchObject({ status: "answered", answer: { answers: { "Which region?": NOBODY_TEXT } } });
  });
});
