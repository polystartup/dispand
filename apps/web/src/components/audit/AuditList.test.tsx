// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ audit: { list: vi.fn(), traceUrl: vi.fn() }, agents: { list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: unknown; params: { runId: string } }) => <a href={`/runs/${params.runId}`}>{children as string}</a>,
}));
const { AuditList, JobAudit } = await import("./AuditList.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  ownerId: "user_1",
  at: "2026-11-12T10:00:00.123456Z",
  actor: { type: "job", runId: "run_1" },
  actorAgentId: "agent_1",
  jobId: "run_1",
  action: "job.started",
  resourceType: "job",
  resourceId: "run_1",
  result: "ok",
  details: { harnessId: "hrn_1", harnessName: "Claude" },
  traceId: "0af7651916cd43dd8448eb211c80319c",
  ...extra,
});

function mount(node: React.ReactNode) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
}

test("the Job page's Audit lists its rows: the action in words, the agent and its Job, the details and the trace id", async () => {
  const user = userEvent.setup();
  fake.agents.list.mockResolvedValue([{ id: "agent_1", name: "Writer" }]);
  fake.audit.traceUrl.mockResolvedValue({ traceUrl: null });
  fake.audit.list.mockResolvedValue({ rows: [row("aud_1"), row("aud_2", { action: "job.failed", result: "failed", details: { reason: "stopped" } })], next: null });
  mount(<JobAudit jobId="run_1" live={false} />);
  const section = await screen.findByRole("region", { name: "Audit" });
  expect(await within(section).findByText("Job started")).toBeTruthy();
  expect(fake.audit.list.mock.calls[0]![0]).toEqual({ jobId: "run_1" });
  const [started, failed] = within(section).getAllByRole("listitem");
  expect(within(started!).getByText(/Writer/)).toBeTruthy();
  expect(within(started!).getByRole("link", { name: "its Job" }).getAttribute("href")).toBe("/runs/run_1");
  expect(within(started!).getByText("Harness")).toBeTruthy();
  expect(within(started!).getByText("Claude")).toBeTruthy();
  expect(within(started!).getByText("0af7651916cd43dd8448eb211c80319c")).toBeTruthy();
  // No trace link without DISPAND_TRACE_URL: the id only, to copy.
  expect(within(started!).queryByRole("link", { name: "0af7651916cd43dd8448eb211c80319c" })).toBeNull();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await user.click(within(started!).getByRole("button", { name: "Copy the trace id" }));
  expect(copy).toHaveBeenCalledWith("0af7651916cd43dd8448eb211c80319c");
  expect(within(failed!).getByText("Job failed")).toBeTruthy();
  expect(within(failed!).getByText("failed")).toBeTruthy();
  expect(within(failed!).getByText("stopped")).toBeTruthy();
});

test("with DISPAND_TRACE_URL set, the trace id links there", async () => {
  fake.agents.list.mockResolvedValue([]);
  fake.audit.traceUrl.mockResolvedValue({ traceUrl: "https://traces.example.com/trace/{traceId}?view=1" });
  fake.audit.list.mockResolvedValue({ rows: [row("aud_1")], next: null });
  mount(<AuditList />);
  const link = await screen.findByRole("link", { name: "0af7651916cd43dd8448eb211c80319c" });
  expect(link.getAttribute("href")).toBe("https://traces.example.com/trace/0af7651916cd43dd8448eb211c80319c?view=1");
  expect(link.getAttribute("rel")).toContain("noreferrer");
});

test("the Audit page reads the next page on Load more, and names the scheduler and a person", async () => {
  fake.agents.list.mockResolvedValue([{ id: "agent_1", name: "Writer" }]);
  fake.audit.traceUrl.mockResolvedValue({ traceUrl: null });
  fake.audit.list
    .mockResolvedValueOnce({ rows: [row("aud_1", { actor: { type: "user", userId: "user_1" }, action: "job.created", traceId: null })], next: "c1" })
    .mockResolvedValueOnce({ rows: [row("aud_2", { actor: { type: "scheduler" }, jobId: null, action: "job.skipped", resourceType: "trigger", resourceId: "trg_1", details: { reason: "skipped-overlap" } })], next: null });
  mount(<AuditList />);
  expect(await screen.findByText("Job created")).toBeTruthy();
  expect(screen.getByText("You")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("No Job started")).toBeTruthy();
  expect(screen.getByText("Scheduler · for Writer")).toBeTruthy();
  expect(fake.audit.list.mock.calls[1]![0]).toEqual({ cursor: "c1" });
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("nothing recorded says so", async () => {
  fake.agents.list.mockResolvedValue([]);
  fake.audit.traceUrl.mockResolvedValue({ traceUrl: null });
  fake.audit.list.mockResolvedValue({ rows: [], next: null });
  mount(<AuditList />);
  expect(await screen.findByText("Nothing recorded yet")).toBeTruthy();
});

test("a Job's Audit is read once more when the Job ends", async () => {
  fake.agents.list.mockResolvedValue([]);
  fake.audit.traceUrl.mockResolvedValue({ traceUrl: null });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (live: boolean) => (
    <QueryClientProvider client={queries}>
      <JobAudit jobId="run_1" live={live} />
    </QueryClientProvider>
  );
  fake.audit.list.mockResolvedValue({ rows: [row("aud_1")], next: null });
  const { rerender } = render(view(true));
  expect(await screen.findByText("Job started")).toBeTruthy();
  fake.audit.list.mockResolvedValue({ rows: [row("aud_2", { action: "job.finished", details: {} }), row("aud_1")], next: null });
  rerender(view(false));
  expect(await screen.findByText("Job finished")).toBeTruthy();
});
