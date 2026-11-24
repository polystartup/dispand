import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { questions, runs, stepRuns, workspaces } from "../db/schema.ts";
import { inScope, setTenancy, shared, SYSTEM, type Tenancy } from "../db/scope.ts";
import type { QuestionPayload } from "@dispand/runner-protocol";
import { router } from "../rpc/router.ts";
import { runnerWithClis, ownerContext, recordScopes } from "../runners/test-support.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import { createEngine } from "./cli-harness.ts";
import { Engine } from "./engine.ts";
import { RunnerHub } from "../runners/hub.ts";
import { Scheduler } from "./scheduler.ts";

// Stored work of a run that another actor drains (another workspace's runner reconciling, a
// scheduler tick, the boot) must run in that run's scope, never in the drainer's. Each test below
// drains one kind from inside another workspace's scope (`ws_elsewhere`), with the run's ids
// registered to their real workspace. Under plain inheritance (`shared`), the recorder flags the
// drained work (a negative control: the test can tell); with a tenancy whose `forRun` re-scopes, it passes.

class FakeAdapter implements HarnessAdapter {
  sessions: string[] = [];
  async start(_harness: Harness, start: StartParams) {
    this.sessions.push(start.sessionId);
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

/** `forRun` as a database adapter would do it: the run's workspace, read under SYSTEM. */
const rescoping: Tenancy = {
  each: shared.each,
  async forRun(db, runId, work) {
    const [run] = await inScope(SYSTEM, () => db.select({ organizationId: workspaces.organizationId, workspaceId: workspaces.id }).from(runs)
      .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId)).where(eq(runs.id, runId)));
    return inScope(run!, work);
  },
};

const payload: QuestionPayload = { kind: "choice", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] };

/** A one-step run whose session asked a question, made on the plain database; then an engine on the recorded one. */
async function drained(tenancy: Tenancy) {
  const base = await ownerContext();
  const { runnerId } = await runnerWithClis(base);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: base });
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context: base });
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context: base });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId: agent.id, prompt: "Write." }],
    edges: [{ from: "n_go", to: "n_note" }],
  } }, { context: base });
  const adapter = new FakeAdapter();
  const setup = new Engine(base.db, adapter);
  onTestFinished(() => setup.stop());
  const runId = await setup.startRun(workflow.id);
  await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
  const sessionId = adapter.sessions[0]!;
  await setup.onHarnessEvent(sessionId, { type: "question", questionId: "rq_1", payload }, { runnerId, seq: 1 });
  const [step] = await base.db.select().from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
  const [question] = await base.db.select().from(questions).where(eq(questions.runId, runId));

  const recorder = await recordScopes(base.db);
  setTenancy(recorder.db, tenancy);
  for (const id of [runId, step!.id, sessionId, question!.id]) recorder.register(id, base.workspaceId);
  const engine = new Engine(recorder.db, adapter);
  onTestFinished(() => engine.stop());
  // As the app wires it: its cloud sessions' events and turn claims go to the engine.
  const wired = createEngine(recorder.db, new RunnerHub(recorder.db), base.secrets, base.dataEvents);
  onTestFinished(() => wired.stop());
  const elsewhere = <T>(work: () => Promise<T>) => inScope({ workspaceId: "ws_elsewhere" }, work);
  /** Drains `work` from elsewhere, waits for what it left running, and checks the recorded scopes. */
  const check = async (work: () => Promise<unknown>) => {
    await elsewhere(work).catch(() => undefined);
    await engine.stop();
    await wired.stop();
    recorder.expectNoCrossScope();
  };
  return { base, db: recorder.db as Db, engine, wired, runId, stepId: step!.id, sessionId, question: question!, check };
}

const internals = (engine: Engine) => engine as unknown as {
  publish(out: unknown[]): void;
  holdingDeliveries<T>(work: () => Promise<T>): Promise<T>;
  deliverAnswer(q: unknown): void;
  checkpointed: Map<string, number>;
};

const cloudOf = (engine: Engine) => (engine as unknown as { cloud: { handler(sessionId: string, event: unknown, seq: number): Promise<void>; claimTurn(sessionId: string): Promise<boolean> } }).cloud;

const continuations: [string, (s: Awaited<ReturnType<typeof drained>>) => Promise<unknown>][] = [
  ["a slot handed over by another run's step", async ({ engine, runId, stepId }) => internals(engine).publish([{ type: "slot", runId, stepId }])],
  ["a consulted Job continued from another run", async ({ engine, runId }) => internals(engine).publish([{ type: "job", runId }])],
  ["an answer deferred by another runner's reconcile", async ({ engine, question }) =>
    internals(engine).holdingDeliveries(async () => internals(engine).deliverAnswer({ ...question, status: "answered", answer: { kind: "choice", answers: { "Which?": "A" } } }))],
  ["a checkpoint announced from another workspace", async ({ engine, question }) => {
    // With one asked in a transaction that rolled back: it is skipped, not resolved.
    internals(engine).checkpointed.set("q_rolled_back", Date.now());
    internals(engine).checkpointed.set(question.id, Date.now());
    await engine.announceCheckpoints();
  }],
  ["a stalled run a scheduler tick goes on with", async ({ db, engine, runId }) => {
    const scheduler = new Scheduler(db, engine);
    (scheduler as unknown as { stalled: Set<string> }).stalled.add(runId);
    await scheduler.tick();
  }],
  ["the runs recover goes on with", async ({ engine }) => engine.recover()],
  ["a cloud session's event, whoever woke the session", async ({ wired, sessionId }) => cloudOf(wired).handler(sessionId, { type: "text", delta: "Hi" }, 1)],
  ["a cloud session's turn claim, whoever woke the session", async ({ wired, sessionId }) => cloudOf(wired).claimTurn(sessionId)],
];

for (const [name, drain] of continuations) {
  test(`${name} runs in its run's scope; plain inheritance is flagged`, async () => {
    const inherited = await drained(shared);
    await expect(inherited.check(() => drain(inherited))).rejects.toThrow(/in workspace ws_elsewhere touches/);
    const rescoped = await drained(rescoping);
    await rescoped.check(() => drain(rescoped));
  });
}
