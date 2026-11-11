// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ tables: { list: vi.fn(), setPrimitive: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PrimitiveDialog } = await import("./PrimitiveDialog.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const table = { id: "tbl_matters", name: "Matters", fields: [], primitive: false, parent: null };

function mount(t = table) {
  fake.tables.list.mockResolvedValue([
    { id: "tbl_clients", name: "Clients" },
    { id: "tbl_matters", name: "Matters" },
  ]);
  fake.tables.setPrimitive.mockResolvedValue({ ...t, primitive: true });
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrimitiveDialog table={t} open onOpenChange={() => {}} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onSaved };
}

test("a table is made primitive with a required parent, chosen among the other tables", async () => {
  const { user, onSaved } = mount();
  await user.click(screen.getByRole("checkbox", { name: /Changes to its rows are events/ }));
  const parent = await screen.findByRole("combobox", { name: "Parent table" });
  // Not itself.
  expect([...parent.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["No parent", "Clients"]);
  await user.selectOptions(parent, "tbl_clients");
  await user.click(screen.getByRole("checkbox", { name: /Every row belongs to one/ }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(fake.tables.setPrimitive).toHaveBeenCalled());
  expect(fake.tables.setPrimitive.mock.calls[0]![0]).toEqual({ id: "tbl_matters", primitive: true, parent: { tableId: "tbl_clients", required: true } });
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

test("a table that isn't primitive has no parent to choose, and saving says why it was refused", async () => {
  const { user } = mount({ ...table, primitive: true, parent: { tableId: "tbl_clients", fieldId: "fld_c", required: false } } as never);
  fake.tables.setPrimitive.mockRejectedValue(new Error("1 row has no Clients: fill them first"));
  expect(screen.getByRole("combobox", { name: "Parent table" })).toBeTruthy();
  await user.click(screen.getByRole("checkbox", { name: /Every row belongs to one/ }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "1 row has no Clients: fill them first");
  await user.click(screen.getByRole("checkbox", { name: /Changes to its rows are events/ }));
  expect(screen.queryByRole("combobox", { name: "Parent table" })).toBeNull();
});
