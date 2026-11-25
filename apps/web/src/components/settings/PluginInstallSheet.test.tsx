// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { say } from "@dispand/domain/messages/index.ts";
import { I18nextProvider } from "react-i18next";

const fake = vi.hoisted(() => ({ plugins: { preview: vi.fn(), install: vi.fn() }, harnesses: { list: vi.fn() }, runners: { list: vi.fn(), plugins: vi.fn() }, skills: {}, tools: {}, agents: {} }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PluginInstallSheet } = await import("./PluginInstallSheet.tsx");
const { createI18n } = await import("../../lib/i18n.ts");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const drafting = { name: "Drafting", description: "Drafts letters", bundles: ["data"], tables: ["Matters"], tools: [], skills: [], consultMode: "auto", consults: [], selfLearning: ["workspace"], systemPrompt: "Draft." };

test("the plugin's definitions are set up with the install: each agent's rights are shown before it is confirmed, and the pick is sent with it", async () => {
  fake.harnesses.list.mockResolvedValue([{ id: "h_1", name: "Claude API", type: "cloud" }]);
  fake.runners.list.mockResolvedValue([]);
  fake.plugins.preview.mockResolvedValue({ runsNatively: [],
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
  // consultMode auto with no entries: the grant shows in the preview too.
  expect(rights.textContent).toContain("May consult: every agent of the workspace on its side");
  expect(rights.textContent).toContain("steers every agent of the workspace");
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Harness of Drafting" }).textContent).toContain("Claude API"));
  await userEvent.click(screen.getByRole("button", { name: /Install/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(fake.plugins.install.mock.calls[0]![0]).toMatchObject({ reviewed: "r".repeat(64), setup: { primitives: ["Matters"], agents: [{ name: "Drafting", harnessId: "h_1" }], triggers: ["Matter changed"] } });
});

test("what the setup didn't make is listed after the install, which stays open on it", async () => {
  fake.harnesses.list.mockResolvedValue([{ id: "h_1", name: "Claude API", type: "cloud" }]);
  fake.runners.list.mockResolvedValue([]);
  fake.plugins.preview.mockResolvedValue({ runsNatively: [], skills: [], mcpServers: [], agents: [], definitions: { primitives: [], agents: [drafting], triggers: [] }, notImported: [], reviewed: "r".repeat(64), nativeAvailable: false });
  fake.plugins.install.mockResolvedValue({ pluginId: "plugin_1", toolIds: [], agentIds: [], setup: { outcomes: [], waiting: [{ definition: "tool:case-law", reason: say("plugins.setup.waiting.notTicked") }] } });
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

test("what a plugin leaves out is explained in the page's language", async () => {
  fake.harnesses.list.mockResolvedValue([]);
  fake.runners.list.mockResolvedValue([]);
  fake.plugins.preview.mockResolvedValue({ runsNatively: [],
    skills: [],
    mcpServers: [],
    agents: [],
    definitions: { primitives: [], agents: [], triggers: [] },
    notImported: [{ component: "hook", name: "hooks", reason: say("notImported.hooks") }],
    reviewed: "r".repeat(64),
    nativeAvailable: false,
  });
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient()}>
        <PluginInstallSheet marketplaceId="mkt_1" entryName="law-firm" onClose={vi.fn()} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  expect(await screen.findByText("Les hooks exécutent des commandes sur la machine")).toBeTruthy();
});

test("what the plugin runs natively is on the install screen: its hooks, its servers and the files they run", async () => {
  fake.harnesses.list.mockResolvedValue([]);
  fake.runners.list.mockResolvedValue([]);
  fake.plugins.preview.mockResolvedValue({
    runsNatively: [
      { key: "hook:hooks/hooks.json:Stop:0:0", kind: "hook", label: "Stop", text: "./stamp.sh" },
      { key: "server:.mcp.json:echo", kind: "server", label: "echo", text: "node server.mjs\nenv: TOKEN" },
      { key: "file:stamp.sh", kind: "file", label: "stamp.sh", text: "curl https://example.com" },
    ],
    skills: [{ name: "review", description: "Reviews" }], mcpServers: [], agents: [], definitions: { primitives: [], agents: [], triggers: [] }, notImported: [], reviewed: "r".repeat(64), nativeAvailable: true,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginInstallSheet marketplaceId="mkt_1" entryName="law-firm" onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  const section = await screen.findByRole("region", { name: "Runs natively" });
  expect(section.textContent).toContain("./stamp.sh");
  expect(section.textContent).toContain("node server.mjs");
  expect(section.textContent).toContain("env: TOKEN");
  expect(section.textContent).toContain("curl https://example.com");
});
