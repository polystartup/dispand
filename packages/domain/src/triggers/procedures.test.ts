import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { agents, harnesses, triggers, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";

const NOW = new Date("2026-11-05T08:00:00Z");

async function setup() {
  const clock = { now: NOW };
  const context = { ...(await ownerContext()), now: () => clock.now };
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(
    await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }),
  );
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  return { context, clock, harness, agent };
}

test("creates a manual chat trigger on the owner's agent", async () => {
  const { context, agent } = await setup();
  const created = await call(
    router.triggers.create,
    { agentId: agent.id, name: " Ask the clerk ", config: { kind: "manual", placement: "chat" } },
    { context },
  );
  expect(created).toEqual({
    id: expect.stringMatching(/^trigger_/),
    agentId: agent.id,
    name: "Ask the clerk",
    kind: "manual",
    enabled: true,
    instructions: "",
    concurrency: "parallel",
    config: { kind: "manual", placement: "chat" },
    lastFires: [],
  });
  expect(await call(router.triggers.get, { id: created.id }, { context })).toEqual(created);
  expect(await call(router.triggers.list, { agentId: agent.id }, { context })).toEqual([created]);
  await call(router.triggers.delete, { id: created.id }, { context });
  expect(await call(router.triggers.list, { agentId: agent.id }, { context })).toEqual([]);
});

test("refuses another owner's agent", async () => {
  const { context, harness, agent } = await setup();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(harnesses).values({
    id: "harness_other",
    ownerId: "user_other",
    name: "Eve's",
    runnerId: harness.runnerId,
    kind: "claude-code",
    permissionMode: "default",
  });
  await context.db.insert(agents).values({ id: "agent_other", ownerId: "user_other", name: "Eve's", harnessId: "harness_other", systemPrompt: "" });
  const config = { kind: "manual", placement: "button" } as const;
  await expect(call(router.triggers.create, { agentId: "agent_other", name: "T", config }, { context })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  // Another owner's trigger can't be read, changed or deleted either.
  await context.db.insert(triggers).values({ id: "trigger_other", ownerId: "user_other", agentId: "agent_other", kind: "manual", name: "T", config });
  await expect(call(router.triggers.get, { id: "trigger_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.triggers.update, { id: "trigger_other", name: "Mine" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.triggers.delete, { id: "trigger_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.triggers.list, { agentId: "agent_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await call(router.triggers.list, { agentId: agent.id }, { context })).toEqual([]);
});

test("refuses a cron the schedule helpers refuse", async () => {
  const { context, agent } = await setup();
  await expect(
    call(router.triggers.create, { agentId: agent.id, name: "T", config: { kind: "schedule", cron: "H 9 * * *", timezone: "Europe/Paris" } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Use numbers, not H" });
  await expect(
    call(router.triggers.create, { agentId: agent.id, name: "T", config: { kind: "schedule", cron: "0 9 * * *", timezone: "Mars/Olympus" } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Unknown timezone" });
});

test("a schedule trigger gets its next fire and keeps it on rename", async () => {
  const { context, clock, agent } = await setup();
  const config = { kind: "schedule", cron: "0 10 * * *", timezone: "Europe/Paris" } as const;
  const created = await call(router.triggers.create, { agentId: agent.id, name: "Morning", config }, { context });
  // 08:00Z is 09:00 in Paris: the next 10:00 is one hour away.
  expect(created.nextFireAt).toEqual(new Date("2026-11-05T09:00:00Z"));

  clock.now = new Date("2026-11-05T08:30:00Z");
  const renamed = await call(router.triggers.update, { id: created.id, name: "Daily" }, { context });
  expect(renamed).toMatchObject({ name: "Daily", nextFireAt: created.nextFireAt, config });
  const [row] = await context.db.select().from(triggers);
  expect(row!.lastCheckedAt).toEqual(NOW);

  const moved = await call(router.triggers.update, { id: created.id, config: { ...config, cron: "0 12 * * *" } }, { context });
  expect(moved.nextFireAt).toEqual(new Date("2026-11-05T11:00:00Z"));
  const [after] = await context.db.select().from(triggers);
  expect(after!.lastCheckedAt).toEqual(clock.now);
});

test("pausing a schedule trigger keeps its times, and enabling it again starts from now", async () => {
  const { context, clock, agent } = await setup();
  const config = { kind: "schedule", cron: "0 10 * * *", timezone: "Europe/Paris" } as const;
  const created = await call(router.triggers.create, { agentId: agent.id, name: "Morning", config }, { context });
  const paused = await call(router.triggers.update, { id: created.id, enabled: false }, { context });
  expect(paused).toMatchObject({ enabled: false, nextFireAt: created.nextFireAt });

  // Two days later: the fires of the pause are not caught up.
  clock.now = new Date("2026-11-07T10:00:00Z");
  const resumed = await call(router.triggers.update, { id: created.id, enabled: true }, { context });
  expect(resumed.nextFireAt).toEqual(new Date("2026-11-08T09:00:00Z"));
  const [row] = await context.db.select().from(triggers);
  expect(row!.lastCheckedAt).toEqual(clock.now);
});

test("a trigger's kind can't change", async () => {
  const { context, agent } = await setup();
  const created = await call(router.triggers.create, { agentId: agent.id, name: "T", config: { kind: "manual", placement: "button" } }, { context });
  await expect(
    call(router.triggers.update, { id: created.id, config: { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/Paris" } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("trigger names are required", async () => {
  const { context, agent } = await setup();
  await expect(
    call(router.triggers.create, { agentId: agent.id, name: "  ", config: { kind: "manual", placement: "chat" } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("deleting an agent deletes its triggers", async () => {
  const { context, agent } = await setup();
  await call(router.triggers.create, { agentId: agent.id, name: "T", config: { kind: "manual", placement: "chat" } }, { context });
  await call(router.agents.delete, { id: agent.id }, { context });
  expect(await context.db.select().from(triggers)).toEqual([]);
});
