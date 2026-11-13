import { afterEach, expect, test, vi } from "vitest";
const fake = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn(), spawn: vi.fn(), query: vi.fn(), supportedCommands: vi.fn() }));
vi.mock("./codex/rpc.ts", () => ({ CodexRpc: { spawn: fake.spawn } }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: fake.query }));
import { discoverCommands } from "./commands.ts";
afterEach(() => vi.resetAllMocks());
test("Codex lists enabled skills in the intended directory without exposing paths", async () => {
  fake.spawn.mockResolvedValue(fake);
  fake.request.mockResolvedValue({ data: [{ skills: [{ name: "tidy", description: "Tidy", path: "/private/tidy/SKILL.md", enabled: true }, { name: "off", enabled: false }] }] });
  expect(await discoverCommands("codex", "/cli", {}, "/work")).toEqual([{ name: "tidy", description: "Tidy" }]);
  expect(fake.request).toHaveBeenCalledWith("skills/list", { cwds: ["/work"], forceReload: true });
  expect(fake.close).toHaveBeenCalledOnce();
});
test("Claude preserves names, descriptions, aliases and builtin flags without a turn", async () => {
  fake.query.mockReturnValue(fake);
  fake.supportedCommands.mockResolvedValue([{ name: "plugin:tidy", description: "Tidy", aliases: ["tidy"], builtin: false }]);
  expect(await discoverCommands("claude-code", "/cli", {}, "/work")).toEqual([{ name: "plugin:tidy", description: "Tidy", aliases: ["tidy"], builtin: false }]);
  expect(fake.query.mock.calls[0]![0].options.cwd).toBe("/work");
  expect(fake.close).toHaveBeenCalledOnce();
});
test("discovery closes on failure", async () => {
  fake.spawn.mockResolvedValue(fake);
  fake.request.mockRejectedValue(new Error("offline"));
  await expect(discoverCommands("codex", "/cli", {}, "/work")).rejects.toThrow("offline");
  expect(fake.close).toHaveBeenCalledOnce();
});
