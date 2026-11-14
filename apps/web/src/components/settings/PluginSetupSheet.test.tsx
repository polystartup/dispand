// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ plugins: { setupPreview: vi.fn(), setUp: vi.fn() }, tables: {}, agents: {}, harnesses: { list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PluginSetupSheet } = await import("./PluginSetupSheet.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const plugin = {
  id: "plugin_1",
  name: "law-firm",
  definitions: {
    primitives: [
      { name: "Clients", setUp: true },
      { name: "Matters", setUp: false },
    ],
    agents: [],
    triggers: [],
  },
};

function mount(p: object = plugin) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginSetupSheet plugin={p as never} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

test("every table is ticked, what is missing is shown as a proposal's items, and a stopped run says what stopped it", async () => {
  fake.harnesses.list.mockResolvedValue([]);
  fake.plugins.setupPreview.mockResolvedValue({
    reviewed: "reviewed-setup",
    items: [
      { tool: "tables_create", input: { name: "Matters" }, used: false, failed: false, refs: [], creates: "table", createdId: null },
      { tool: "fields_create", input: { tableId: { $item: 0 }, name: "Clients", type: "reference", referencesTableId: "tbl_1" }, used: false, failed: false, refs: ["tableId", "referencesTableId"], creates: "field", createdId: null },
    ],
    names: { tbl_1: { kind: "table", name: "Clients" } },
    waiting: [{ definition: "field:Matters.Name", reason: "Every table has a Name field already: this one isn't added" }],
  });
  fake.plugins.setUp.mockResolvedValue({
    outcomes: [
      { $item: 0, tool: "tables_create", from: "primitive:Matters", outcome: "refused", error: "A table is already called “Matters”" },
      { $item: 1, tool: "fields_create", from: "field:Matters.Clients", outcome: "not made" },
    ],
    waiting: [],
  });
  mount();
  expect((screen.getByRole("checkbox", { name: /Clients/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: /Matters/ }) as HTMLInputElement).checked).toBe(true);
  const items = await screen.findByRole("list", { name: "What is proposed" });
  expect(fake.plugins.setupPreview.mock.calls[0]![0]).toEqual({ id: "plugin_1", pick: { primitives: ["Clients", "Matters"] } });
  expect(items.textContent).toContain("Create a table");
  expect(items.textContent).toContain("the table item 1 creates");
  expect(items.textContent).toContain("Clients");
  expect(screen.getByRole("list", { name: "Not made" }).textContent).toContain("Every table has a Name field already");

  await userEvent.click(screen.getByRole("button", { name: "Set up" }));
  expect(fake.plugins.setUp.mock.calls[0]![0]).toEqual({ id: "plugin_1", pick: { primitives: ["Clients", "Matters"] }, reviewed: "reviewed-setup" });
  const made = await screen.findByRole("region", { name: "What was made" });
  expect(made.textContent).toContain("Table Matters: refused");
  expect(made.textContent).toContain("A table is already called “Matters”");
  expect(made.textContent).toContain("Field Matters.Clients: not made");
  expect(made.textContent).toContain("set up again");
});

test("agents not set up yet are ticked, each on the first harness of the kind it is written for, and their outcomes read as agents", async () => {
  fake.harnesses.list.mockResolvedValue([
    { id: "harness_cli", name: "Claude Code", type: "cli" },
    { id: "harness_cloud", name: "Claude API", type: "cloud" },
  ]);
  fake.plugins.setupPreview.mockResolvedValue({ reviewed: "reviewed-agents", items: [{ tool: "agents_create", input: { name: "Drafting", harnessId: "harness_cloud" }, used: false, failed: false, refs: ["harnessId"], creates: "agent", createdId: null }], names: {}, waiting: [] });
  fake.plugins.setUp.mockResolvedValue({ outcomes: [{ $item: 0, tool: "agents_create", from: "agent:Drafting", outcome: "made", id: "agent_1" }], waiting: [] });
  mount({
    ...plugin,
    definitions: {
      primitives: [],
      agents: [
        { name: "Intake", description: "Takes mail in.", harness: "cloud", selfLearning: [], setUp: true },
        { name: "Drafting", description: "Drafts replies.", harness: "cloud", selfLearning: ["agent"], setUp: false },
      ],
      triggers: [],
    },
  });
  expect((screen.getByRole("checkbox", { name: /Intake/ }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole("checkbox", { name: /Drafting/ }).closest("label")!.textContent).toContain("Learns into: agent");
  await screen.findByRole("list", { name: "What is proposed" });
  expect(fake.plugins.setupPreview.mock.calls.at(-1)![0]).toEqual({ id: "plugin_1", pick: { primitives: [], agents: [{ name: "Drafting", harnessId: "harness_cloud" }] } });
  expect(screen.getByRole("combobox", { name: "Harness of Drafting" }).textContent).toContain("Claude API");

  await userEvent.click(screen.getByRole("button", { name: "Set up" }));
  expect((await screen.findByRole("region", { name: "What was made" })).textContent).toContain("Agent Drafting: made");
});

test("a trigger is offered with its agent, ticked, and leaves the pick when unticked or when its agent does", async () => {
  fake.harnesses.list.mockResolvedValue([{ id: "harness_cloud", name: "Claude API", type: "cloud" }]);
  fake.plugins.setupPreview.mockResolvedValue({ reviewed: "r", items: [], names: {}, waiting: [] });
  mount({
    ...plugin,
    definitions: {
      primitives: [],
      agents: [
        { name: "Intake", description: "", harness: "cloud", selfLearning: [], setUp: true },
        { name: "Drafting", description: "", harness: "cloud", selfLearning: [], setUp: false },
      ],
      triggers: [
        { name: "New email", agent: "intake", setUp: false },
        { name: "Research recorded", agent: "Drafting", setUp: false },
        { name: "Already there", agent: "Intake", setUp: true },
      ],
    },
  });
  const picks = () => (fake.plugins.setupPreview.mock.calls.at(-1)![0] as { pick: { triggers?: string[] } }).pick.triggers;
  // One for an agent made before, one for the agent ticked; the one already set up isn't offered.
  expect((await screen.findByRole("checkbox", { name: /New email/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("checkbox", { name: /Research recorded/ }).closest("label")!.textContent).toContain("Starts Jobs of Drafting");
  expect(screen.queryByRole("checkbox", { name: /Already there/ })).toBeNull();
  await vi.waitFor(() => expect(picks()).toEqual(["New email", "Research recorded"]));
  await userEvent.click(screen.getByRole("checkbox", { name: /New email/ }));
  await vi.waitFor(() => expect(picks()).toEqual(["Research recorded"]));
  // The agent's own box: the trigger's says "Starts Jobs of Drafting" too.
  await userEvent.click(screen.getAllByRole("checkbox", { name: /Drafting/ })[0]!);
  expect(screen.queryByRole("checkbox", { name: /Research recorded/ })).toBeNull();
});

test("a server of the plugin that isn't a tool yet is offered with its address, unticked, and is picked alone when ticked", async () => {
  fake.harnesses.list.mockResolvedValue([]);
  fake.plugins.setupPreview.mockResolvedValue({ reviewed: "r", items: [], names: {}, waiting: [] });
  mount({
    ...plugin,
    definitions: { primitives: [], agents: [], triggers: [] },
    available: { skills: [], agents: [], mcpServers: [{ name: "case-law", type: "http", settings: [], url: "https://case-law.example.com/mcp" }, { name: "tenant", type: "http", settings: ["TENANT"], url: "https://x.example/${TENANT}/mcp" }, { name: "local", type: "stdio", settings: [] }] },
  });
  const server = screen.getByRole("checkbox", { name: /case-law/ }) as HTMLInputElement;
  // Ticked only once its address is seen; one that needs a setting or runs on a machine isn't added from here.
  expect(server.checked).toBe(false);
  expect(server.closest("label")!.textContent).toContain("https://case-law.example.com/mcp");
  expect(screen.queryByRole("checkbox", { name: /tenant/ })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /local/ })).toBeNull();
  expect(fake.plugins.setupPreview).not.toHaveBeenCalled();
  await userEvent.click(server);
  await vi.waitFor(() => expect(fake.plugins.setupPreview.mock.calls.at(-1)![0]).toEqual({ id: "plugin_1", pick: { primitives: [], servers: [{ name: "case-law" }] } }));
});
