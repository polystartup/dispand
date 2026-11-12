// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ jobs: { consults: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: unknown; params: { runId: string } }) => <a href={`/runs/${params.runId}`}>{children as string}</a>,
}));
const { RunConsults } = await import("./RunConsults.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const asked = (state: string, extra: Record<string, unknown> = {}) => ({
  questionId: "q1",
  agentId: "agent_2",
  agent: "Architect",
  runId: "run_2",
  state,
  question: "Which plan?",
  answer: null,
  createdAt: new Date(),
  ...extra,
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function mount(live = false) {
  render(
    <QueryClientProvider client={client()}>
      <RunConsults runId="run_1" live={live} />
    </QueryClientProvider>,
  );
}

test("the asking Job's page shows the consult with its question, its answer and a link to the consulted Job", async () => {
  fake.jobs.consults.mockResolvedValue({ asked: [asked("answered", { answer: "Plan B." })], answering: null });
  mount();
  const section = await screen.findByRole("region", { name: "Consults" });
  expect(within(section).getByText(/Consulted Architect/)).toBeTruthy();
  expect(within(section).getByText("Which plan?")).toBeTruthy();
  expect(within(section).getByText("Answer")).toBeTruthy();
  expect(within(section).getByText("Plan B.")).toBeTruthy();
  expect(within(section).getByRole("link", { name: "Open its Job" }).getAttribute("href")).toBe("/runs/run_2");
  expect(fake.jobs.consults.mock.calls[0]![0]).toEqual({ runId: "run_1" });
});

test("a consult that got no answer says why, and one that made no Job has no link", async () => {
  fake.jobs.consults.mockResolvedValue({ asked: [asked("failed", { runId: null, answer: "Your agent may not consult this agent" })], answering: null });
  mount();
  expect(await screen.findByText("Why there is none")).toBeTruthy();
  expect(screen.getByText("Your agent may not consult this agent")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

test("the consulted Job's page shows who asked, the question and a link to the asking Job", async () => {
  fake.jobs.consults.mockResolvedValue({ asked: [], answering: { runId: "run_0", agentId: "agent_1", agent: "Asker", question: "Which plan?" } });
  mount();
  const section = await screen.findByRole("region", { name: "Consults" });
  expect(within(section).getByText(/Consulted by Asker/)).toBeTruthy();
  expect(within(section).getByText("Which plan?")).toBeTruthy();
  expect(within(section).getByRole("link", { name: "Open its Job" }).getAttribute("href")).toBe("/runs/run_0");
});

test("a Job with no consult shows nothing", async () => {
  fake.jobs.consults.mockResolvedValue({ asked: [], answering: null });
  mount();
  await vi.waitFor(() => expect(fake.jobs.consults).toHaveBeenCalled());
  expect(screen.queryByRole("region")).toBeNull();
});

test("the Job ending reads its consults once more", async () => {
  const queries = client();
  const view = (live: boolean) => (
    <QueryClientProvider client={queries}>
      <RunConsults runId="run_1" live={live} />
    </QueryClientProvider>
  );
  fake.jobs.consults.mockResolvedValue({ asked: [asked("waiting")], answering: null });
  const { rerender } = render(view(true));
  expect(await screen.findByText("waiting")).toBeTruthy();
  fake.jobs.consults.mockResolvedValue({ asked: [asked("ended")], answering: null });
  rerender(view(false));
  expect(await screen.findByText("ended")).toBeTruthy();
});
