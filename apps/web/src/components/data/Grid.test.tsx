// @vitest-environment jsdom
import type { FieldSchema } from "@dispand/domain/data/fields";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  tables: { get: vi.fn() },
  rows: { list: vi.fn(), stream: vi.fn(), create: vi.fn(), update: vi.fn() },
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

const fields: FieldSchema[] = [
  { id: "f_name", name: "Name", type: "text", choices: [] },
  { id: "f_note", name: "Note", type: "text", choices: [] },
];

function setup() {
  fake.rows.list.mockResolvedValue({ rows: [], total: 0, attachments: {}, references: {} });
  fake.rows.stream.mockResolvedValue((async function* () {})());
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Grid tableId="tbl_1" fields={fields} onSchemaChanged={() => {}} query={{ sort: [], filters: [] }} onQueryChange={() => {}} onOpenRow={() => {}} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

// A trigger on `created` gets the row as it is created: the grid never creates an empty one.
test("a new row is created with the first value saved in it, not when New row is clicked", async () => {
  const user = setup();
  let answer: (row: unknown) => void = () => {};
  fake.rows.create.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  fake.rows.update.mockResolvedValue({ id: "row_1", tableId: "tbl_1", values: { f_name: "Dispand", f_note: "Agents" } });

  await user.click(await screen.findByRole("button", { name: "New row" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Dispand");
  expect(fake.rows.create).not.toHaveBeenCalled();
  await user.keyboard("{Tab}");
  expect(fake.rows.create).toHaveBeenCalledExactlyOnceWith({ tableId: "tbl_1", values: { f_name: "Dispand" } });

  // The editor open meanwhile stays open once the row exists, and its value updates the row.
  await user.keyboard("Age");
  answer({ id: "row_1", tableId: "tbl_1", values: { f_name: "Dispand" } });
  await screen.findByRole("button", { name: "Open row" });
  await user.keyboard("nts{Enter}");
  await waitFor(() => expect(fake.rows.update).toHaveBeenCalledExactlyOnceWith({ id: "row_1", values: { f_note: "Agents" } }));
  expect(fake.rows.create).toHaveBeenCalledOnce();
  expect(screen.getAllByRole("gridcell").map((c) => c.textContent)).toEqual(["Dispand", "Agents"]);
});

test("a new row left before anything is saved in it is never created", async () => {
  const user = setup();
  await user.click(await screen.findByRole("button", { name: "New row" }));
  await user.keyboard("{Escape}");
  await user.keyboard("{Escape}");
  expect(screen.queryAllByRole("gridcell")).toEqual([]);
  expect(fake.rows.create).not.toHaveBeenCalled();
});
