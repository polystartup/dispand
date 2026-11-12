import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { router } from "./rpc/router.ts";
import { ownerContext } from "./runners/test-support.ts";

test("first launch: no harness, then a harness, then the Assistant the owner starts on it, with its platform skill", async () => {
  const context = await ownerContext();
  const status = () => call(router.onboarding.status, undefined, { context });
  expect(await status()).toEqual({ assistant: null, hasHarness: false });

  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  // A harness alone makes no Assistant: the owner picks the one it runs on.
  expect(await status()).toEqual({ assistant: null, hasHarness: true });

  // Two requests at once (two tabs): one Assistant.
  const [a, b] = await Promise.all([0, 1].map(() => call(router.agents.ensureAssistant, { harnessId: harness.id }, { context })));
  expect(a!.agentId).toBe(b!.agentId);
  expect(await status()).toEqual({ assistant: { agentId: a!.agentId }, hasHarness: true });
  expect((await call(router.agents.list, undefined, { context })).filter((x) => x.name === "Assistant")).toHaveLength(1);

  // On a fresh install the platform skill appears with the Assistant, without a restart.
  expect((await call(router.skills.list, undefined, { context })).filter((p) => p.builtIn)).toHaveLength(1);
});

test("an agent of the owner's own is not an Assistant", async () => {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  await call(router.agents.create, { name: "Assistant", harnessId: harness.id, systemPrompt: "" }, { context });
  expect(await call(router.onboarding.status, undefined, { context })).toEqual({ assistant: null, hasHarness: true });
});
