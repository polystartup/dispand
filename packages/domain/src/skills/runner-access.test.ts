import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { harnesses, runners } from "../db/schema.ts";
import { packageForRunner } from "./runner-access.ts";

test("a package no agent on this runner uses is 404 (null), and so is an unknown one", async () => {
  const context = await ownerContext();
  await context.db.insert(runners).values({ id: "runner_1", ownerId: context.ownerId, name: "workstation" });
  const { packageId } = await call(router.skills.create, { name: "hello-check", description: "Answers HELLO-CHECK.", instructions: "x", requiredToolIds: [] }, { context });
  expect(await packageForRunner(context.db, "runner_1", packageId)).toBeNull();
  expect(await packageForRunner(context.db, "runner_1", "skillpkg_missing")).toBeNull();
  expect(await packageForRunner(context.db, "runner_other", packageId)).toBeNull();
});

test("a package an agent on this runner uses is sent; on another runner it is not", async () => {
  const context = await ownerContext();
  await context.db.insert(runners).values([
    { id: "runner_1", ownerId: context.ownerId, name: "workstation" },
    { id: "runner_2", ownerId: context.ownerId, name: "laptop" },
  ]);
  await context.db.insert(harnesses).values({ id: "harness_1", ownerId: context.ownerId, name: "Claude", runnerId: "runner_1", kind: "claude-code", permissionMode: "default" });
  const { packageId } = await call(router.skills.create, { name: "hello-check", description: "Answers HELLO-CHECK.", instructions: "x", requiredToolIds: [] }, { context });
  await call(router.agents.create, { name: "A", harnessId: "harness_1", systemPrompt: "", skillPackageIds: [packageId] }, { context });
  expect(await packageForRunner(context.db, "runner_1", packageId)).toEqual({
    name: "hello-check",
    nativePlugin: `dispand-${packageId}`,
    nativeKey: expect.stringMatching(/^workspace:[a-f0-9]{64}$/),
    files: [{ path: "hello-check/SKILL.md", base64: expect.any(String) }],
  });
  expect(await packageForRunner(context.db, "runner_2", packageId)).toBeNull();
});
