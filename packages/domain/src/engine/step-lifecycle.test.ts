import { call } from "@orpc/server";
import type { HarnessEvent } from "@dispand/runner-protocol";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { audit, messages, runs, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { endStep, reopen, replaceSession, transcriptGone } from "./step-lifecycle.ts";
import type { Out, StepRow } from "./views.ts";

class FakeAdapter implements HarnessAdapter {
  starts: StartParams[] = [];
  async start(_harness: Harness, start: StartParams) {
    this.starts.push(start);
    return true;
  }
  send = async () => true;
  answer = async () => true;
  stop = async () => true;
}

/** A Job chat whose first session reported transcript `history`, answered once, then got the owner's "Next". */
async function chat() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Helper", description: "", harnessId: harness.id, systemPrompt: "" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const first = adapter.starts[0]!.sessionId;
  let seq = 0;
  const emit = (event: HarnessEvent) => engine.onHarnessEvent(first, event, { runnerId, seq: ++seq });
  await emit({ type: "cli-session", cliSessionId: "history" });
  await emit({ type: "text", delta: "Earlier answer" });
  await emit({ type: "turn-end" });
  await engine.sendChat(runId, "Next");
  const step = async () => (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)))[0]!;
  /** One transition in a transaction of its own, with the events it left. */
  const within = async <T>(work: (tx: Parameters<Parameters<typeof context.db.transaction>[0]>[0], out: Out[], now: StepRow) => Promise<T>) => {
    const out: Out[] = [];
    const now = await step();
    return { result: await context.db.transaction((tx) => work(tx, out, now)), out };
  };
  return { context, runId, first, emit, step, within };
}

test("a step ends once: its turn is over, and a second end changes nothing", async () => {
  const { step, within } = await chat();
  const { result, out } = await within((tx, out, now) => endStep(tx, now, { status: "failed", error: "Disconnected" }, out));
  expect(result).toMatchObject({ status: "failed", error: "Disconnected", turnStatus: "idle", turnId: null, interruptible: false, codexInputId: null, finishedAt: expect.any(Date) });
  expect(out).toEqual([{ type: "step", step: expect.objectContaining({ status: "failed" }) }]);
  const again = await within((tx, out, now) => endStep(tx, now, { status: "succeeded", outputs: { result: "late" } }, out));
  expect(again).toEqual({ result: undefined, out: [] });
  expect(await step()).toMatchObject({ status: "failed", outputs: null });
});

test("a replaced session starts from nothing and resumes the transcript once the former one has ended", async () => {
  const { first, step, within } = await chat();
  const before = await step();
  const { result } = await within((tx) => replaceSession(tx, before as StepRow & { sessionId: string; start: StartParams }));
  expect(result.sessionId).not.toBe(first);
  expect(result).toMatchObject({
    status: before.status, cliSessionId: "history", start: { sessionId: result.sessionId, prompt: before.start!.prompt },
    pendingAction: { kind: "resume" }, resumeAfterSession: { sessionId: first, ended: false },
    turnStatus: "unknown", turnId: null, startDeliveredAt: null, lastActivityAt: null, eventSeq: 0, working: false, queuedAt: null,
  });
});

test("an ended chat the owner continues resumes its transcript in a new session, with the Job's Audit row", async () => {
  const { context, runId, first, emit, within } = await chat();
  await emit({ type: "error", message: "Disconnected" });
  const { result, out } = await within((tx, out, now) => reopen(tx, now, out, { continueChat: true }));
  expect(result).toMatchObject({ status: "running", error: null, finishedAt: null, start: { resumeCliSessionId: "history" }, pendingAction: { kind: "resume" }, resumeAfterSession: { sessionId: first, ended: false } });
  expect((await context.db.select().from(runs).where(eq(runs.id, runId)))[0]).toMatchObject({ status: "running", error: null, finishedAt: null });
  expect(out.map((e) => e.type)).toEqual(["run", "step"]);
  expect((await context.db.select().from(audit).where(eq(audit.jobId, runId))).map((row) => row.action)).toContain("job.reopened");
});

test("a chat whose transcript is gone continues in a fresh session, its unanswered messages to send again", async () => {
  const { context, runId, emit, within } = await chat();
  await emit({ type: "error", message: "Disconnected" });
  // Its resume was refused: the harness said the transcript can't be taken.
  const resumed = await within((tx, out, now) => reopen(tx, now, out, { continueChat: true }));
  await within(async (tx, out) => {
    await transcriptGone(tx, resumed.result);
    return endStep(tx, resumed.result, { status: "failed", error: "No transcript" }, out);
  });
  await context.db.update(runs).set({ status: "failed" }).where(eq(runs.id, runId));
  await context.db.update(messages).set({ deliveredAt: new Date() }).where(eq(messages.runId, runId));
  const { result } = await within((tx, out, now) => reopen(tx, now, out, { continueChat: true }));
  expect(result).toMatchObject({ status: "pending", sessionId: null, start: null, cliSessionId: null, pendingAction: null, resumeAfterSession: null });
  const rows = await context.db.select().from(messages).where(eq(messages.runId, runId));
  expect(rows.filter((m) => m.role === "user").map((m) => [m.text, m.deliveredAt])).toEqual([["Next", null]]);
});

test("a chat that isn't where its run ended stays closed, as does a failed one nobody asked to continue", async () => {
  const { context, runId, emit, within } = await chat();
  await expect(within((tx, out, now) => reopen(tx, now, out, { continueChat: true }))).rejects.toMatchObject({ code: "CLOSED" });
  await emit({ type: "error", message: "Disconnected" });
  await expect(within((tx, out, now) => reopen(tx, now, out, { continueChat: false }))).rejects.toMatchObject({ code: "CLOSED" });
  await context.db.update(runs).set({ status: "succeeded" }).where(eq(runs.id, runId));
  await expect(within((tx, out, now) => reopen(tx, now, out, { continueChat: true }))).rejects.toMatchObject({ code: "CLOSED" });
});
