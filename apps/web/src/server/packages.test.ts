import { createRunner, pair } from "@dispand/domain";
import { ownerContext } from "@dispand/domain/test-support";
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
