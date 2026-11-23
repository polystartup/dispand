import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { consultProblem } from "../engine/consults.ts";
import { ownerContext, personContext } from "../runners/test-support.ts";
import { router } from "./router.ts";

test("levels › no Job consults an Assistant, another person's or its own person's", async () => {
  const owner = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context: owner });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const theirs = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  const own = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: pat });
  const agent = await call(router.agents.create, { name: "Builder", harnessId: harness.id, systemPrompt: "", bundles: ["configure"], consultMode: "auto" }, { context: pat });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: pat });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: pat });
  expect(await consultProblem(owner.db, runId, theirs.agentId)).not.toBeNull();
  expect(await consultProblem(owner.db, runId, own.agentId)).not.toBeNull();
});
