// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ agents: { nativePlugins: vi.fn(), setNativePlugins: vi.fn() }, plugins: { list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const workspace = vi.hoisted(() => ({ role: "manager" as "owner" | "manager" | "member" }));
vi.mock("../../lib/workspace.tsx", () => ({ useWorkspaces: () => ({ workspaces: [], current: { organizationId: "o", workspaceId: "w", name: "W", role: workspace.role } }) }));
const { NativePlugins } = await import("./NativePlugins.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  workspace.role = "manager";
});

const plugins = [
  { id: "plugin_a", name: "forge", source: "marketplace", nativeBehind: false },
  { id: "plugin_b", name: "scribe", source: "marketplace", nativeBehind: true },
  { id: "plugin_g", name: "Generated: Acme", source: "generated", nativeBehind: false },
];

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NativePlugins agentId="agent_1" />
    </QueryClientProvider>,
  );
}

test("a manager grants the workspace's marketplace plugins one by one, each saved at once", async () => {
  fake.plugins.list.mockResolvedValue(plugins);
  fake.agents.nativePlugins.mockResolvedValue(["plugin_a"]);
  fake.agents.setNativePlugins.mockResolvedValue({ ok: true });
  mount();
  const forge = await screen.findByRole("checkbox", { name: /forge/ });
  await waitFor(() => expect((forge as HTMLInputElement).checked).toBe(true));
  // A generated plugin has nothing to run natively.
  expect(screen.queryByRole("checkbox", { name: /Generated/ })).toBeNull();
  expect(screen.getByRole("checkbox", { name: /scribe/ }).closest("label")!.textContent).toContain("wait for a manager's approval");
  await userEvent.click(screen.getByRole("checkbox", { name: /scribe/ }));
  expect(fake.agents.setNativePlugins).toHaveBeenCalledWith({ agentId: "agent_1", pluginIds: ["plugin_a", "plugin_b"] }, expect.anything());
});

test("a member sees which plugins are granted, and can't change them", async () => {
  workspace.role = "member";
  fake.plugins.list.mockResolvedValue(plugins);
  fake.agents.nativePlugins.mockResolvedValue(["plugin_b"]);
  mount();
  await waitFor(() => expect(screen.getByRole("region", { name: "Native plugins" }).textContent).toContain("scribe"));
  expect(screen.queryByRole("checkbox")).toBeNull();
});
