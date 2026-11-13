import { call } from "@orpc/server";
import { expect, test, vi } from "vitest";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

test("Assistant catalog supplements native commands, preserves namespaces and falls back on discovery failure", async () => {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Runner" }, { context });
  const harness = await call(router.harnesses.create, { name: "CLI", kind: "claude-code", runnerId, permissionMode: "default" }, { context });
  const assistant = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context });
  const pkg = await call(router.skills.create, { name: "tidy", description: "Tidy", instructions: "Tidy", requiredToolIds: [] }, { context });
  const discover = vi.spyOn(context.hub, "commands").mockResolvedValue({ type: "commands.replied", requestId: "r", commands: [{ name: "tidy:tidy", description: "Native tidy" }, { name: "other:tidy", description: "Other tidy" }] });
  const catalog = await call(router.assistantCommands, { agentId: assistant.agentId }, { context });
  expect(catalog.entries.filter((e) => e.name === "tidy:tidy")).toEqual([{ name: "tidy:tidy", description: "Native tidy", source: "harness", skillId: expect.any(String) }]);
  expect(catalog.entries.some((e) => e.name === "other:tidy")).toBe(true);
  discover.mockRejectedValue(new Error("offline"));
  const fallback = await call(router.assistantCommands, { agentId: assistant.agentId }, { context });
  expect(fallback.nativeUnavailable).toBe(true);
  expect(fallback.entries.find((e) => e.name === "tidy:tidy")).toMatchObject({ source: "dispand", skillId: expect.any(String) });
  discover.mockResolvedValue({ type: "commands.replied", requestId: "r", commands: [{ name: `dispand-${pkg.packageId}`.toLowerCase().replaceAll("_", "-") + ":tidy", description: "Native workspace skill" }] });
  const nativeWorkspace = await call(router.assistantCommands, { agentId: assistant.agentId }, { context });
  expect(nativeWorkspace.entries.filter((e) => e.name.endsWith(":tidy"))).toEqual([expect.objectContaining({ source: "harness", skillId: expect.any(String) })]);
  await expect(call(router.assistantCommands, { agentId: "missing" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
