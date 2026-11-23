import { createRunner, inScope, pair, SYSTEM } from "@dispand/domain";
import { ownerContext, recordScopes } from "@dispand/domain/test-support";
import { expect, test } from "vitest";
import { handlePackage } from "./packages.ts";

async function paired() {
  const { db, ownerId } = await ownerContext();
  const { pairingCode } = await createRunner(db, ownerId, "Workstation");
  const { token } = await pair(db, pairingCode);
  return { db, token };
}

const get = (id: string, token?: string) => new Request(`http://localhost/runner/packages/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("a runner's package request needs its token, and a package no agent on it uses is 404", async () => {
  const { db, token } = await paired();
  expect((await handlePackage(get("skillpkg_x"), db, "skillpkg_x")).status).toBe(401);
  expect((await handlePackage(get("skillpkg_x", "nope"), db, "skillpkg_x")).status).toBe(401);
  expect((await handlePackage(get("skillpkg_x", token), db, "skillpkg_x")).status).toBe(404);
});

test("a runner's package request runs in the runner's scope on the guarded db, whatever scope it comes in", async () => {
  const { db, ownerId, organizationId, workspaceId } = await ownerContext();
  const { pairingCode } = await createRunner(db, ownerId, "Workstation");
  const { token } = await pair(db, pairingCode);
  const recorder = await recordScopes(db);
  expect((await inScope({ workspaceId: "ws_other" }, () => handlePackage(get("skillpkg_x", token), recorder.db, "skillpkg_x"))).status).toBe(404);
  expect(recorder.statements[0]!.scope).toBe(SYSTEM);
  expect(recorder.statements.length).toBeGreaterThan(1);
  for (const { scope } of recorder.statements.slice(1)) expect(scope).toEqual({ organizationId, workspaceId });
});
