// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ harnesses: { list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PluginInstallItem } = await import("./PluginInstallItem.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const upkeep = { name: "Matter upkeep", description: "", bundles: ["data"], tables: ["Matters"], tools: [], skills: [], consults: [], selfLearning: [], systemPrompt: "Keep." };
const input = { marketplaceId: "mkt_1", entryName: "law-firm", reviewed: "a".repeat(64), skills: ["legal-research"], setup: { primitives: ["Matters"], agents: [{ name: "Matter upkeep", harnessId: "h_1" }] } };

function mount(shown?: object) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginInstallItem input={input} shown={shown} />
    </QueryClientProvider>,
  );
}

test("a proposed install names the plugin, what it brings in and what each agent it makes may do, as the server read it", async () => {
  fake.harnesses.list.mockResolvedValue([{ id: "h_1", name: "Claude API", type: "cloud" }]);
  mount({ agents: [upkeep] });
  expect(screen.getByRole("list", { name: "What Matter upkeep may do" }).textContent).toContain("Tables: Matters");
  expect(screen.getByText("legal-research")).toBeTruthy();
  expect(await screen.findByText(/on Claude API/)).toBeTruthy();
});

test("an agent whose rights weren't read says to decline", () => {
  fake.harnesses.list.mockResolvedValue([]);
  mount();
  expect(screen.getByText(/wasn't read: decline/)).toBeTruthy();
});
