// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ runs: { list: vi.fn() }, workflows: { list: vi.fn() }, agents: { list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));
const { RunList } = await import("./Runs.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const job = (id: string, agentId: string | null, deletedAgentName: string | null) => ({
  id,
  source: "agent",
  workflowId: null,
  agentId,
  deletedAgentName,
  triggerId: null,
  version: 0,
  status: "failed",
  trigger: { type: "manual" },
  error: "Stopped",
  createdAt: new Date("2026-01-01T09:00:00Z"),
  finishedAt: new Date("2026-01-01T09:01:00Z"),
  queued: false,
  title: null,
  waitingOn: null,
  consultedBy: null,
});

test("the runs list names each Job's agent, and a deleted one as “<name> (Deleted)”", async () => {
  fake.runs.list.mockResolvedValue([job("run_1", "agent_1", null), job("run_2", null, "Order drafter (Deleted)")]);
  fake.workflows.list.mockResolvedValue([]);
  fake.agents.list.mockResolvedValue([{ id: "agent_1", name: "Clerk" }]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RunList />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Clerk")).toBeTruthy();
  expect(screen.getByText("Order drafter (Deleted)")).toBeTruthy();
});
