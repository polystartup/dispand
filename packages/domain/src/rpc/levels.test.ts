import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { ownerContext, personContext } from "../runners/test-support.ts";
import { router } from "./router.ts";

const forbidden = { code: "FORBIDDEN" };

test("levels › a member reads the workspace's harnesses, whoever made them, and can't create, change or delete one or set its limit", async () => {
  const owner = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context: owner });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.harnesses.list, undefined, { context: pat })).map((h) => h.id)).toEqual([harness.id]);
  await expect(call(router.harnesses.get, { id: harness.id }, { context: pat })).resolves.toMatchObject({ id: harness.id });
  expect((await call(router.harnesses.limits, undefined, { context: pat })).map((h) => h.id)).toEqual([harness.id]);
  await expect(call(router.harnesses.create, { name: "Mine", runnerId, kind: "codex", permissionMode: "default" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.harnesses.update, { id: harness.id, name: "Renamed", runnerId, kind: "claude-code", permissionMode: "default" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.harnesses.setLimit, { id: harness.id, maxWorking: 5 }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.harnesses.delete, { id: harness.id }, { context: pat })).rejects.toMatchObject(forbidden);
});

test("levels › a manager changes a harness another person made", async () => {
  const owner = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context: owner });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const mia = await personContext(owner, "mia", "manager");
  await expect(call(router.harnesses.setLimit, { id: harness.id, maxWorking: 5 }, { context: mia })).resolves.toMatchObject({ maxWorking: 5 });
  await expect(call(router.harnesses.update, { id: harness.id, name: "Renamed", runnerId, kind: "claude-code", permissionMode: "default" }, { context: mia })).resolves.toMatchObject({ name: "Renamed" });
});
