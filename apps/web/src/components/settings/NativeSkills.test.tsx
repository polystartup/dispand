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
const { NativePluginAction, NativeTargetPicker, NativeWorkspaceSkills, useNativeTargets } = await import("./NativeSkills.tsx");
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
  function Picker() {
    const targets = useNativeTargets([harness, { ...harness, id: "h2", name: "Other agent" }, { ...harness, id: "h3", kind: "claude-code" }], [runner]);
    return <NativeTargetPicker targets={targets} selected={new Set()} onChange={onChange} />;
  }
  mount(<Picker />);
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
  expect(fake.runners.workspacePlugin.mock.calls[1]![0]).toEqual({ harnessIds: ["h1"], resource: { kind: "plugin", id: "plugin_1" }, action: "add", dryRun: false, revision: "reviewed123" });
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
  await waitFor(() => expect(fake.runners.workspacePlugin).toHaveBeenCalledWith({ harnessIds: ["h1"], resource: { kind: "skill", id: "skillpkg_1" }, action: "add", dryRun: true }));
});

const claudeHarness = { ...harness, id: "h2", name: "Claude", kind: "claude-code" as const };

async function openInstallSheet(harnessRows = [harness, claudeHarness], runnerRows = [runner]) {
  fake.plugins.preview.mockResolvedValue({ reviewed: "workspace-preview", nativeAvailable: true, skills: [{ name: "review", description: "Review changes" }], agents: [], mcpServers: [], notImported: [], definitions: { agents: [], primitives: [], triggers: [] } });
  fake.harnesses.list.mockResolvedValue(harnessRows);
  fake.runners.list.mockResolvedValue(runnerRows);
  fake.runners.plugins.mockResolvedValue({ targets: [target, { ...target, harness: "claude-code" }] });
  fake.plugins.install.mockResolvedValue({ pluginId: "plugin_1", agentIds: [], toolIds: [] });
  const close = vi.fn();
  mount(<PluginInstallSheet marketplaceId="m1" entryName="reviews" onClose={close} />);
  expect(await screen.findByRole("checkbox", { name: /Install the complete native plugin/ })).toHaveProperty("checked", true);
  const count = new Set(harnessRows.map((h) => `${h.runnerId}/${h.kind}`)).size;
  await waitFor(() => expect(screen.getByRole("group", { name: "Install on runner / harness pairs" }).querySelectorAll("input")).toHaveLength(count));
  for (const pair of screen.getByRole("group", { name: "Install on runner / harness pairs" }).querySelectorAll("input")) {
    await waitFor(() => expect((pair as HTMLInputElement).disabled).toBe(false));
    expect(pair).toHaveProperty("checked", true);
  }
  return close;
}

async function installSheet(harnessRows = [harness, claudeHarness], runnerRows = [runner]) {
  const close = await openInstallSheet(harnessRows, runnerRows);
  await userEvent.click(screen.getByRole("button", { name: "Install" }));
  return close;
}

test("one Install click batches the runner's targets and shows individual progress and partial success", async () => {
  let finish!: (report: unknown) => void;
  fake.runners.workspacePlugin.mockResolvedValueOnce({ revision: "native-preview", blocked: false, changes: [] })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const close = await installSheet();
  const list = await screen.findByRole("list", { name: "Native installations" });
  await waitFor(() => expect(fake.runners.workspacePlugin).toHaveBeenCalledTimes(2));
  expect(within(list).getAllByRole("status").map((node) => node.textContent)).toEqual(["Installing…", "Installing…"]);
  expect(screen.queryByRole("button", { name: "Apply native install" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Next target" })).toBeNull();
  expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
  expect(fake.runners.workspacePlugin.mock.calls.map(([input]) => input)).toEqual([
    { harnessIds: ["h1", "h2"], resource: { kind: "plugin", id: "plugin_1" }, action: "add", dryRun: true },
    { harnessIds: ["h1", "h2"], resource: { kind: "plugin", id: "plugin_1" }, action: "add", dryRun: false, revision: "native-preview" },
  ]);
  finish({ error: "One native target failed", results: [{ harness: "codex", name: "dispand-plugin_1", status: "installed" }, { harness: "claude-code", name: "dispand-plugin_1", status: "failed" }] });
  await waitFor(() => expect(within(list).getAllByRole("status").map((node) => node.textContent)).toEqual(["Installed", "Failed"]));
  expect(within(list).getByText("Review")).toBeTruthy();
  expect(within(list).getByText("Claude")).toBeTruthy();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "One native target failed");
  expect(fake.plugins.install).toHaveBeenCalledTimes(1);
  expect(fake.runners.workspacePlugin).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(close).toHaveBeenCalledTimes(1);
});

test("selected runners install independently without retrying a failed runner or importing twice", async () => {
  const second = { ...claudeHarness, runnerId: "r2" };
  fake.runners.workspacePlugin.mockImplementation(async (input) => {
    if (input.harnessIds.includes("h1")) throw { code: "CONFLICT", message: "Runner unavailable" };
    return input.dryRun ? { revision: "runner-two", blocked: false } : { results: [{ harness: "claude-code", name: "dispand-plugin_1", status: "installed" }] };
  });
  await installSheet([harness, second], [runner, { ...runner, id: "r2", name: "Second" }]);
  const list = await screen.findByRole("list", { name: "Native installations" });
  await waitFor(() => expect(within(list).getAllByRole("status").map((node) => node.textContent)).toEqual(["Failed", "Installed"]));
  expect(fake.plugins.install).toHaveBeenCalledTimes(1);
  expect(fake.runners.workspacePlugin.mock.calls.map(([input]) => input.harnessIds)).toEqual([["h1"], ["h2"], ["h2"]]);
});

test("a failed apply preserves a known existing installation and never retries", async () => {
  fake.runners.workspacePlugin.mockResolvedValueOnce({ revision: "native-preview", results: [{ harness: "codex", name: "existing", status: "already_installed" }] })
    .mockRejectedValueOnce({ code: "CONFLICT", message: "Native source changed; check inventory" });
  await installSheet();
  const list = await screen.findByRole("list", { name: "Native installations" });
  await waitFor(() => expect(within(list).getAllByRole("status").map((node) => node.textContent)).toEqual(["Installed", "Failed"]));
  expect(fake.runners.workspacePlugin).toHaveBeenCalledTimes(2);
  expect(fake.plugins.install).toHaveBeenCalledTimes(1);
});

test("blocked native setup stops before applying while keeping the workspace import", async () => {
  fake.runners.workspacePlugin.mockResolvedValue({ revision: "blocked-preview", blocked: true, error: "Native installation blocked" });
  await installSheet([harness]);
  const list = await screen.findByRole("list", { name: "Native installations" });
  await waitFor(() => expect(within(list).getByRole("status").textContent).toBe("Failed"));
  expect(fake.runners.workspacePlugin).toHaveBeenCalledTimes(1);
  expect(fake.plugins.install).toHaveBeenCalledTimes(1);
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


test("explicitly excluded harnesses stay excluded when native installation is toggled", async () => {
  await openInstallSheet();
  const claude = screen.getByRole("checkbox", { name: /Workstation \/ Claude Code/ });
  await userEvent.click(claude);
  const native = screen.getByRole("checkbox", { name: /Install the complete native plugin/ });
  await userEvent.click(native);
  await userEvent.click(native);
  expect(screen.getByRole("checkbox", { name: /Workstation \/ Claude Code/ })).toHaveProperty("checked", false);
  expect(screen.getByRole("checkbox", { name: /Workstation \/ Codex/ })).toHaveProperty("checked", true);
  fake.runners.workspacePlugin.mockResolvedValue({ revision: "preview", blocked: true });
  await userEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => expect(fake.runners.workspacePlugin).toHaveBeenCalledWith(expect.objectContaining({ harnessIds: ["h1"] })));
});


test("skill-only sources do not attempt a complete native installation", async () => {
  fake.plugins.preview.mockResolvedValue({ reviewed: "workspace-preview", nativeAvailable: false, skills: [{ name: "review", description: "Review changes" }], agents: [], mcpServers: [], notImported: [], definitions: { agents: [], primitives: [], triggers: [] } });
  fake.harnesses.list.mockResolvedValue([harness]);
  fake.runners.list.mockResolvedValue([runner]);
  fake.runners.plugins.mockResolvedValue({ targets: [target] });
  fake.plugins.install.mockResolvedValue({ pluginId: "plugin_1", agentIds: [], toolIds: [] });
  const close = vi.fn();
  mount(<PluginInstallSheet marketplaceId="m1" entryName="reviews" onClose={close} />);
  const native = await screen.findByRole("checkbox", { name: /Install the complete native plugin/ });
  expect(native).toHaveProperty("checked", false);
  expect(native).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(fake.runners.workspacePlugin).not.toHaveBeenCalled();
});
