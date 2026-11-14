// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ plugins: { update: vi.fn(), updatePreview: vi.fn(), uninstall: vi.fn(), uninstallPreview: vi.fn(), setupPreview: vi.fn(), setUp: vi.fn() }, runners: { list: vi.fn(), plugins: vi.fn(), workspacePlugin: vi.fn() }, harnesses: { list: vi.fn() }, triggers: {}, jobs: {}, skills: {}, tools: {}, agents: {}, tables: {} }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PluginRow } = await import("./PluginRow.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const none = { skills: [], mcpServers: [], agents: [] };
const base = {
  description: "",
  updatedAt: new Date(),
  skills: [],
  tools: [],
  agents: [],
  tables: [],
  fields: [],
  triggers: [],
  definitions: { agents: [], primitives: [], triggers: [] },
  available: none,
  notImported: [],
};

function mount(plugin: Parameters<typeof PluginRow>[0]["plugin"]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ul>
        <PluginRow plugin={plugin} />
      </ul>
    </QueryClientProvider>,
  );
}

test("a generated plugin lists what was created, by kind, has nothing to update, and says removing it keeps them", async () => {
  fake.plugins.uninstall.mockResolvedValue(undefined);
  fake.plugins.uninstallPreview.mockResolvedValue({ elements: [], reviewed: "r".repeat(64), nativeName: "dispand-plugin_1", sourceKey: null });
  fake.harnesses.list.mockResolvedValue([]);
  fake.runners.list.mockResolvedValue([]);
  mount({
    ...base,
    id: "plugin_1",
    name: "Generated: Acme Law",
    source: "generated",
    marketplace: null,
    url: null,
    sha: null,
    tables: [{ id: "t1", name: "Matters" }],
    fields: [{ id: "f1", name: "Matters.Status" }],
    agents: [{ id: "a1", name: "Clerk" }],
    triggers: [{ id: "tr1", name: "Clerk: Ask" }],
    tools: [{ id: "tool1", name: "Search" }],
  });
  const row = screen.getByRole("listitem", { name: "Generated: Acme Law" });
  for (const text of ["Matters", "Matters.Status", "Clerk", "Clerk: Ask", "Search"]) expect(row.textContent).toContain(text);
  expect(row.textContent).toMatch(/removing it keeps them/);
  expect(row.textContent).not.toMatch(/Skills:/);
  expect(screen.queryByRole("button", { name: "Update Generated: Acme Law" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Remove Generated: Acme Law" }));
  expect(fake.plugins.uninstall).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  // It only lists what was created: nothing in the workspace is its own.
  expect(dialog.textContent).toContain("removing it removes nothing else");
  await userEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
  expect(fake.plugins.uninstall.mock.calls[0]![0]).toEqual({ id: "plugin_1", reviewed: "r".repeat(64), choices: {} });
});

test("a marketplace plugin reads as before: where it came from, its commit, Update", () => {
  mount({ ...base, id: "plugin_2", name: "superpowers", source: "marketplace", marketplace: "acme", url: "https://example.com/p.git", sha: "0123456789abcdef", skills: [{ name: "tdd", description: "" }] });
  const row = screen.getByRole("listitem", { name: "superpowers" });
  expect(row.textContent).toContain("From acme · 0123456");
  expect(row.textContent).toContain("Choose what to remove; items you keep stay in your workspace");
  expect(row.textContent).toContain("tdd");
  expect(screen.getByRole("button", { name: "Update superpowers" })).toBeTruthy();
});

test("a plugin's definitions are listed by kind, each marked once something was set up from it", () => {
  mount({
    ...base,
    id: "plugin_3",
    name: "law-firm",
    source: "marketplace",
    marketplace: "firms",
    url: "https://example.com/law-firm.git",
    sha: "0123456789abcdef",
    tables: [{ id: "tbl_1", name: "Clients" }],
    definitions: {
      primitives: [
        { name: "Clients", setUp: true },
        { name: "Matters", setUp: false },
      ],
      agents: [{ name: "Drafting", description: "", harness: null, selfLearning: [], setUp: false }],
      triggers: [{ name: "Research recorded", agent: "Drafting", setUp: false }],
    },
  });
  const row = screen.getByRole("listitem", { name: "law-firm" });
  expect(row.textContent).toContain("Tables: Clients");
  expect(row.textContent).toContain("Table definitions: Clients (set up), Matters");
  expect(row.textContent).toContain("Agent definitions: Drafting");
  expect(row.textContent).toContain("Trigger definitions: Research recorded");
});

const installed = { ...base, id: "plugin_1", name: "law-firm", source: "marketplace", marketplace: "firms", sha: "a".repeat(40) } as unknown as Parameters<typeof PluginRow>[0]["plugin"];

test("an update with nothing to look at applies at once", async () => {
  fake.plugins.updatePreview.mockResolvedValue({ sha: "b".repeat(40), conflicts: [], additions: [], removals: [], changes: [{ key: "agent:a:dataTables", kind: "agent", id: "a", name: "Drafting", field: "dataTables", class: "silent", before: ["t"], after: [] }], names: {}, reviewed: "r".repeat(64) });
  fake.plugins.update.mockResolvedValue({ sha: "b".repeat(40) });
  mount(installed);
  await userEvent.click(screen.getByRole("button", { name: "Update law-firm" }));
  expect((await screen.findByText("Updated to bbbbbbb.")).textContent).toBeTruthy();
  expect(fake.plugins.update.mock.calls[0]![0]).toEqual({ id: "plugin_1", reviewed: "r".repeat(64) });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an update that rewords an agent or meets the owner's own change stops on its screen, and applies what they confirm", async () => {
  fake.plugins.updatePreview.mockResolvedValue({
    sha: "b".repeat(40),
    conflicts: [{ key: "agent:a:systemPrompt", kind: "agent", id: "a", name: "Drafting", field: "systemPrompt", old: "Draft.", mine: "Mine.", next: "Draft well." }],
    changes: [{ key: "agent:b:systemPrompt", kind: "agent", id: "b", name: "Intake", field: "systemPrompt", class: "wording", before: "Read.", after: "Read all." }],
    additions: [],
    removals: [],
    tables: [],
    releaseNotes: { from: null, to: "b".repeat(40), version: null, text: null }, native: { harnesses: [], unchecked: [] },
    names: {},
    reviewed: "r".repeat(64),
  });
  fake.harnesses.list.mockResolvedValue([]);
  fake.plugins.update.mockResolvedValue({ sha: "b".repeat(40), failed: [{ name: "Intake", reason: "Harness not found" }] });
  mount(installed);
  await userEvent.click(screen.getByRole("button", { name: "Update law-firm" }));
  const dialog = await screen.findByRole("dialog");
  expect(fake.plugins.update).not.toHaveBeenCalled();
  expect(dialog.textContent).toContain("1 wording change");
  await userEvent.click(screen.getByRole("radio", { name: "Take the plugin's" }));
  await userEvent.click(screen.getByRole("button", { name: "Update" }));
  expect(fake.plugins.update.mock.calls[0]![0]).toEqual({ id: "plugin_1", reviewed: "r".repeat(64), take: ["agent:a:systemPrompt"], choices: {}, tables: {} });
  // What an element's own checks refused is said, not hidden.
  expect((await screen.findByText(/except Intake \(Harness not found\)/)).textContent).toContain("Updated to bbbbbbb");
});

test("after an update that adds elements, Set up opens: they are made from there, not by the update", async () => {
  fake.plugins.updatePreview.mockResolvedValue({ sha: "b".repeat(40), conflicts: [], changes: [], additions: [{ key: "agent:Billing", kind: "agent", name: "Billing", detail: "Prepares invoices." }], removals: [], tables: [], releaseNotes: { from: null, to: "b".repeat(40), version: null, text: null }, native: { harnesses: [], unchecked: [] }, names: {}, reviewed: "r".repeat(64) });
  fake.plugins.update.mockResolvedValue({ sha: "b".repeat(40) });
  fake.harnesses.list.mockResolvedValue([]);
  mount(installed);
  await userEvent.click(screen.getByRole("button", { name: "Update law-firm" }));
  expect((await screen.findByRole("dialog")).textContent).toContain("New in this version");
  await userEvent.click(screen.getByRole("button", { name: "Update" }));
  expect(fake.plugins.update.mock.calls[0]![0]).toEqual({ id: "plugin_1", reviewed: "r".repeat(64), take: [], choices: {}, tables: {} });
  expect((await screen.findByRole("dialog")).textContent).toContain("Set up law-firm");
});

test("what a new version drops is on the update's screen with the removal's choices, and they are what is sent", async () => {
  fake.plugins.updatePreview.mockResolvedValue({
    sha: "b".repeat(40),
    conflicts: [],
    changes: [],
    additions: [],
    removals: [
      { key: "table:t1", kind: "table", id: "t1", name: "Research", reasons: ["It has 1 row"], needs: [], keepOnly: null },
      { key: "agent:a1", kind: "agent", id: "a1", name: "Matter upkeep", reasons: [], needs: [], keepOnly: null },
    ],
    tables: [],
    releaseNotes: { from: null, to: "b".repeat(40), version: null, text: null }, native: { harnesses: [], unchecked: [] },
    names: {},
    reviewed: "r".repeat(64),
  });
  fake.plugins.update.mockResolvedValue({ sha: "b".repeat(40) });
  mount(installed);
  await userEvent.click(screen.getByRole("button", { name: "Update law-firm" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("No longer in this version");
  expect(screen.getByRole("group", { name: "Research" }).textContent).toContain("It has 1 row");
  expect(dialog.textContent).toContain("1 other element goes with the plugin.");
  await userEvent.click(screen.getByRole("button", { name: "Update" }));
  expect(fake.plugins.update.mock.calls[0]![0]).toEqual({ id: "plugin_1", reviewed: "r".repeat(64), take: [], choices: { "table:t1": "keep" }, tables: {} });
});
