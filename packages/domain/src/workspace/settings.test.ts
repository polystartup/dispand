import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { roots, runs, workspaceSettings } from "../db/schema.ts";
import { Engine } from "../engine/engine.ts";
import type { HarnessAdapter } from "../engine/harness.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, ownerContext, secondWorkspace } from "../runners/test-support.ts";

const adapter: HarnessAdapter = { start: async () => true, send: async () => true, answer: async () => true, stop: async () => true };

test("a Job reads its run's workspace settings, not its starter's other workspace", async () => {
  const context = await ownerContext();
  const { db, ownerId, workspaceId: a } = context;
  const made = async (where: typeof context) => {
    const { runnerId } = await runnerWithClis(where);
    const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: where });
    const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context: where });
    const trigger = await call(router.triggers.create, { name: "Start", agentId: agent.id, instructions: "Go.", config: { kind: "manual", placement: "button" } }, { context: where });
    return { agentId: agent.id, triggerId: trigger.id };
  };
  const inA = await made(context);
  // The same person in a second workspace, whose checkpoint would pause the first Job.
  const inB = await made((await secondWorkspace(context, "ws-b")).b);
  await db.insert(workspaceSettings).values([{ workspaceId: a, checkpoint: 100 }, { workspaceId: "ws-b", checkpoint: 1 }]);
  const engine = new Engine(db, adapter);
  onTestFinished(() => engine.stop());
  const start = ({ agentId, triggerId }: typeof inA) => db.transaction((tx) => engine.createJob(tx, { ownerId, agentId, triggerId, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } }));
  const rootOf = async (runId: string) => (await db.select({ state: roots.state }).from(runs).innerJoin(roots, eq(roots.id, runs.rootId)).where(eq(runs.id, runId)))[0]!.state;

  expect(await rootOf(await start(inA))).toBe("going");
  // An agent of B: its Job counts against B's checkpoint.
  expect(await rootOf(await start(inB))).toBe("paused");
});
