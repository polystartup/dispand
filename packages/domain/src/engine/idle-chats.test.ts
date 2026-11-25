import type { HarnessEvent } from "@dispand/runner-protocol";
import { call } from "@orpc/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { audit, chatQueue, questions, runs, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, ownerContext } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import type { HarnessAdapter } from "./harness.ts";

async function chat(workflowPrompt?: string) {
  const context = await ownerContext();
  const { db, ownerId } = context;
  const { runnerId } = await runnerWithClis(context, "Runner");
  const harness = await call(router.harnesses.create, { name: "Codex", runnerId, kind: "codex", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Assistant", harnessId: harness.id, systemPrompt: "" }, { context });
  const adapter = {
    start: vi.fn<HarnessAdapter["start"]>().mockResolvedValue(true),
    send: vi.fn<HarnessAdapter["send"]>().mockResolvedValue(true),
    answer: vi.fn<HarnessAdapter["answer"]>().mockResolvedValue(true),
    stop: vi.fn<HarnessAdapter["stop"]>().mockResolvedValue(true),
  };
  const engine = new Engine(db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  let runId: string;
  if (workflowPrompt) {
    const workflow = await call(router.workflows.create, { name: "Draft" }, { context });
    await call(router.workflows.update, { id: workflow.id, name: "Draft", def: {
      trigger: { type: "manual", field: { type: "chat", id: "chat", key: "brief", label: "Brief", agentId: agent.id, prompt: "Gather the brief." } },
      steps: [{ type: "agent", id: "next", key: "draft", name: "Draft", agentId: agent.id, prompt: workflowPrompt }],
      edges: [{ from: "chat", to: "next" }],
    } }, { context });
    runId = await engine.startRun(workflow.id);
  } else {
    const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
    runId = await engine.startJob(trigger.id, ownerId);
  }
  const step = async () => (await db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), isNotNull(stepRuns.sessionId))))[0]!;
  await vi.waitFor(async () => expect((await step()).startDeliveredAt).toBeTruthy());
  const { id: stepId, sessionId } = await step();
  let seq = 0;
  const emit = (event: HarnessEvent) => engine.onHarnessEvent(sessionId!, event, { runnerId, seq: ++seq });
  await emit({ type: "cli-session", cliSessionId: "history" });
  await emit({ type: "turn-start", turnId: "first", interruptible: true });
  await emit({ type: "text", delta: "Hello." });
  await emit({ type: "turn-end", turnId: "first" });
  const age = async (minutes: number) => {
    const idleSince = new Date(Date.now() - minutes * 60_000);
    await db.update(stepRuns).set({ idleSince }).where(eq(stepRuns.id, stepId));
    return idleSince;
  };
  const run = async () => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;
  return { db, ownerId, adapter, engine, runId, stepId, sessionId: sessionId!, runnerId, step, emit, age, run };
}

test("a half-hour idle chat succeeds once, releases its runner, and resumes the same conversation", async () => {
  const c = await chat();
  expect((await c.step()).idleSince).toBeInstanceOf(Date);
  await c.age(29);
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("running");
  await c.age(31);
  await c.engine.settleIdleChats();
  await c.engine.settleIdleChats();
  expect(await c.run()).toMatchObject({ status: "succeeded", error: null });
  expect(c.adapter.stop).toHaveBeenCalledWith(c.sessionId, c.runnerId);
  expect(await c.db.select().from(audit).where(and(eq(audit.jobId, c.runId), eq(audit.action, "job.finished")))).toHaveLength(1);
  await c.engine.sendChat(c.runId, "Continue.");
  await c.emit({ type: "session-ended" });
  await vi.waitFor(() => expect(c.adapter.start).toHaveBeenCalledTimes(2));
  expect(c.adapter.start.mock.calls[1]![1]).toMatchObject({ resumeCliSessionId: "history", prompt: expect.stringContaining("Continue.") });
  expect((await c.run()).status).toBe("running");
});

test("a new input cancels the old deadline and its reply starts a fresh half hour", async () => {
  const c = await chat();
  const original = await c.age(31);
  await c.engine.sendChat(c.runId, "New input.");
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("running");
  await c.emit({ type: "turn-start", turnId: "next", interruptible: true });
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("running");
  await c.emit({ type: "text", delta: "New reply." });
  await c.emit({ type: "turn-end", turnId: "next" });
  expect((await c.step()).idleSince!.getTime()).toBeGreaterThan(original.getTime());
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("running");
  // The harness can start queued input directly after a steer misses the previous turn.
  await c.age(31);
  await c.emit({ type: "turn-start", turnId: "steered", interruptible: true });
  await c.emit({ type: "turn-end", turnId: "steered" });
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("running");
});

test("an idle chat stays open while a question or queued message awaits delivery", async () => {
  const c = await chat();
  await c.age(31);
  // Checkpoint approvals may belong to the run without a step or session.
  await c.db.insert(questions).values({ id: "q_checkpoint", runId: c.runId, ownerId: c.ownerId, placement: "notifications", kind: "approval", status: "pending", payload: { kind: "confirm-outputs", values: {} } });
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("running");
  await c.db.delete(questions).where(eq(questions.id, "q_checkpoint"));
  await c.db.insert(chatQueue).values({ id: "msg_queued", ownerId: c.ownerId, runId: c.runId, stepRunId: c.stepId, text: "Next." });
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("running");
  await c.db.update(chatQueue).set({ state: "dispatched" }).where(eq(chatQueue.id, "msg_queued"));
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("running");
  await c.db.update(chatQueue).set({ ackedAt: new Date() }).where(eq(chatQueue.id, "msg_queued"));
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("succeeded");
});

test("an idle chat whose question is answered starts its half hour at the answer", async () => {
  const c = await chat();
  await c.emit({ type: "question", questionId: "rq_1", payload: { kind: "confirm-outputs", values: {} } });
  expect(await c.step()).toMatchObject({ status: "waiting", idleSince: null });
  const [asked] = await c.db.select().from(questions).where(eq(questions.stepRunId, c.stepId));
  await c.engine.answer(asked!.id, { kind: "confirm-outputs", confirmed: true }, { type: "user", userId: c.ownerId });
  const { status, idleSince } = await c.step();
  expect(status).toBe("running");
  expect(Math.abs(idleSince!.getTime() - Date.now())).toBeLessThan(60_000);
});

test.each(["Write the draft.", "Write about {{brief.topic}}."])("inactivity never starts a downstream workflow step: %s", async (prompt) => {
  const c = await chat(prompt);
  const start = c.adapter.start.mock.calls[0]![1];
  expect(start.expectedOutputs).toHaveLength(prompt.includes("{{brief.topic}}") ? 1 : 0);
  await c.age(31);
  await c.engine.settleIdleChats();
  expect((await c.run()).status).toBe("running");
  expect((await c.step()).status).toBe("running");
  expect(c.adapter.start).toHaveBeenCalledTimes(1);
  expect(c.adapter.stop).not.toHaveBeenCalled();
});
