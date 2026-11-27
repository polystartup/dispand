import { call } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { runs, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, asCli, ownerContext } from "../runners/test-support.ts";
import { STATE_UNREADABLE } from "./errors.ts";
import { JOB_STEP } from "./job-def.ts";
import { FakeAdapter } from "./test-support.ts";

// The memory read of a start, held until the test lets it go.
const gate = vi.hoisted(() => {
  let open: () => void = () => {};
  const state = { reading: false, released: Promise.resolve() };
  return {
    state,
    hold() {
      state.released = new Promise<void>((resolve) => (open = resolve));
    },
    release: () => open(),
  };
});
vi.mock("../memory/read.ts", async (actual) => {
  const real = await actual<typeof import("../memory/read.ts")>();
  return {
    ...real,
    jobMemoryPrompt: async (...args: Parameters<typeof real.jobMemoryPrompt>) => {
      gate.state.reading = true;
      await gate.state.released;
      return real.jobMemoryPrompt(...args);
    },
  };
});

test("a Job stopped while its memory is read never starts", async () => {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const trigger = await call(
    router.triggers.create,
    { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } },
    { context },
  );
  // A fresh module graph: with modules shared between test files, an engine imported earlier keeps
  // the real memory read, which the mock above doesn't reach.
  vi.resetModules();
  const { Engine } = await import("./engine.ts");
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());

  gate.hold();
  const started = engine.startJob(trigger.id, context.ownerId);
  await vi.waitFor(() => expect(gate.state.reading).toBe(true));
  const [run] = await engine.db.select().from(runs);
  await engine.stopRun(run!.id);
  gate.release();
  await started;
  expect(adapter.starts).toEqual([]);
});

test("a Job whose snapshot no longer parses fails when its start is sent again, and is never sent", async () => {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const trigger = await call(
    router.triggers.create,
    { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } },
    { context },
  );
  vi.resetModules();
  const { Engine } = await import("./engine.ts");
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());

  await engine.startJob(trigger.id, context.ownerId);
  await engine.idle();
  expect(adapter.starts).toHaveLength(1);
  // Its start never confirmed, a reconcile sends it again: by then its snapshot is one no writer makes.
  await engine.db.update(runs).set({ snapshot: sql`jsonb_set(${runs.snapshot}, '{skills}', '"all"')` });
  await engine.reconcile(runnerId, []);
  await engine.idle();
  expect(adapter.starts).toHaveLength(1);
  const [step] = await engine.db.select({ status: stepRuns.status, error: stepRuns.error }).from(stepRuns).where(eq(stepRuns.nodeId, JOB_STEP));
  expect(step).toEqual({ status: "failed", error: STATE_UNREADABLE });
});
