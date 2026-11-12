import { call } from "@orpc/server";
import { expect, onTestFinished, test, vi } from "vitest";
import { runs } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";

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

class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  stops: string[] = [];
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    return true;
  }
  async send() {
    return true;
  }
  async answer() {
    return true;
  }
  async stop(sessionId: string) {
    this.stops.push(sessionId);
    return true;
  }
}

test("a Job stopped while its memory is read never starts", async () => {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
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
