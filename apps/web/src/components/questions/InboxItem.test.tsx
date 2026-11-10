// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ questions: { answer: vi.fn(), list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, params }: { children: unknown; params?: { runId?: string } }) => <a href={`/runs/${params?.runId ?? ""}`}>{children as never}</a> }));
const { InboxItem } = await import("./InboxItem.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const at = new Date("2026-11-05T09:00:00Z");
const base = {
  id: "q_1",
  runId: "run_abcdef",
  stepRunId: "s_1",
  placement: "notifications",
  createdAt: at,
  orphaned: false,
  workflow: null,
  agent: { id: "agent_1", name: "Clerk" },
  trigger: { id: "trigger_1", name: "Mail" },
  run: { id: "run_abcdef" },
  step: { name: "Clerk" },
  answer: null,
  answeredAt: null,
  answeredBy: null,
};
const approval = { ...base, kind: "approval", status: "pending", payload: { kind: "permission", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: false } };
const choice = { kind: "choice", questions: [{ question: "Which tone?", header: "Tone", options: [{ label: "Formal" }, { label: "Casual" }], multiSelect: false }] };

function mount(item: unknown) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InboxItem item={item as never} />
    </QueryClientProvider>,
  );
}

test("an open approval shows its tag, where it comes from and its form", () => {
  mount(approval);
  expect(screen.getByText("Approval")).toBeTruthy();
  // The agent, then its trigger; the Job's step carries the agent's name and isn't repeated.
  expect(screen.getAllByText("Clerk")).toHaveLength(1);
  expect(screen.getByText("Mail")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Open the run/ }).getAttribute("href")).toBe("/runs/run_abcdef");
});

test("an open question is tagged a question", () => {
  mount({ ...base, kind: "question", status: "pending", payload: choice });
  expect(screen.getByText("Question")).toBeTruthy();
  expect(screen.getByText("Which tone?")).toBeTruthy();
});

test("a done item shows the answer and who answered, and no form", () => {
  mount({ ...approval, status: "answered", answer: { kind: "permission", decision: "deny", message: "not now" }, answeredAt: at, answeredBy: { type: "user", userId: "u" } });
  expect(screen.getByText("Denied: not now")).toBeTruthy();
  expect(screen.getByText(/Answered by you/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  cleanup();
  mount({ ...base, kind: "question", status: "answered", payload: choice, answer: { kind: "choice", answers: { "Which tone?": "Formal" } }, answeredAt: at, answeredBy: null });
  expect(screen.getByText("“Which tone?”: Formal")).toBeTruthy();
  // An answer from before answerers were recorded names nobody.
  expect(screen.getByText(/^Answered/).textContent).not.toMatch(/by you/);
});

test("an expired item says so", () => {
  mount({ ...approval, status: "expired" });
  expect(screen.getByText(/Expired: its run ended before an answer/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
});
