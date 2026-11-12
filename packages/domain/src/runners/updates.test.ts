import { call } from "@orpc/server";
import { afterEach, expect, test, vi } from "vitest";
import { runners, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "./test-support.ts";
import { RunnerUpdates } from "./updates.ts";

afterEach(() => vi.useRealTimers());

test("updates are explicit, delivered once, and complete only after the new build reports in", () => {
  const updates = new RunnerUpdates();
  updates.buildId = "new";
  expect(updates.request("r")).toBe(false);
  expect(updates.poll("r", "old", false)).toBe(false);
  expect(updates.status("r")).toBe("available");
  expect(updates.request("r")).toBe(true);
  expect(updates.request("r")).toBe(false);
  expect(updates.poll("r", "old", false)).toBe(true);
  expect(updates.poll("r", "old", false)).toBe(false);
  expect(updates.status("r")).toBe("updating");
  updates.poll("r", "new", false);
  expect(updates.status("r")).toBe("current");
  expect(updates.request("r")).toBe(false);
});

test("failure permits an explicit retry, and stale or undelivered requests never install later", () => {
  vi.useFakeTimers();
  const updates = new RunnerUpdates();
  updates.buildId = "new";
  updates.poll("r", "old", false);
  updates.request("r");
  updates.poll("r", "old", false);
  updates.poll("r", "old", true);
  expect(updates.status("r")).toBe("failed");
  expect(updates.request("r")).toBe(true);
  expect(updates.poll("r", "old", true)).toBe(true);
  expect(updates.status("r")).toBe("updating");
  vi.advanceTimersByTime(180_001);
  expect(updates.status("r")).toBe("failed");
  expect(updates.request("r")).toBe(false);
  updates.poll("r", "old", false);
  updates.request("r");
  vi.advanceTimersByTime(180_001);
  expect(updates.poll("r", "old", false)).toBe(false);
});

test("only the authenticated owner can request an update, even without a session socket", async () => {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  context.hub.updates.buildId = "new";
  context.hub.updates.poll(runnerId, "old", false);
  expect(context.hub.isOnline(runnerId)).toBe(false);
  await call(router.runners.installUpdate, { runnerId }, { context });
  expect(context.hub.updates.status(runnerId)).toBe("updating");
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(runners).values({ id: "runner_other", ownerId: "user_other", name: "Other" });
  context.hub.updates.poll("runner_other", "old", false);
  await expect(call(router.runners.installUpdate, { runnerId: "runner_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.runners.installUpdate, { runnerId }, { context: { ...context, headers: new Headers() } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await call(router.runners.revoke, { runnerId }, { context });
  await expect(call(router.runners.installUpdate, { runnerId }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
