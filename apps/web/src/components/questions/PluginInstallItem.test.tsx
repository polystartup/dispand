// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ plugins: { preview: vi.fn() }, harnesses: { list: vi.fn() } }));
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

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginInstallItem input={input} />
    </QueryClientProvider>,
  );
}

test("a proposed install names the plugin, what it brings in and what each agent it makes may do", async () => {
  fake.harnesses.list.mockResolvedValue([{ id: "h_1", name: "Claude API", type: "cloud" }]);
  fake.plugins.preview.mockResolvedValue({ definitions: { primitives: [], agents: [upkeep], triggers: [] }, reviewed: "a".repeat(64) });
  mount();
  expect((await screen.findByRole("list", { name: "What Matter upkeep may do" })).textContent).toContain("Tables: Matters");
  expect(screen.getByText("legal-research")).toBeTruthy();
  expect(await screen.findByText(/on Claude API/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a plugin changed since it was proposed says approving installs nothing", async () => {
  fake.harnesses.list.mockResolvedValue([]);
  fake.plugins.preview.mockResolvedValue({ definitions: { primitives: [], agents: [upkeep], triggers: [] }, reviewed: "b".repeat(64) });
  mount();
  expect((await screen.findByRole("alert")).textContent).toContain("changed since this was proposed");
});
