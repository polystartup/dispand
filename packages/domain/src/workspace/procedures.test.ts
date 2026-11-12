import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

test("the checkpoint is 100 until set, set by the owner within its bounds, and the owner's own", async () => {
  const context = await ownerContext();
  expect(await call(router.workspace.checkpoint, undefined, { context })).toEqual({ checkpoint: 100 });
  expect(await call(router.workspace.setCheckpoint, { checkpoint: 250 }, { context })).toEqual({ checkpoint: 250 });
  expect(await call(router.workspace.checkpoint, undefined, { context })).toEqual({ checkpoint: 250 });
  await call(router.workspace.setCheckpoint, { checkpoint: 30 }, { context });
  expect(await call(router.workspace.checkpoint, undefined, { context })).toEqual({ checkpoint: 30 });
  await expect(call(router.workspace.setCheckpoint, { checkpoint: 0 }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.workspace.setCheckpoint, { checkpoint: 1.5 }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const signedOut = { ...context, headers: new Headers() };
  await expect(call(router.workspace.checkpoint, undefined, { context: signedOut })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(call(router.workspace.setCheckpoint, { checkpoint: 5 }, { context: signedOut })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("Audit retention is 90 days until set, set by the owner from 1 to 3650 days, and the owner's own", async () => {
  const context = await ownerContext();
  expect(await call(router.workspace.auditRetention, undefined, { context })).toEqual({ days: 90 });
  expect(await call(router.workspace.setAuditRetention, { days: 1 }, { context })).toEqual({ days: 1 });
  expect(await call(router.workspace.setAuditRetention, { days: 3650 }, { context })).toEqual({ days: 3650 });
  expect(await call(router.workspace.auditRetention, undefined, { context })).toEqual({ days: 3650 });
  for (const days of [0, 3651, 1.5]) await expect(call(router.workspace.setAuditRetention, { days }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // Setting one leaves the other as it was.
  await call(router.workspace.setCheckpoint, { checkpoint: 30 }, { context });
  await call(router.workspace.setAuditRetention, { days: 30 }, { context });
  expect(await call(router.workspace.checkpoint, undefined, { context })).toEqual({ checkpoint: 30 });
  const signedOut = { ...context, headers: new Headers() };
  await expect(call(router.workspace.auditRetention, undefined, { context: signedOut })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(call(router.workspace.setAuditRetention, { days: 5 }, { context: signedOut })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
