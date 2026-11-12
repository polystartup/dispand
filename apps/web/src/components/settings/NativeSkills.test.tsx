// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ runners: { plugins: vi.fn(), list: vi.fn(), workspacePlugin: vi.fn(), workspaceSkills: vi.fn() }, harnesses: { list: vi.fn() }, plugins: { preview: vi.fn(), install: vi.fn() }, skills: {}, tools: {}, agents: {} }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { NativePluginAction, NativeTargetPicker, NativeWorkspaceSkills } = await import("./NativeSkills.tsx");
const { PluginInstallSheet } = await import("./PluginInstallSheet.tsx");

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const harness = { id: "h1", ownerId: "owner_1", type: "cli" as const, name: "Review", runnerId: "r1", kind: "codex" as const, permissionMode: "default" as const };
const runner = { id: "r1", name: "Workstation", status: "online" as const, runnerUpdate: "unavailable" as const, clis: {}, tools: [], lastSeenAt: null };
const target = { harness: "codex", available: true, add: true, remove: true };
const plugin = { resource: { kind: "plugin", id: "plugin_1" }, name: "Review tools", nativeName: "dispand-plugin_1", sourceKey: "pinned-source", skills: ["review", "check"], unavailable: null };
const standalone = { resource: { kind: "skill", id: "skillpkg_1" }, name: "Writing", nativeName: "dispand-skillpkg_1", sourceKey: "workspace:content", skills: ["writing"], unavailable: null };

function mount(node: React.ReactNode) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{node}</QueryClientProvider>);
}

test("target checkboxes deduplicate shared native accounts and disable unavailable pairs", async () => {
  fake.runners.plugins.mockResolvedValue({ targets: [target] });
  const onChange = vi.fn();
  mount(<NativeTargetPicker harnesses={[harness, { ...harness, id: "h2", name: "Other agent" }, { ...harness, id: "h3", kind: "claude-code" }]} runners={[runner]} selected={new Set()} onChange={onChange} />);
  await waitFor(() => expect((screen.getByRole("checkbox", { name: /Workstation \/ Codex/ }) as HTMLInputElement).disabled).toBe(false));
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect((screen.getByRole("checkbox", { name: /Workstation \/ Claude Code/ }) as HTMLInputElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole("checkbox", { name: /Workstation \/ Codex/ }));
  expect(onChange).toHaveBeenCalledWith("h1");
  expect(fake.runners.plugins).toHaveBeenCalledTimes(1);
});

test("native apply uses the reviewed revision, preserves partial outcomes and cannot repeat automatically", async () => {
  fake.runners.workspacePlugin.mockResolvedValueOnce({ revision: "reviewed123", blocked: false, changes: [{ harness: "codex", name: "dispand-plugin_1", action: "install" }] })
    .mockResolvedValueOnce({ error: "One native target failed", results: [{ harness: "codex", name: "dispand-plugin_1", status: "failed" }] });
  mount(<NativePluginAction harnessId="h1" resource={{ kind: "plugin", id: "plugin_1" }} name="Review tools" action="add" onDone={vi.fn()} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Apply native install" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText(/including skills you did not import/)).toBeTruthy();
  expect(fake.runners.workspacePlugin).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Apply native install" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "One native target failed");
  expect(screen.getByLabelText("Native results").textContent).toContain("codex: failed");
  expect(fake.runners.workspacePlugin.mock.calls[1]![0]).toEqual({ harnessId: "h1", resource: { kind: "plugin", id: "plugin_1" }, action: "add", dryRun: false, revision: "reviewed123" });
  expect(screen.queryByRole("button", { name: "Apply native install" })).toBeNull();
  expect(fake.runners.workspacePlugin).toHaveBeenCalledTimes(2);
});

test("harness inventory offers whole-plugin uninstall and standalone workspace installation", async () => {
  fake.runners.workspaceSkills.mockResolvedValue([plugin, standalone]);
  fake.runners.plugins.mockResolvedValue({ targets: [target], packages: [{ name: "already-managed", sourceKey: "pinned-source", harness: "codex", installed: true, enabled: true, pending: false }] });
  fake.runners.workspacePlugin.mockResolvedValue({ revision: "standalone-preview", blocked: false, changes: [] });
  mount(<NativeWorkspaceSkills harness={harness} runner={runner} />);
  await userEvent.click(screen.getByText("Workspace skills on Review"));
  const row = (await screen.findByText("Review tools · whole plugin")).closest("li")!;
  expect(row.textContent).toContain("review, check");
  expect(row.textContent).toContain("Native skills available");
  expect(within(row).getByRole("button", { name: "Uninstall natively" })).toBeTruthy();
  expect((within(row).getByRole("button", { name: "Install natively" }) as HTMLButtonElement).disabled).toBe(true);
  const own = (await screen.findByText("Writing")).closest("li")!;
  await userEvent.click(within(own).getByRole("button", { name: "Install natively" }));
  expect(await screen.findByText(/skills-only native plugin through Skillshare/)).toBeTruthy();
  await waitFor(() => expect(fake.runners.workspacePlugin).toHaveBeenCalledWith({ harnessId: "h1", resource: { kind: "skill", id: "skillpkg_1" }, action: "add", dryRun: true }));
});

test("install sheet imports once, then previews the selected pair and keeps a failed native install recoverable", async () => {
  fake.plugins.preview.mockResolvedValue({ reviewed: "workspace-preview", skills: [{ name: "review", description: "Review changes" }], agents: [], mcpServers: [], notImported: [], definitions: { agents: [], primitives: [], triggers: [] } });
  fake.harnesses.list.mockResolvedValue([harness]);
  fake.runners.list.mockResolvedValue([runner]);
  fake.runners.plugins.mockResolvedValue({ targets: [target] });
  fake.plugins.install.mockResolvedValue({ pluginId: "plugin_1", agentIds: [], toolIds: [] });
  fake.runners.workspacePlugin.mockResolvedValueOnce({ revision: "native-preview", blocked: false, changes: [] }).mockRejectedValueOnce({ code: "CONFLICT", message: "Native preview changed; refresh inventory" });
  const close = vi.fn();
  mount(<PluginInstallSheet marketplaceId="m1" entryName="reviews" onClose={close} />);
  await userEvent.click(await screen.findByRole("checkbox", { name: /Install the complete native plugin/ }));
  const pair = await screen.findByRole("checkbox", { name: /Workstation \/ Codex/ });
  await waitFor(() => expect((pair as HTMLInputElement).disabled).toBe(false));
  await userEvent.click(pair);
  await userEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("Installed in the workspace"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Apply native install" }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole("button", { name: "Apply native install" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Native preview changed; refresh inventory");
  expect(fake.plugins.install).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(close).toHaveBeenCalledTimes(1);
});

test("collapsed harness skills do not start runner requests; opening loads inventory", async () => {
  fake.runners.plugins.mockResolvedValue({ targets: [target], packages: [] });
  fake.runners.workspaceSkills.mockResolvedValue([]);
  mount(<NativeWorkspaceSkills harness={harness} runner={runner} />);
  expect(fake.runners.plugins).not.toHaveBeenCalled();
  expect(fake.runners.workspaceSkills).not.toHaveBeenCalled();
  await userEvent.click(screen.getByText("Workspace skills on Review"));
  await waitFor(() => expect(fake.runners.plugins).toHaveBeenCalledTimes(1));
  expect(fake.runners.workspaceSkills).toHaveBeenCalledTimes(1);
});
