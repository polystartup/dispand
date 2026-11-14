// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ plugins: { preview: vi.fn(), install: vi.fn() }, harnesses: { list: vi.fn() }, runners: { list: vi.fn(), plugins: vi.fn() }, skills: {}, tools: {}, agents: {} }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PluginInstallSheet } = await import("./PluginInstallSheet.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const drafting = { name: "Drafting", description: "Drafts letters", bundles: ["data"], tables: ["Matters"], tools: [], skills: [], consults: [], selfLearning: ["workspace"], systemPrompt: "Draft." };

test("the plugin's definitions are set up with the install: each agent's rights are shown before it is confirmed, and the pick is sent with it", async () => {
  fake.harnesses.list.mockResolvedValue([{ id: "h_1", name: "Claude API", type: "cloud" }]);
  fake.runners.list.mockResolvedValue([]);
  fake.plugins.preview.mockResolvedValue({
    skills: [],
    mcpServers: [],
    agents: [],
    definitions: { primitives: [{ name: "Matters", primitive: true, fields: [] }], agents: [drafting], triggers: [{ name: "Matter changed", agent: "Drafting" }] },
    notImported: [],
    reviewed: "r".repeat(64),
    nativeAvailable: false,
  });
  fake.plugins.install.mockResolvedValue({ pluginId: "plugin_1", toolIds: [], agentIds: [], setup: { outcomes: [], waiting: [] } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginInstallSheet marketplaceId="mkt_1" entryName="law-firm" onClose={onClose} />
    </QueryClientProvider>,
  );
  const rights = await screen.findByRole("list", { name: "What Drafting may do" });
  expect(rights.textContent).toContain("What its Jobs may do: Work on data");
  expect(rights.textContent).toContain("Tables: Matters");
  expect(rights.textContent).toContain("steers every agent of the workspace");
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Harness of Drafting" }).textContent).toContain("Claude API"));
  await userEvent.click(screen.getByRole("button", { name: /Install/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(fake.plugins.install.mock.calls[0]![0]).toMatchObject({ reviewed: "r".repeat(64), setup: { primitives: ["Matters"], agents: [{ name: "Drafting", harnessId: "h_1" }], triggers: ["Matter changed"] } });
});

test("what the setup didn't make is listed after the install, which stays open on it", async () => {
  fake.harnesses.list.mockResolvedValue([{ id: "h_1", name: "Claude API", type: "cloud" }]);
  fake.runners.list.mockResolvedValue([]);
  fake.plugins.preview.mockResolvedValue({ skills: [], mcpServers: [], agents: [], definitions: { primitives: [], agents: [drafting], triggers: [] }, notImported: [], reviewed: "r".repeat(64), nativeAvailable: false });
  fake.plugins.install.mockResolvedValue({ pluginId: "plugin_1", toolIds: [], agentIds: [], setup: { outcomes: [], waiting: [{ definition: "tool:case-law", reason: "It wasn't ticked with the install" }] } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginInstallSheet marketplaceId="mkt_1" entryName="law-firm" onClose={onClose} />
    </QueryClientProvider>,
  );
  await screen.findByRole("list", { name: "What Drafting may do" });
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Harness of Drafting" }).textContent).toContain("Claude API"));
  await userEvent.click(screen.getByRole("button", { name: /Install/ }));
  expect((await screen.findByRole("list", { name: "Not made yet" })).textContent).toContain("tool:case-law: It wasn't ticked with the install");
  expect(onClose).not.toHaveBeenCalled();
});
