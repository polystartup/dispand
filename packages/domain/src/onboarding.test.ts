import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { router } from "./rpc/router.ts";
import { ownerContext } from "./runners/test-support.ts";

test("first launch shows until an agent and a manual workflow exist", async () => {
  const context = await ownerContext();
  const status = () => call(router.onboarding.status, undefined, { context });
  expect(await status()).toEqual({ showFirstLaunch: true, hasHarness: false, hasAgent: false, hasManualWorkflow: false });

  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(
    router.harnesses.create,
    { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" },
    { context },
  );
  expect(await status()).toMatchObject({ showFirstLaunch: true, hasHarness: true });

  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context });
  expect(await status()).toEqual({ showFirstLaunch: true, hasHarness: true, hasAgent: true, hasManualWorkflow: false });

  await call(router.workflows.create, { name: "Start xyz" }, { context });
  expect(await status()).toEqual({ showFirstLaunch: false, hasHarness: true, hasAgent: true, hasManualWorkflow: true });
  expect(agent.id).toMatch(/^agent_/);
});

test("a workflow alone does not end first launch", async () => {
  const context = await ownerContext();
  await call(router.workflows.create, { name: "Start xyz" }, { context });
  expect(await call(router.onboarding.status, undefined, { context })).toMatchObject({ showFirstLaunch: true, hasManualWorkflow: true, hasAgent: false });
});
