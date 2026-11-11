import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { agentTools, tools } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { isPollable } from "./pollable.ts";

const schema = { type: "object" };

/** A mail tool with a read-only search and a send, and an agent with it whose asking is set by `unasked`. */
async function setup(unasked?: string[]) {
  const context = await ownerContext();
  await context.db.insert(tools).values({
    id: "tool_mail",
    ownerId: context.ownerId,
    name: "Mail",
    kind: "http",
    url: "https://example.com/mcp",
    transport: "streamable-http",
    actions: [
      { name: "search", description: "Searches.", inputSchema: schema, readOnly: true },
      { name: "send", description: "Sends.", inputSchema: schema },
    ],
  });
  if (unasked) {
    const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
    const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
    const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context });
    await context.db.insert(agentTools).values({ agentId: agent.id, toolId: "tool_mail", unasked });
  }
  return context;
}

test("by default a poll reads what the server marks read-only, and nothing else", async () => {
  const context = await setup();
  expect(await call(router.tools.pollable, { id: "tool_mail" }, { context })).toEqual([
    { name: "search", readOnly: true, allowed: true, askedBy: [], pollable: true },
    { name: "send", readOnly: false, allowed: false, askedBy: [], pollable: false },
  ]);
  expect(await isPollable(context.db, context.ownerId, "tool_mail", "search")).toBe(true);
  expect(await isPollable(context.db, context.ownerId, "tool_mail", "send")).toBe(false);
});

test("the owner's choice replaces the default, names only the tool's actions, and survives a new listing", async () => {
  const context = await setup();
  await call(router.tools.setPollable, { id: "tool_mail", actions: ["send"] }, { context });
  expect(await isPollable(context.db, context.ownerId, "tool_mail", "search")).toBe(false);
  expect(await isPollable(context.db, context.ownerId, "tool_mail", "send")).toBe(true);
  await expect(call(router.tools.setPollable, { id: "tool_mail", actions: ["delete"] }, { context })).rejects.toThrow("The tool has no action delete");
  await expect(call(router.tools.setPollable, { id: "tool_other", actions: [] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("an action an agent must ask before using is never polled, whatever the owner allowed", async () => {
  // The agent runs `search` unasked, and asks before `send`.
  const context = await setup(["search"]);
  await call(router.tools.setPollable, { id: "tool_mail", actions: ["search", "send"] }, { context });
  const actions = await call(router.tools.pollable, { id: "tool_mail" }, { context });
  expect(actions.find((a) => a.name === "send")).toMatchObject({ allowed: true, askedBy: ["Clerk"], pollable: false });
  expect(actions.find((a) => a.name === "search")).toMatchObject({ pollable: true });
});
