import { expect, test, vi } from "vitest";

const loaded = vi.hoisted(() => [] as string[]);
vi.mock("@assistant-ui/react", async (original) => {
  loaded.push("@assistant-ui/react");
  return original();
});
vi.mock("@assistant-ui/react-markdown", async (original) => {
  loaded.push("@assistant-ui/react-markdown");
  return original();
});
vi.mock("../../lib/api.ts", () => ({ api: {}, orpc: {} }));

test("a dashboard and its widgets load no part of the chat stack", async () => {
  await import("./Dashboard.tsx");
  expect(loaded).toEqual([]);
});
