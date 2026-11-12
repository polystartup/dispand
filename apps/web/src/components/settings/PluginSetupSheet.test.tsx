// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ plugins: { setupPreview: vi.fn(), setUp: vi.fn() }, tables: {} }));
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

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginSetupSheet plugin={plugin as never} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

test("every table is ticked, what is missing is shown as a proposal's items, and a stopped run says what stopped it", async () => {
  fake.plugins.setupPreview.mockResolvedValue({
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
  expect(fake.plugins.setUp.mock.calls[0]![0]).toEqual({ id: "plugin_1", pick: { primitives: ["Clients", "Matters"] } });
  const made = await screen.findByRole("region", { name: "What was made" });
  expect(made.textContent).toContain("Table Matters: refused");
  expect(made.textContent).toContain("A table is already called “Matters”");
  expect(made.textContent).toContain("Field Matters.Clients: not made");
  expect(made.textContent).toContain("set up again");
});
