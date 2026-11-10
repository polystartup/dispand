import { call } from "@orpc/server";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { runs } from "../db/schema.ts";
import { runView } from "../engine/engine.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { jobOfToken, jobTokenOf } from "./token.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", bundles: ["data"] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
  return { context, agent, runId, run: run! };
}

test("a Job gets a token at creation: only its hash and its sealed form are stored", async () => {
  const { context, run } = await setup();
  const token = jobTokenOf(context.secrets, run)!;
  expect(token).toMatch(/^dj_[A-Za-z0-9_-]{43}$/);
  expect(run.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  // Nothing of the row holds the token in clear, and the run's view has none of it.
  expect(JSON.stringify(run)).not.toContain(token);
  expect(JSON.stringify(runView(run))).not.toMatch(/token/i);
  // Sealed for this run only.
  expect(jobTokenOf(context.secrets, { ...run, id: "run_other" })).toBeNull();
  expect(jobTokenOf(context.secrets, { ...run, tokenSealed: null })).toBeNull();
});

test("a token names its Job while the Job goes on, and nothing after", async () => {
  const { context, agent, runId, run } = await setup();
  const token = jobTokenOf(context.secrets, run)!;
  expect(await jobOfToken(context.db, token)).toEqual({ runId, ownerId: context.ownerId, agentId: agent.id });
  for (const wrong of ["", "dj_", `${token}x`, token.slice(0, -1), "Bearer " + token]) expect(await jobOfToken(context.db, wrong)).toBeNull();
  await context.engine.stopRun(runId);
  expect(await jobOfToken(context.db, token)).toBeNull();
});

test("each Job has its own token, and a workflow run has none", async () => {
  const a = await setup();
  const { runId } = await call(router.jobs.start, { triggerId: (await call(router.triggers.list, { agentId: a.agent.id }, { context: a.context }))[0]!.id }, { context: a.context });
  const [second] = await a.context.db.select().from(runs).where(eq(runs.id, runId));
  expect(second!.tokenHash).not.toBe(a.run.tokenHash);
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context: a.context });
  const started = await call(router.runs.start, { workflowId: workflow.id }, { context: a.context }).catch(() => null);
  const rows = await a.context.db.select().from(runs).where(eq(runs.source, "workflow"));
  expect(rows.every((r) => r.tokenHash === null && r.tokenSealed === null)).toBe(true);
  void started;
});
