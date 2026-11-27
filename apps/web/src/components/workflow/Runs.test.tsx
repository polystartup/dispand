// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../lib/api.ts", async () => (await import("../../test/fake-api.ts")).apiModule());
const { fake } = await import("../../test/fake-api.ts");
const { agentRow, runRow } = await import("../../test/fixtures.ts");
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));
const { RunList } = await import("./Runs.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const job = (id: string, agentId: string | null, deletedAgentName: string | null) =>
  runRow({
    id,
    agentId,
    deletedAgentName,
    status: "failed",
    error: "Stopped",
    createdAt: new Date("2026-01-01T09:00:00Z"),
    finishedAt: new Date("2026-01-01T09:01:00Z"),
  });

test("the runs list names each Job's agent, and a deleted one as “<name> (Deleted)”", async () => {
  fake.runs.list.mockResolvedValue([job("run_1", "agent_1", null), job("run_2", null, "Order drafter (Deleted)")]);
  fake.workflows.list.mockResolvedValue([]);
  fake.agents.list.mockResolvedValue([agentRow({ id: "agent_1", name: "Clerk" })]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RunList />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Clerk")).toBeTruthy();
  expect(screen.getByText("Order drafter (Deleted)")).toBeTruthy();
});

test("the runs list is in French, and shows the built-in agent as Stem", async () => {
  const { I18nextProvider } = await import("react-i18next");
  const { createI18n } = await import("../../lib/i18n.ts");
  fake.runs.list.mockResolvedValue([job("run_1", "agent_1", null)]);
  fake.workflows.list.mockResolvedValue([]);
  fake.agents.list.mockResolvedValue([agentRow({ id: "agent_1", name: "Assistant", builtIn: "assistant" })]);
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RunList />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  expect(await screen.findByText("Stem")).toBeTruthy();
  expect(screen.getByText("échoué")).toBeTruthy();
  expect(screen.getByText("Manuel")).toBeTruthy();
  expect(screen.getByText(/1 janv\. 2026.* · 1 min 0 s/)).toBeTruthy();
});
