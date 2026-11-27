// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, configure, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../lib/api.ts", async () => (await import("../../test/fake-api.ts")).apiModule());
const { fake } = await import("../../test/fake-api.ts");
const { rowView } = await import("../../test/fixtures.ts");
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a> }));
const { GridWidget } = await import("./GridWidget.tsx");
const { createI18n } = await import("../../lib/i18n.ts");

// A file's first render loads its components cold: on a busy machine (the suite runs files in
// parallel) its first wait takes over Testing Library's default 1 s. The config gives each test
// 30 s; this file's waits get most of it.
configure({ asyncUtilTimeout: 20_000 });

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const widget = (fieldIds: string[]) =>
  ({ id: "w1", pageId: "p", type: "grid", title: "Projects", tableId: "tbl_1", config: { fieldIds }, layout: {} }) as never;
const table = {
  id: "tbl_1",
  name: "Projects",
  primitive: false,
  parent: null,
  fields: [{ id: "f_name", tableId: "tbl_1", name: "Name", type: "text" as const, choices: [], position: 0, referencesTableId: null }],
};

test("a grid whose fields were all deleted shows a notice instead of cards", async () => {
  fake.tables.get.mockResolvedValue(table);
  fake.rows.list.mockResolvedValue({ rows: [rowView({ tableId: "tbl_1", values: { f_gone: "x" } })], total: 1, attachments: {}, references: {} });
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
  fake.rows.list.mockResolvedValue({ rows: [rowView({ tableId: "tbl_1", values: { f_name: "Dispand" } })], total: 1, attachments: {}, references: {} });
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
  fake.rows.list.mockResolvedValue({ rows: [rowView({ tableId: "tbl_1", values: { f_name: "Dispand" } })], total: 1200, attachments: {}, references: {} });
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
