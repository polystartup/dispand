// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ plugins: { uninstallPreview: vi.fn(), uninstall: vi.fn() }, runners: { list: vi.fn(), plugins: vi.fn(), workspacePlugin: vi.fn() }, harnesses: { list: vi.fn() }, skills: {}, tools: {}, agents: {}, triggers: {}, jobs: {} }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PluginRemoveSheet } = await import("./PluginRemoveSheet.tsx");
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const preview = { skills: [{ id: "s1", name: "Writing skills" }], tools: [{ id: "t1", name: "Document search" }], agents: [{ id: "a1", name: "Writer", blocked: false, inUse: null as string | null }], nativeName: "dispand-plugin_1", sourceKey: "pinned-source" };

async function mount(data = preview, native = false) {
  fake.plugins.uninstallPreview.mockResolvedValue(data);
  fake.plugins.uninstall.mockResolvedValue(undefined);
  fake.harnesses.list.mockResolvedValue([
    { id: "h1", type: "cli", name: "Codex", runnerId: "r1", kind: "codex" },
    { id: "h2", type: "cli", name: "Claude", runnerId: "r1", kind: "claude-code" },
  ]);
  fake.runners.list.mockResolvedValue([{ id: "r1", name: "Workstation", status: "online" }]);
  fake.runners.plugins.mockResolvedValue({ targets: ["codex", "claude-code"].map((harness) => ({ harness, available: true, add: true, remove: true })), packages: native ? ["codex", "claude-code"].map((harness) => ({ name: "existing-native-name", sourceKey: "pinned-source", harness, installed: true, enabled: true, pending: false })) : [] });
  fake.runners.workspacePlugin.mockImplementation(async (input) => input.dryRun ? { revision: "reviewed-removal", blocked: false } : { results: [{ status: "removed" }] });
  const close = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><PluginRemoveSheet id="plugin_1" name="Writing kit" onClose={close} /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Remove plugin" })).toHaveProperty("disabled", false));
  return close;
}

test("removal selects every unused imported item by default and sends the checklist", async () => {
  const close = await mount();
  for (const name of ["Writer", "Writing skills", "Document search"]) expect(screen.getByRole("checkbox", { name: new RegExp(name) })).toHaveProperty("checked", true);
  await userEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(fake.plugins.uninstall).toHaveBeenCalledWith({ id: "plugin_1", remove: { skills: ["s1"], tools: ["t1"], agents: ["a1"] } });
});

test("agents in use start kept while checked skills and tools are still removed", async () => {
  await mount({ ...preview, agents: [{ ...preview.agents[0]!, inUse: "Has active Jobs" }] });
  expect(screen.getByRole("checkbox", { name: /Writer/ })).toHaveProperty("checked", false);
  for (const name of ["Writing skills", "Document search"]) expect(screen.getByRole("checkbox", { name: new RegExp(name) })).toHaveProperty("checked", true);
  await userEvent.click(screen.getByRole("checkbox", { name: /Writer/ }));
  expect(screen.getByRole("checkbox", { name: /Writing skills/ })).toHaveProperty("checked", true);
  await userEvent.click(screen.getByRole("checkbox", { name: /Writer/ }));
  await userEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
  await waitFor(() => expect(fake.plugins.uninstall).toHaveBeenCalledWith({ id: "plugin_1", remove: { skills: ["s1"], tools: ["t1"], agents: [] } }));
});

test("native removals default selected and use reviewed revisions before workspace deletion", async () => {
  const close = await mount(preview, true);
  for (const name of [/Workstation \/ Codex/, /Workstation \/ Claude Code/]) expect(screen.getByRole("checkbox", { name })).toHaveProperty("checked", true);
  await userEvent.click(screen.getByRole("checkbox", { name: /Workstation \/ Claude Code/ }));
  await userEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(fake.runners.workspacePlugin.mock.calls.map(([input]) => input)).toEqual([
    { harnessIds: ["h1"], resource: { kind: "plugin", id: "plugin_1" }, action: "remove", dryRun: true },
    { harnessIds: ["h1"], resource: { kind: "plugin", id: "plugin_1" }, action: "remove", dryRun: false, revision: "reviewed-removal" },
  ]);
  expect(fake.runners.workspacePlugin.mock.invocationCallOrder.at(-1)!).toBeLessThan(fake.plugins.uninstall.mock.invocationCallOrder[0]!);
});

test("a partial native failure retains the workspace and retries without repeating successful removals", async () => {
  const close = await mount(preview, true);
  fake.runners.plugins.mockResolvedValue({ targets: ["codex", "claude-code"].map((harness) => ({ harness, available: true, add: true, remove: true })), packages: [{ name: "existing-native-name", sourceKey: "pinned-source", harness: "claude-code", installed: true, enabled: true, pending: false }] });
  fake.runners.workspacePlugin.mockImplementation(async (input) => input.harnessIds[0] === "h2" ? { blocked: true, error: "Claude removal failed" } : input.dryRun ? { revision: "reviewed-removal", blocked: false } : { results: [{ status: "removed" }] });
  await userEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Claude removal failed");
  expect(fake.plugins.uninstall).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: /Workstation \/ Codex/ })).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("checkbox", { name: /Workstation \/ Claude Code/ }));
  await userEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(fake.runners.workspacePlugin).toHaveBeenCalledTimes(3);
  expect(fake.plugins.uninstall).toHaveBeenCalledTimes(1);
});
