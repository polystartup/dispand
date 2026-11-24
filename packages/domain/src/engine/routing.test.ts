import { call } from "@orpc/server";
import type { Answer, HarnessEvent, QuestionPayload } from "@dispand/runner-protocol";
import { and, eq } from "drizzle-orm";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { agentEscalations, agents, audit, organizationMembers, questions, runs, stepRuns, user, workflows, workspaceMembers } from "../db/schema.ts";
import { inScope } from "../db/scope.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext, runnerWithClis } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { JOB_STEP } from "./job-def.ts";
import { firstHop, REFUSED_TEXT } from "./routing.ts";

class FakeAdapter implements HarnessAdapter {
  starts: StartParams[] = [];
  answers: [string, string, Answer][] = [];
  async start(_harness: Harness, start: StartParams) {
    this.starts.push(start);
    return true;
  }
  async send() {
    return true;
  }
  async answer(sessionId: string, questionId: string, answer: Answer) {
    this.answers.push([sessionId, questionId, answer]);
    return true;
  }
  async stop() {
    return true;
  }
}

const choice = (to?: string): QuestionPayload => ({ kind: "choice", questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }], multiSelect: false }], ...(to ? { to } : {}) });

/** An agent made by Bob (a member), which may ask Ann (a member with a profile); Out is in the organization, not the workspace. */
async function setup() {
  const context = await ownerContext();
  const person = async (id: string, name: string, member = true) => {
    await context.db.insert(user).values({ id, name, email: `${id}@example.com`, description: `${name} knows things.` });
    await context.db.insert(organizationMembers).values({ organizationId: context.organizationId, userId: id, role: "member" });
    if (member) await context.db.insert(workspaceMembers).values({ workspaceId: context.workspaceId, userId: id, role: "member" });
  };
  await person("user_ann", "Ann");
  await person("user_bob", "Bob");
  await person("user_out", "Out", false);
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", escalateMode: "whitelist", escalations: [{ userId: "user_ann" }] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Find out.", config: { kind: "manual", placement: "button" } }, { context });
  // Bob made it: the triggers' procedure still finds agents by their creator, so it is handed over after.
  await context.db.update(agents).set({ ownerId: "user_bob" }).where(eq(agents.id, agent.id));
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  let seq = 0;
  let asked = 0;
  const start = async () => {
    const runId = await engine.startJob(trigger.id, context.ownerId);
    const step = await vi.waitFor(async () => {
      const [s] = await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, JOB_STEP)));
      if (!s?.sessionId) throw new Error("not started");
      return s;
    });
    return { runId, sessionId: step.sessionId!, start: adapter.starts.find((x) => x.sessionId === step.sessionId)! };
  };
  /** The session asks `payload`; returns its row. */
  const ask = async (sessionId: string, payload: QuestionPayload) => {
    const questionId = `rq${++asked}`;
    const [step] = await context.db.select({ runnerId: stepRuns.runnerId }).from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
    await engine.onHarnessEvent(sessionId, { type: "question", questionId, payload } as HarnessEvent, { runnerId: step!.runnerId!, seq: ++seq });
    const [row] = await context.db.select().from(questions).where(eq(questions.runnerQuestionId, questionId));
    return row!;
  };
  const set = (values: Partial<typeof agents.$inferInsert>) => context.db.update(agents).set(values).where(eq(agents.id, agent.id));
  return { context, agent, adapter, start, ask, set };
}

describe("routing", () => {
  test("hop 1: the person the Job could ask and may still ask is asked, and to is not stored", async () => {
    const s = await setup();
    const { sessionId, start } = await s.start();
    expect(start.askTargets).toEqual([{ kind: "person", id: "user_ann", name: "Ann", description: "Ann knows things." }]);
    expect(start.escalate).toBe(true);
    const q = await s.ask(sessionId, choice("user_ann"));
    expect(q).toMatchObject({ status: "pending", addresseeId: "user_ann", ownerId: "user_ann", route: { hop: 1, reason: "picked", tried: ["user_ann"] } });
    expect(q.payload).not.toHaveProperty("to");
    const [row] = await s.context.db.select().from(audit).where(and(eq(audit.resourceId, q.id), eq(audit.action, "question.asked")));
    expect(row!.details).toMatchObject({ to: "user_ann", hop: 1, reason: "picked" });
  });

  test("hop 2: a to the Job may not ask goes to the creator as a refused pick; no to goes to them as nobody fitting", async () => {
    const s = await setup();
    const { sessionId } = await s.start();
    expect(await s.ask(sessionId, choice("user_out"))).toMatchObject({ addresseeId: "user_bob", route: { hop: 2, reason: "creator", tried: ["user_bob"] } });
    expect(await s.ask(sessionId, choice())).toMatchObject({ addresseeId: "user_bob", route: { hop: 2, reason: "noFit", tried: ["user_bob"] } });
    // A pick taken off the whitelist since the Job started is no longer allowed now.
    await s.context.db.delete(agentEscalations).where(eq(agentEscalations.userId, "user_ann"));
    expect(await s.ask(sessionId, choice("user_ann"))).toMatchObject({ addresseeId: "user_bob", route: { reason: "creator" } });
  });

  test("hop 3: a creator who left the workspace falls through to the organization owner", async () => {
    const s = await setup();
    await s.context.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "user_bob"));
    const { sessionId } = await s.start();
    expect(await s.ask(sessionId, choice())).toMatchObject({ addresseeId: s.context.ownerId, route: { hop: 3, reason: "orgOwner", tried: [s.context.ownerId] } });
  });

  test("a creator who is the organization owner is asked once", async () => {
    const s = await setup();
    await s.set({ ownerId: s.context.ownerId });
    const { sessionId } = await s.start();
    expect(await s.ask(sessionId, choice())).toMatchObject({ addresseeId: s.context.ownerId, route: { hop: 2, reason: "noFit", tried: [s.context.ownerId] } });
  });

  test("disabled refuses an unattended ask_user and an ask to a person from a Job started before the switch", async () => {
    const s = await setup();
    const { sessionId } = await s.start();
    await s.set({ escalateMode: "disabled" });
    for (const payload of [choice("user_ann"), choice()]) {
      const q = await s.ask(sessionId, payload);
      const [now] = await s.context.db.select().from(questions).where(eq(questions.id, q.id));
      expect(now).toMatchObject({ status: "answered", route: null, answer: { kind: "choice", answers: { "Which region?": REFUSED_TEXT } } });
      const rows = await s.context.db.select().from(audit).where(eq(audit.resourceId, q.id));
      expect(rows.map((r) => [r.action, r.result, r.details])).toEqual([["question.refused", "refused", { reason: "escalation_disabled" }]]);
      await vi.waitFor(() => expect(s.adapter.answers.some(([, id]) => id === q.runnerQuestionId)).toBe(true));
    }
    // A new Job of a disabled agent is offered no person and no escalation.
    const next = await s.start();
    expect(next.start.askTargets).toBeUndefined();
    expect(next.start.escalate).toBeUndefined();
  });

  test("in a chat the person talking is asked whatever the mode and to", async () => {
    const s = await setup();
    await s.set({ escalateMode: "disabled" });
    const { sessionId } = await s.start();
    // The session is a chat: its person is asked.
    const [step] = await s.context.db.select().from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
    await s.context.db.update(stepRuns).set({ start: { ...step!.start!, interactive: true } }).where(eq(stepRuns.id, step!.id));
    expect(await s.ask(sessionId, choice("user_ann"))).toMatchObject({ status: "pending", addresseeId: s.context.ownerId, route: null });
  });

  test("the start says to prefer agents only when the agent prefers them and may ask both", async () => {
    const s = await setup();
    await s.set({ preferAgents: true });
    expect((await s.start()).start.preferAgents).toBeUndefined();
    await s.set({ consultMode: "auto" });
    expect((await s.start()).start.preferAgents).toBe(true);
    // With escalation on and nobody listed, ask is still offered: a question with nobody named reaches a person.
    await s.context.db.delete(agentEscalations);
    const { start } = await s.start();
    expect(start.askTargets ?? []).toEqual([]);
    expect(start.escalate).toBe(true);
  });

  test("a workflow run's unattended question goes to the workflow's creator, then the organization owner", async () => {
    const s = await setup();
    await s.context.db.insert(workflows).values({ id: "wf_1", workspaceId: s.context.workspaceId, ownerId: "user_bob", name: "Ship", currentVersion: 1 });
    await s.context.db.insert(runs).values({ id: "run_wf", workspaceId: s.context.workspaceId, ownerId: "user_bob", workflowId: "wf_1", version: 1, status: "running", trigger: { type: "manual" } });
    const hop = () => inScope({ organizationId: s.context.organizationId, workspaceId: s.context.workspaceId }, () => s.context.db.transaction((tx) => firstHop(tx, "run_wf", "user_ann")));
    expect(await hop()).toEqual({ addresseeId: "user_bob", route: { hop: 2, reason: "workflow", tried: ["user_bob"] } });
    await s.context.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "user_bob"));
    expect(await hop()).toEqual({ addresseeId: s.context.ownerId, route: { hop: 3, reason: "orgOwner", tried: [s.context.ownerId] } });
  });
});
