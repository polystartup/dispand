// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ runs: { list: vi.fn() }, triggers: { list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));
const { JobList } = await import("./JobList.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const job = (id: string, triggerId: string | null, status: string, createdAt: string, title: string | null = null) => ({
  id,
  source: "agent",
  workflowId: null,
  agentId: "agent_1",
  triggerId,
  version: 0,
  status,
  trigger: { type: "manual" },
  error: null,
  createdAt: new Date(createdAt),
  finishedAt: status === "succeeded" ? new Date(createdAt) : null,
  queued: false,
  title,
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <JobList agentId="agent_1" />
    </QueryClientProvider>,
  );
}

test("JobList shows the agent's Jobs newest first with their trigger name", async () => {
  // As `runs.list` gives them: newest first.
  fake.runs.list.mockResolvedValue([job("run_2", "trigger_1", "running", "2026-11-05T10:00:00Z"), job("run_1", null, "succeeded", "2026-11-05T09:00:00Z")]);
  fake.triggers.list.mockResolvedValue([{ id: "trigger_1", name: "Morning mail" }]);
  mount();
  const rows = await screen.findAllByRole("listitem");
  expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Morning mail"), expect.stringContaining("Deleted trigger")]);
  expect(rows[0]!.textContent).toContain("running");
  expect(fake.runs.list.mock.calls[0]![0]).toEqual({ agentId: "agent_1" });
});

test("JobList names a chat Job by its first message", async () => {
  fake.runs.list.mockResolvedValue([job("run_1", "trigger_1", "running", "2026-11-05T10:00:00Z", "Which agents touch Matters?")]);
  fake.triggers.list.mockResolvedValue([{ id: "trigger_1", name: "Chat" }]);
  mount();
  const [row] = await screen.findAllByRole("listitem");
  expect(row!.textContent).toContain("Chat");
  expect(row!.textContent).toContain("Which agents touch Matters?");
});

test("JobList says when the agent has no Job yet", async () => {
  fake.runs.list.mockResolvedValue([]);
  fake.triggers.list.mockResolvedValue([]);
  mount();
  expect(await screen.findByText("No Job yet")).toBeTruthy();
});
