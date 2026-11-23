import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { ownerContext, personContext } from "../runners/test-support.ts";
import { tools } from "../db/schema.ts";
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

test("levels › a member lists the workspace's runners, whoever registered them, and can't register, rename, revoke or update one, or install on it", async () => {
  const owner = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context: owner });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.runners.list, undefined, { context: pat })).map((r) => r.id)).toEqual([runnerId]);
  await expect(call(router.runners.create, { name: "Mine" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.update, { runnerId, name: "Renamed" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.revoke, { runnerId }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.installUpdate, { runnerId }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.plugins, { runnerId, operation: { action: "list" } }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.runners.workspacePlugin, { harnessIds: [harness.id], resource: { kind: "skill", id: "x" }, action: "add", dryRun: true }, { context: pat })).rejects.toMatchObject(forbidden);
});

test("levels › a manager renames and revokes a runner another person registered, and can't install any plugin on it", async () => {
  const owner = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context: owner });
  const mia = await personContext(owner, "mia", "manager");
  // Plugins from any source run under the account of whoever installed the runner: only they install those.
  await expect(call(router.runners.plugins, { runnerId, operation: { action: "list" } }, { context: mia })).rejects.toMatchObject(forbidden);
  await call(router.runners.update, { runnerId, name: "Renamed" }, { context: mia });
  await call(router.runners.revoke, { runnerId }, { context: mia });
  expect(await call(router.runners.list, undefined, { context: owner })).toEqual([]);
});

test("levels › a member reads the workspace's tools and connects one by OAuth, and can't add, change or delete one", async () => {
  const owner = await ownerContext();
  await owner.db.insert(tools).values({ id: "tool_mail", ownerId: owner.ownerId, workspaceId: owner.workspaceId, name: "Mail", kind: "http", url: "https://mail.example.com/mcp", transport: "streamable-http" });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.tools.list, undefined, { context: pat })).map((t) => t.id)).toEqual(["tool_mail"]);
  await expect(call(router.tools.get, { id: "tool_mail" }, { context: pat })).resolves.toMatchObject({ id: "tool_mail" });
  const http = { name: "Other", url: "https://other.example.com/mcp", transport: "streamable-http" as const, headers: {} };
  await expect(call(router.tools.create, http, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.add, { name: "Other", url: http.url, transport: http.transport }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.update, { id: "tool_mail", url: "https://elsewhere.example.com/mcp" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.fillSettings, { id: "tool_mail", settings: {} }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.addFromCatalog, { catalogId: "x" }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.installFromCatalog, { catalogId: "x", settings: {} }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.tools.delete, { id: "tool_mail" }, { context: pat })).rejects.toMatchObject(forbidden);
});
