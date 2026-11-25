import { createRunner, inScope, pair, SYSTEM } from "@dispand/domain";
import { ownerContext, recordScopes } from "@dispand/domain/test-support";
import { expect, test } from "vitest";
import { handleNativePlugin, handlePlugin } from "./plugins.ts";

const get = (id: string, token?: string) => new Request(`http://localhost/runner/plugins/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("a runner's plugin request needs its token, and any tool that isn't a plugin server on that runner is 404", async () => {
  const { db, ownerId, organizationId, workspaceId } = await ownerContext();
  const { pairingCode } = await createRunner(db, ownerId, "Workstation", { organizationId, workspaceId });
  const { token } = await pair(db, pairingCode);
  expect((await handlePlugin(get("tool_x"), db, "tool_x")).status).toBe(401);
  expect((await handlePlugin(get("tool_x", "nope"), db, "tool_x")).status).toBe(401);
  expect((await handlePlugin(get("tool_x", token), db, "tool_x")).status).toBe(404);
});

test("a runner's plugin request runs in the runner's scope on the guarded db, whatever scope it comes in", async () => {
  const { db, ownerId, organizationId, workspaceId } = await ownerContext();
  const { pairingCode } = await createRunner(db, ownerId, "Workstation", { organizationId, workspaceId });
  const { token } = await pair(db, pairingCode);
  const recorder = await recordScopes(db);
  expect((await inScope({ workspaceId: "ws_other" }, () => handlePlugin(get("tool_x", token), recorder.db, "tool_x"))).status).toBe(404);
  expect(recorder.statements[0]!.scope).toBe(SYSTEM);
  expect(recorder.statements.length).toBeGreaterThan(1);
  for (const { scope } of recorder.statements.slice(1)) expect(scope).toEqual({ organizationId, workspaceId });
});

test("a runner's native plugin request needs its token and a well-formed digest; a plugin it isn't granted is 404", async () => {
  const { db, ownerId, organizationId, workspaceId } = await ownerContext();
  const { pairingCode } = await createRunner(db, ownerId, "Workstation", { organizationId, workspaceId });
  const { token } = await pair(db, pairingCode);
  const digest = `sha256:${"a".repeat(64)}`;
  const native = (id: string, query: string, bearer?: string) => new Request(`http://localhost/runner/native-plugins/${id}?${query}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  expect((await handleNativePlugin(native("plugin_x", `digest=${digest}`), db, "plugin_x")).status).toBe(401);
  expect((await handleNativePlugin(native("plugin_x", `digest=${digest}`, token), db, "plugin_x")).status).toBe(404);
  expect((await handleNativePlugin(native("plugin_x", "digest=nope", token), db, "plugin_x")).status).toBe(404);
  expect((await handleNativePlugin(native("../x", `digest=${digest}`, token), db, "../x")).status).toBe(404);
});
