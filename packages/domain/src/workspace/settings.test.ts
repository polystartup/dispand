import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { agents, roots, runs, workspaces, workspaceSettings } from "../db/schema.ts";
import { Engine } from "../engine/engine.ts";
import type { HarnessAdapter } from "../engine/harness.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

const adapter: HarnessAdapter = { start: async () => true, send: async () => true, answer: async () => true, stop: async () => true };

test("a Job reads its run's workspace settings, not its starter's other workspace", async () => {
  const context = await ownerContext();
  const { db, ownerId, organizationId, workspaceId: a } = context;
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context });
  const trigger = await call(router.triggers.create, { name: "Start", agentId: agent.id, instructions: "Go.", config: { kind: "manual", placement: "button" } }, { context });
  // The same person in a second workspace, whose checkpoint would pause the first Job.
  await db.insert(workspaces).values({ id: "ws-b", organizationId });
  await db.insert(workspaceSettings).values([{ workspaceId: a, checkpoint: 100 }, { workspaceId: "ws-b", checkpoint: 1 }]);
  const engine = new Engine(db, adapter);
  onTestFinished(() => engine.stop());
  const start = () => db.transaction((tx) => engine.createJob(tx, { ownerId, agentId: agent.id, triggerId: trigger.id, cause: { kind: "user", depth: 0 }, firing: { type: "manual" } }));
  const rootOf = async (runId: string) => (await db.select({ state: roots.state }).from(runs).innerJoin(roots, eq(roots.id, runs.rootId)).where(eq(runs.id, runId)))[0]!.state;

  expect(await rootOf(await start())).toBe("going");
  // Moved to B, its next Job counts against B's checkpoint.
  await db.update(agents).set({ workspaceId: "ws-b" }).where(eq(agents.id, agent.id));
  expect(await rootOf(await start())).toBe("paused");
});
