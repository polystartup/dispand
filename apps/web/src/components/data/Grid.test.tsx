// @vitest-environment jsdom
import type { FieldSchema } from "@dispand/domain/data/fields";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  tables: { get: vi.fn() },
  rows: { list: vi.fn(), stream: vi.fn(), create: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
// The header's field menus have their own tests.
vi.mock("./FieldMenu.tsx", () => ({ FieldMenu: () => null }));
vi.mock("./NewFieldPopover.tsx", () => ({ NewFieldPopover: () => null }));
// jsdom has no layout.
Element.prototype.scrollIntoView = () => {};
const { Grid } = await import("./Grid.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const text = (id: string, name: string): FieldSchema => ({ id, name, type: "text", choices: [] });
const project: FieldSchema = { id: "f_project", name: "Project", type: "single-select", choices: [{ id: "c_dispand", label: "Dispand" }] };
const page = (rows: unknown[]) => ({ rows, total: rows.length, attachments: {}, references: {} });
const saved = { id: "row_1", tableId: "tbl_1", values: { f_name: "Dispand", f_note: "Agents" }, createdAt: new Date(), updatedAt: new Date() };

function setup(fields: FieldSchema[], requiredParent?: FieldSchema) {
  fake.rows.list.mockResolvedValue(page([]));
  fake.rows.stream.mockResolvedValue((async function* () {})());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Grid tableId="tbl_1" fields={fields} onSchemaChanged={() => {}} query={{ sort: [], filters: [] }} onQueryChange={() => {}} onOpenRow={() => {}} requiredParent={requiredParent} />
    </QueryClientProvider>,
  );
  // Radix dialogs set `pointer-events: none` on the page behind them.
  return userEvent.setup({ pointerEventsCheck: 0 });
}

// A trigger on `created` gets the row as it is created: the grid never creates an empty one.
test("New row creates nothing until the form is saved, then creates the row with its values", async () => {
  const user = setup([text("f_name", "Name"), text("f_note", "Note")]);
  fake.rows.create.mockResolvedValue(saved);

  await user.click(await screen.findByRole("button", { name: "New row" }));
  const form = screen.getByRole("dialog");
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Dispand");
  await user.keyboard("{Tab}Agents");
  expect(fake.rows.create).not.toHaveBeenCalled();
  // The field being typed in is saved by the click that creates the row.
  fake.rows.list.mockResolvedValue(page([saved]));
  await user.click(screen.getByRole("button", { name: "Create row" }));

  expect(fake.rows.create).toHaveBeenCalledExactlyOnceWith({ tableId: "tbl_1", values: { f_name: "Dispand", f_note: "Agents" } });
  await waitFor(() => expect(form.isConnected).toBe(false));
  // The row comes from the list, once.
  await waitFor(() => expect(screen.getAllByRole("gridcell").map((c) => c.textContent)).toEqual(["Dispand", "Agents"]));
});

test("cancelling the form creates nothing", async () => {
  const user = setup([text("f_name", "Name")]);
  await user.click(await screen.findByRole("button", { name: "New row" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Dispand");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  await user.click(screen.getByRole("button", { name: "New row" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fake.rows.create).not.toHaveBeenCalled();
});

test("an empty form or a value that doesn't fit creates nothing", async () => {
  const user = setup([text("f_name", "Name"), { id: "f_score", name: "Score", type: "number", choices: [] }]);
  await user.click(await screen.findByRole("button", { name: "New row" }));
  await user.click(screen.getByRole("button", { name: "Create row" }));
  expect(screen.getByRole("alert").textContent).toBe("Fill in at least one field.");

  await user.type(screen.getByRole("textbox", { name: "Name" }), "Dispand");
  await user.type(screen.getByRole("textbox", { name: "Score" }), "lots");
  await user.click(screen.getByRole("button", { name: "Create row" }));
  expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain("Fix the fields marked above first.");
  expect(fake.rows.create).not.toHaveBeenCalled();
});

test("a table with a required parent creates the row with the parent picked in its form", async () => {
  const user = setup([text("f_name", "Name"), project], project);
  fake.rows.create.mockResolvedValue(saved);
  await user.click(await screen.findByRole("button", { name: "New row" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Launch");
  expect(screen.getByRole("button", { name: "Create row" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("option", { name: "Dispand" }));
  await user.click(screen.getByRole("button", { name: "Create row" }));
  expect(fake.rows.create).toHaveBeenCalledExactlyOnceWith({ tableId: "tbl_1", values: { f_name: "Launch", f_project: "c_dispand" } });
});

test("a creation that fails keeps the form and says why", async () => {
  const user = setup([text("f_name", "Name")]);
  fake.rows.create.mockRejectedValue(new Error("no such table"));
  await user.click(await screen.findByRole("button", { name: "New row" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Dispand");
  await user.click(screen.getByRole("button", { name: "Create row" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not add the row: no such table");
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty("value", "Dispand");
});

test("the form stays open until the list holds the new row, and can't be closed while it is created", async () => {
  const user = setup([text("f_name", "Name")]);
  fake.rows.create.mockResolvedValue(saved);
  await user.click(await screen.findByRole("button", { name: "New row" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Dispand");
  let answer: (value: unknown) => void = () => {};
  fake.rows.list.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await user.click(screen.getByRole("button", { name: "Create row" }));
  await waitFor(() => expect(fake.rows.list).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();

  answer(page([saved]));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getAllByRole("gridcell").map((c) => c.textContent)).toEqual(["Dispand"]);
});

test("a table of files only creates its row empty, to fill in its detail", async () => {
  const user = setup([{ id: "f_logo", name: "Logo", type: "attachment", choices: [] }]);
  fake.rows.create.mockResolvedValue({ ...saved, values: {} });
  await user.click(await screen.findByRole("button", { name: "New row" }));
  await user.click(screen.getByRole("button", { name: "Create row" }));
  expect(fake.rows.create).toHaveBeenCalledExactlyOnceWith({ tableId: "tbl_1", values: {} });
});
