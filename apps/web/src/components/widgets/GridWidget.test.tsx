// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  tables: { get: vi.fn() },
  rows: { list: vi.fn(), stream: vi.fn() },
  widgets: { update: vi.fn(), delete: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a> }));
const { GridWidget } = await import("./GridWidget.tsx");
const { createI18n } = await import("../../lib/i18n.ts");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const widget = (fieldIds: string[]) =>
  ({ id: "w1", pageId: "p", type: "grid", title: "Projects", tableId: "tbl_1", config: { fieldIds }, layout: {} }) as never;
const table = { id: "tbl_1", name: "Projects", fields: [{ id: "f_name", tableId: "tbl_1", name: "Name", type: "text", choices: [], position: 0 }] };

test("a grid whose fields were all deleted shows a notice instead of cards", async () => {
  fake.tables.get.mockResolvedValue(table);
  fake.rows.list.mockResolvedValue({ rows: [{ id: "row_1", tableId: "tbl_1", values: { f_gone: "x" } }], total: 1, attachments: {} });
  fake.rows.stream.mockResolvedValue((async function* () {})());
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GridWidget widget={widget(["f_gone"])} editing={false} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/fields this widget showed were deleted/)).toBeTruthy();
  expect(screen.queryByRole("listitem")).toBeNull();
});

test("a grid shows a card per row, titled by its first field", async () => {
  fake.tables.get.mockResolvedValue(table);
  fake.rows.list.mockResolvedValue({ rows: [{ id: "row_1", tableId: "tbl_1", values: { f_name: "Dispand" } }], total: 1, attachments: {} });
  fake.rows.stream.mockResolvedValue((async function* () {})());
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GridWidget widget={widget(["f_name"])} editing={false} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Dispand")).toBeTruthy();
});

test("in French, a grid says how many rows it shows and links to Data", async () => {
  fake.tables.get.mockResolvedValue(table);
  fake.rows.list.mockResolvedValue({ rows: [{ id: "row_1", tableId: "tbl_1", values: { f_name: "Dispand" } }], total: 1200, attachments: {} });
  fake.rows.stream.mockResolvedValue((async function* () {})());
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <GridWidget widget={widget(["f_name"])} editing />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  expect(await screen.findByText(/1 sur 1\s200 affichées/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Ouvrir dans Données" })).toBeTruthy();
  expect(screen.getByLabelText("Supprimer Projects")).toBeTruthy();
});
