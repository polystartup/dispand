// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ plugins: { uninstallPreview: vi.fn(), uninstall: vi.fn() }, runners: { list: vi.fn(), plugins: vi.fn(), workspacePlugin: vi.fn() }, harnesses: { list: vi.fn() }, skills: {}, tools: {}, agents: {}, triggers: {}, jobs: {}, tables: {} }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PluginRemoveSheet } = await import("./PluginRemoveSheet.tsx");
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const element = (kind: "agent" | "skill" | "tool", id: string, name: string, more: { reasons?: string[]; needs?: string[]; keepOnly?: string | null } = {}) => ({ key: `${kind}:${id}`, kind, id, name, reasons: [] as string[], needs: [] as string[], keepOnly: null as string | null, ...more });
const preview = { elements: [element("agent", "a1", "Writer"), element("skill", "s1", "Writing skills"), element("tool", "t1", "Document search")], reviewed: "r".repeat(64), nativeName: "dispand-plugin_1", sourceKey: "pinned-source" };;

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

test("a plugin nothing uses is removed whole, with no question and no choice to send", async () => {
  const close = await mount();
  expect(screen.getByText("Nothing of it is in use: its 3 elements go with it.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(fake.plugins.uninstall).toHaveBeenCalledWith({ id: "plugin_1", reviewed: preview.reviewed, choices: {} });
});

test("an agent in use starts kept with what it needs, and the choices made are what is sent", async () => {
  const writer = element("agent", "a1", "Writer", { reasons: ["It has a Job running or waiting"], needs: ["skill:s1", "tool:t1"] });
  await mount({ ...preview, elements: [writer, preview.elements[1]!, preview.elements[2]!] });
  expect(screen.getByRole("group", { name: "Writer" }).textContent).toContain("It has a Job running or waiting");
  expect(screen.getByRole("group", { name: "Writing skills" }).textContent).toContain("Needed by Writer if you keep it");
  // The tool is force deleted: stated, so the kept agent loses it.
  const tool = screen.getByRole("group", { name: "Document search" });
  await userEvent.click(within(tool).getByRole("radio", { name: "Delete" }));
  expect(tool.textContent).toContain("takes it off the agents and skills that use it");
  await userEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
  await waitFor(() => expect(fake.plugins.uninstall).toHaveBeenCalledWith({ id: "plugin_1", reviewed: preview.reviewed, choices: { "agent:a1": "keep", "skill:s1": "keep", "tool:t1": "delete" } }));
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


test("a cached removal preview shows no choice before fresh usage is loaded", async () => {
  const { orpc } = await import("../../lib/api.ts");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(orpc.plugins.uninstallPreview.queryOptions({ input: { id: "plugin_1" } }).queryKey, preview);
  let finish!: (value: typeof preview) => void;
  fake.plugins.uninstallPreview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  fake.harnesses.list.mockResolvedValue([]);
  fake.runners.list.mockResolvedValue([]);
  render(<QueryClientProvider client={client}><PluginRemoveSheet id="plugin_1" name="Writing kit" onClose={vi.fn()} /></QueryClientProvider>);
  expect(screen.queryByText(/Nothing of it is in use/)).toBeNull();
  finish({ ...preview, elements: [element("agent", "a1", "Writer", { reasons: ["A workflow uses this agent"], keepOnly: "A workflow uses this agent" }), preview.elements[1]!, preview.elements[2]!] });
  const agent = await screen.findByRole("group", { name: "Writer" });
  expect(agent.textContent).toContain("It stays, as yours.");
  expect(within(agent).queryByRole("radio")).toBeNull();
});
