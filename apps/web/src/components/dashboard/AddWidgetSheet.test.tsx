// @vitest-environment jsdom
import "../../test/jsdom-shims.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  workflows: { list: vi.fn() },
  tables: { list: vi.fn(), get: vi.fn() },
  widgets: { create: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a> }));
const { AddWidgetSheet } = await import("./AddWidgetSheet.tsx");
const { createI18n } = await import("../../lib/i18n.ts");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("in French, the add-widget sheet offers workflows and tables, and says what to create first", async () => {
  fake.workflows.list.mockResolvedValue([{ id: "wf_1", name: "Relance" }]);
  fake.tables.list.mockResolvedValue([]);
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AddWidgetSheet pageId="p" onClose={() => {}} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  expect(await screen.findByText("Ajouter un widget")).toBeTruthy();
  expect(await screen.findByText("Workflow : Relance")).toBeTruthy();
  expect(await screen.findByText(/Créez d’abord une table, dans/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Données" })).toBeTruthy();
  expect(screen.getByText("Grille")).toBeTruthy();
  expect(screen.getByText("Fermer")).toBeTruthy();
});
