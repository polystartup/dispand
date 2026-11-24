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

test("the install's files limit is 10 GiB until set, set by the owner from 1 MiB to 1 TiB, and the owner's own", async () => {
  const context = await ownerContext();
  expect(await call(router.workspace.filesLimit, undefined, { context })).toEqual({ mib: 10_240 });
  expect(await call(router.workspace.setFilesLimit, { mib: 500 }, { context })).toEqual({ mib: 500 });
  expect(await call(router.workspace.filesLimit, undefined, { context })).toEqual({ mib: 500 });
  for (const mib of [0, 1_048_577, 1.5]) await expect(call(router.workspace.setFilesLimit, { mib }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const signedOut = { ...context, headers: new Headers() };
  await expect(call(router.workspace.setFilesLimit, { mib: 5 }, { context: signedOut })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
