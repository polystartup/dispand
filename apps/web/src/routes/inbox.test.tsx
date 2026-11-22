// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ questions: { list: vi.fn(), answer: vi.fn() }, plugins: { resolveConflict: vi.fn() }, agents: { list: vi.fn() } as Record<string, unknown>, tools: {}, triggers: {} }));
vi.mock("../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { search, navigate } = vi.hoisted(() => ({ search: {} as { actor?: string }, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => unknown }) => ({ options, useSearch: () => search, useNavigate: () => navigate }),
  Link: ({ children }: { children: unknown }) => <a href="/">{children as string}</a>,
}));
const { Route } = await import("./_app.inbox.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  delete search.actor;
});

const table = { id: "c1", kind: "table", elementId: "tbl_1", name: "Matters", field: "changes", status: "approval", mine: [], next: { definition: {}, changes: [{ key: "remove:Conclusions", kind: "remove", field: "Conclusions", ticked: false }] }, merged: { keys: ["remove:Conclusions"], values: { "remove:Conclusions": { count: 1, shown: [["row_1", "Settled."]], digest: "d" } } }, reviewed: "r_c1" };
const approval = (status: string, items: unknown[]) => ({
  id: "q_1",
  runId: "run_1",
  stepRunId: null,
  placement: "notifications",
  createdAt: new Date("2026-11-16T09:00:00Z"),
  orphaned: false,
  workflow: null,
  agent: { id: "agent_stem", name: "Stem", builtIn: "assistant" },
  trigger: null,
  run: { id: "run_1" },
  step: { name: "Stem" },
  kind: "approval",
  status,
  payload: { kind: "permission", toolName: "plugin_update", input: { pluginId: "plugin_1" }, canAlwaysAllow: false },
  answer: status === "answered" ? { kind: "permission", decision: "allow" } : null,
  answeredAt: status === "answered" ? new Date("2026-11-16T09:05:00Z") : null,
  answeredBy: status === "answered" ? { type: "user", userId: "u" } : null,
  proposal: null,
  update: { plugin: { id: "plugin_1", name: "law-firm" }, items },
});

test("what an answer to a plugin update's last item couldn't make stays said once its Approval moves to Done", async () => {
  fake.questions.list.mockResolvedValueOnce([approval("pending", [table])]).mockResolvedValue([approval("answered", [])]);
  fake.plugins.resolveConflict.mockResolvedValue({ ok: true, stale: ["remove:Conclusions"] });
  const Page = (Route as unknown as { options: { component: () => React.JSX.Element } }).options.component;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Page />
    </QueryClientProvider>,
  );
  const item = await screen.findByRole("listitem", { name: "Matters: Changes" });
  await userEvent.click(within(item).getByRole("button", { name: "Accept Stem's" }));
  // Answered, the Approval is in Done now, a new card: the skipped change is still said there.
  const done = await screen.findByRole("region", { name: "Done" });
  expect(await within(done).findByText(/“Remove the field Conclusions” was skipped: the field changed since it was approved\./)).toBeTruthy();
});

test("an agent's inbox shows read-only, filtered by actor, and the actor stays in the address", async () => {
  search.actor = "agent_expert";
  fake.agents.list = vi.fn().mockResolvedValue([{ id: "agent_expert", name: "Expert" }, { id: "agent_other", name: "Other" }]);
  fake.questions.list.mockResolvedValue([
    { ...approval("pending", []), id: "q_c", kind: "consult", agent: { id: "agent_asker", name: "Asker" }, step: { name: "Asker" }, update: null, consultRunId: "run_c", payload: { kind: "consult", agentId: "agent_expert", question: "Which plan?" } },
  ]);
  const Page = (Route as unknown as { options: { component: () => React.JSX.Element } }).options.component;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Page />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Which plan?")).toBeTruthy();
  expect(fake.questions.list.mock.calls[0]![0]).toEqual({ status: "all", agentId: "agent_expert" });
  expect(screen.queryByRole("button", { name: /answer|allow|deny/i })).toBeNull();
  const select = (await screen.findByLabelText("Inbox of")) as HTMLSelectElement;
  await screen.findByRole("option", { name: "Other" });
  expect(select.value).toBe("agent_expert");
  await userEvent.selectOptions(select, "agent_other");
  expect(navigate).toHaveBeenLastCalledWith({ search: { actor: "agent_other" } });
  await userEvent.selectOptions(select, "");
  expect(navigate).toHaveBeenLastCalledWith({ search: {} });
});
