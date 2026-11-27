// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../lib/api.ts", async () => (await import("../test/fake-api.ts")).apiModule());
const { fake } = await import("../test/fake-api.ts");
const { agentRow, cloudHarness } = await import("../test/fixtures.ts");
vi.mock("../lib/workspace.tsx", () => ({
  useWorkspaces: () => ({ workspaces: [], current: { organizationId: "o", workspaceId: "w", name: "W", role: "owner" } }),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => unknown }) => ({ options, useSearch: () => ({}) }),
  Link: ({ children }: { children: unknown }) => <a href="/">{children as string}</a>,
  useNavigate: () => vi.fn(),
}));
const { createI18n } = await import("../lib/i18n.ts");
const { Route: Data } = await import("./_app.settings.data.index.tsx");
const { Route: Agents } = await import("./_app.settings.agents.index.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function french(Route: unknown) {
  const Page = (Route as { options: { component: () => React.JSX.Element } }).options.component;
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Page />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

test("the Data list is in French", async () => {
  fake.tables.list.mockResolvedValue([]);
  french(Data);
  expect(await screen.findByText("Aucune table pour l’instant")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Données" })).toBeTruthy();
});

test("the Agents list is in French, the built-in agent shown as Stem", async () => {
  fake.agents.list.mockResolvedValue([agentRow({ id: "a1", name: "Assistant", builtIn: "assistant", harnessId: "h1" })]);
  fake.harnesses.list.mockResolvedValue([cloudHarness({ id: "h1", name: "Claude Code" })]);
  french(Agents);
  expect(await screen.findByText("Stem")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
  expect(screen.getByText("Nouvel agent")).toBeTruthy();
});
