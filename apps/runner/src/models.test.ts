import { afterEach, expect, test, vi } from "vitest";
const fake = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn(), spawn: vi.fn(), query: vi.fn(), supportedModels: vi.fn() }));
vi.mock("./codex/rpc.ts", () => ({ CodexRpc: { spawn: fake.spawn } }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: fake.query }));
import { discoverModels } from "./models.ts";
afterEach(() => vi.resetAllMocks());
test("Codex follows catalog cursors, omits hidden models and closes the process", async () => {
  fake.spawn.mockResolvedValue(fake);
  fake.request.mockResolvedValueOnce({ data: [{ model: "fast", displayName: "Fast", hidden: false }, { model: "hidden", hidden: true }], nextCursor: "next" }).mockResolvedValueOnce({ data: [{ model: "deep", displayName: "Deep" }], nextCursor: null });
  expect(await discoverModels("codex", "/cli", {})).toEqual([{ id: "fast", label: "Fast" }, { id: "deep", label: "Deep" }]);
  expect(fake.request).toHaveBeenLastCalledWith("model/list", { cursor: "next", limit: 100 });
  expect(fake.close).toHaveBeenCalledOnce();
});
test("Claude reads SDK model information without a user turn and closes on failure", async () => {
  fake.query.mockReturnValue(fake);
  fake.supportedModels.mockResolvedValue([{ value: "sonnet", displayName: "Sonnet" }]);
  expect(await discoverModels("claude-code", "/cli", {})).toEqual([{ id: "sonnet", label: "Sonnet" }]);
  expect(fake.query.mock.calls[0]![0].prompt).not.toBeTypeOf("string");
  expect(fake.close).toHaveBeenCalledOnce();
  fake.supportedModels.mockRejectedValue(new Error("offline"));
  await expect(discoverModels("claude-code", "/cli", {})).rejects.toThrow("offline");
  expect(fake.close).toHaveBeenCalledTimes(2);
});
