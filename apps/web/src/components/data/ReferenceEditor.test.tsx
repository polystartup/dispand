// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ tables: { get: vi.fn() }, rows: { list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { CellEditor } = await import("./CellEditor.tsx");
const { CellView } = await import("./CellView.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const field = { id: "f_client", name: "Client", type: "reference" as const, choices: [], referencesTableId: "tbl_clients" };

test("a reference is picked among the rows of its table, by their first field", async () => {
  fake.tables.get.mockResolvedValue({ id: "tbl_clients", name: "Clients", fields: [{ id: "f_name", name: "Name", type: "text", choices: [], position: 0, referencesTableId: null }] });
  fake.rows.list.mockResolvedValue({ rows: [{ id: "row_ada", values: { f_name: "Ada" } }, { id: "row_bob", values: { f_name: "Bob" } }, { id: "row_nameless", values: {} }], total: 3, attachments: {}, references: {} });
  const onCommit = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CellEditor field={field} value="row_ada" onCommit={onCommit} onCancel={() => {}} />
    </QueryClientProvider>,
  );
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["Ada", "Bob", "Untitled row"]);
  expect(screen.getByRole("option", { name: "Ada" }).getAttribute("aria-selected")).toBe("true");
  await userEvent.setup().click(screen.getByRole("option", { name: "Bob" }));
  expect(onCommit).toHaveBeenCalledWith("row_bob");
  expect(fake.rows.list.mock.calls[0]![0]).toMatchObject({ tableId: "tbl_clients" });
});

test("a reference cell shows the label of the row it names", () => {
  render(<CellView field={field} value="row_ada" references={{ row_ada: { label: "Ada" } }} />);
  expect(screen.getByText("Ada")).toBeTruthy();
  cleanup();
  // A row whose label isn't known: its id, not nothing.
  render(<CellView field={field} value="row_gone" references={{}} />);
  expect(screen.getByText("row_gone")).toBeTruthy();
});
