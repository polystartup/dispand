import { createHash } from "node:crypto";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { runners, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { pair, PairingRefused } from "./pairing.ts";
import { ownerContext } from "./test-support.ts";

afterEach(() => {
  vi.useRealTimers();
});

test("pairing code works once", async () => {
  const context = await ownerContext();
  const created = await call(router.runners.create, { name: "Workstation" }, { context });
  expect(created.pairingCode).toMatch(/^[A-Z0-9]{8}$/);
  expect(created.installCommand).toBe(
    `curl -fsSL https://dispand.test/runner/install.sh | DISPAND_PAIRING_CODE=${created.pairingCode} sh -s -- --server https://dispand.test`,
  );

  const paired = await pair(context.db, created.pairingCode);
  expect(paired.runnerId).toBe(created.runnerId);
  expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const [row] = await context.db.select().from(runners).where(eq(runners.id, created.runnerId));
  expect(row?.tokenHash).toBe(createHash("sha256").update(paired.token).digest("hex"));

  await expect(pair(context.db, created.pairingCode)).rejects.toBeInstanceOf(PairingRefused);
});

test("expired code is refused", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const context = await ownerContext();
  const { pairingCode } = await call(router.runners.create, { name: "Workstation" }, { context });
  vi.setSystemTime(Date.now() + 16 * 60 * 1000);
  await expect(pair(context.db, pairingCode)).rejects.toBeInstanceOf(PairingRefused);
});

test("a code typed in lower case or with spaces still pairs", async () => {
  const context = await ownerContext();
  const { runnerId, pairingCode } = await call(router.runners.create, { name: "Workstation" }, { context });
  expect((await pair(context.db, ` ${pairingCode.toLowerCase()}\n`)).runnerId).toBe(runnerId);
});

test("unknown code is refused", async () => {
  const context = await ownerContext();
  await expect(pair(context.db, "AAAAAAAA")).rejects.toBeInstanceOf(PairingRefused);
});

test("a revoked runner's code is refused", async () => {
  const context = await ownerContext();
  const { runnerId, pairingCode } = await call(router.runners.create, { name: "Workstation" }, { context });
  await call(router.runners.revoke, { runnerId }, { context });
  await expect(pair(context.db, pairingCode)).rejects.toBeInstanceOf(PairingRefused);
});

test("list shows the owner's runners only, and revoke hides them", async () => {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(runners).values({ id: "runner_other", ownerId: "user_other", name: "Eve's" });

  expect(await call(router.runners.list, undefined, { context })).toEqual([
    { id: runnerId, name: "Workstation", status: "offline", lastSeenAt: null, tools: [], clis: {} },
  ]);
  await expect(call(router.runners.revoke, { runnerId: "runner_other" }, { context })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await call(router.runners.revoke, { runnerId }, { context });
  expect(await call(router.runners.list, undefined, { context })).toEqual([]);
});

test("update renames the owner's live runner only", async () => {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  await call(router.runners.update, { runnerId, name: " Laptop " }, { context });
  expect(await call(router.runners.list, undefined, { context })).toMatchObject([{ id: runnerId, name: "Laptop" }]);
  await expect(call(router.runners.update, { runnerId, name: " " }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(runners).values({ id: "runner_other", ownerId: "user_other", name: "Eve's" });
  await expect(call(router.runners.update, { runnerId: "runner_other", name: "Mine" }, { context })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const [other] = await context.db.select().from(runners).where(eq(runners.id, "runner_other"));
  expect(other?.name).toBe("Eve's");

  await call(router.runners.revoke, { runnerId }, { context });
  await expect(call(router.runners.update, { runnerId, name: "Again" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("revoke is refused while a harness uses the runner", async () => {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(
    router.harnesses.create,
    { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" },
    { context },
  );
  await expect(call(router.runners.revoke, { runnerId }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await call(router.runners.list, undefined, { context })).toHaveLength(1);
  await call(router.harnesses.delete, { id: harness.id }, { context });
  await call(router.runners.revoke, { runnerId }, { context });
  expect(await call(router.runners.list, undefined, { context })).toEqual([]);
});

test("runners procedures require the owner's session", async () => {
  const context = { ...(await ownerContext()), headers: new Headers() };
  for (const procedure of [
    call(router.runners.create, { name: "x" }, { context }),
    call(router.runners.list, undefined, { context }),
    call(router.runners.update, { runnerId: "runner_x", name: "x" }, { context }),
    call(router.runners.revoke, { runnerId: "runner_x" }, { context }),
  ]) {
    await expect(procedure).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
});
