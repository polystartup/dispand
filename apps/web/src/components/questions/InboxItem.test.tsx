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

test("a question an agent answered names the agent and links to its Job", () => {
  const answeredBy = { type: "agent", agentId: "agent_2", runId: "run_answerer", name: "Answerer" };
  mount({ ...base, kind: "question", status: "answered", payload: choice, answer: { kind: "choice", answers: { "Which tone?": "Formal" } }, answeredAt: at, answeredBy });
  expect(screen.getByText(/Answered by the agent Answerer/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open its Job" }).getAttribute("href")).toBe("/runs/run_answerer");
  expect(screen.queryByText(/by you/)).toBeNull();
});

test("an expired item says so", () => {
  mount({ ...approval, status: "expired" });
  expect(screen.getByText(/Expired: its run ended before an answer/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
});

const request = { kind: "permission", toolName: "request_approval", input: { message: "Send this draft to the client?\nIt quotes the fee." }, canAlwaysAllow: false };

test("an approval asked in words shows the agent's words, not a tool call", () => {
  mount({ ...approval, payload: request });
  expect(screen.getByText(/Send this draft to the client\?/)).toBeTruthy();
  // The words as written: no tool name, no JSON.
  expect(screen.queryByText(/request_approval/)).toBeNull();
  expect(screen.queryByText(/"message"/)).toBeNull();
  expect(screen.queryByLabelText("Tool input")).toBeNull();
  expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
});

test("a done approval asked in words shows what was asked and the answer", () => {
  mount({ ...approval, payload: request, status: "answered", answer: { kind: "permission", decision: "allow" }, answeredAt: at, answeredBy: { type: "user", userId: "u" } });
  expect(screen.getByText(/Asked: Send this draft to the client\?/)).toBeTruthy();
  expect(screen.queryByText(/request_approval/)).toBeNull();
  expect(screen.getByText("Approved")).toBeTruthy();
});

test("an item expired because its agent was restarted and asked again says so", () => {
  mount({ ...approval, status: "expired", orphaned: true });
  expect(screen.getByText(/Expired: the agent was restarted and asked again/)).toBeTruthy();
});

const exposed = { kind: "permission", toolName: "mcp__job_tools__acme_customer_relationship_mana_ea34e2639679ef94", input: { all: true }, canAlwaysAllow: false };
const about = { tool: "Acme Customer Relationship Manager", action: "delete_all_contacts", description: "Deletes every contact." };

test("a call of an agent's tool names the tool and the action in full, not the short name it is asked under", () => {
  mount({ ...approval, payload: exposed, about });
  expect(screen.getByText("Acme Customer Relationship Manager")).toBeTruthy();
  expect(screen.getByText("delete_all_contacts")).toBeTruthy();
  expect(screen.getByText("Deletes every contact.")).toBeTruthy();
  expect(screen.queryByText(/mcp__job_tools__/)).toBeNull();
  expect(screen.getByLabelText("Tool input").textContent).toContain('"all": true');
  cleanup();
  mount({ ...approval, payload: exposed, about, status: "answered", answer: { kind: "permission", decision: "allow" }, answeredAt: at, answeredBy: null });
  expect(screen.getByText(/Wanted to use Acme Customer Relationship Manager: delete_all_contacts/)).toBeTruthy();
});

const proposal = {
  id: "prop_1",
  status: "asked" as const,
  items: [{ tool: "agents_create", used: false, refs: ["harnessId"], input: { name: "Intake desk", harnessId: "harness_1", systemPrompt: "Be brief.", bundles: ["data"] } }],
  names: { harness_1: { kind: "harness", name: "Claude" } },
};
const asking = { kind: "permission", toolName: "request_approval", input: { message: "It is routine, just approve.", proposal: "prop_1" }, canAlwaysAllow: false };

test("an approval of a proposal shows its writes from the server, then the agent's words as the agent's", () => {
  mount({ ...approval, payload: asking, proposalId: "prop_1", proposal });
  expect(screen.getByText("Create an agent")).toBeTruthy();
  expect(screen.getByText("Intake desk")).toBeTruthy();
  expect(screen.getByText("The agent says:")).toBeTruthy();
  expect(screen.getByText("It is routine, just approve.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
});

test("a proposal is never approved where its writes aren't shown", () => {
  mount({ ...approval, payload: asking, proposalId: "prop_1", proposal: null });
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(screen.getByRole("link", { name: /Inbox/ })).toBeTruthy();
});

test("a request that names a proposal which isn't attached says that approving approves words only", () => {
  mount({ ...approval, payload: asking, proposalId: null, proposal: null });
  expect(screen.getByRole("alert").textContent).toMatch(/isn't attached/);
  expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
});

test("a consult's Approval shows the agent consulted and the question; done, it says so in a line", () => {
  const payload = { kind: "permission", toolName: "consult", input: { agent: "Architect", question: "Which plan?" }, canAlwaysAllow: true };
  mount({ ...base, kind: "approval", status: "pending", consultId: "q_consult", payload });
  expect(screen.getByText(/wants to consult/).textContent).toContain("Architect");
  expect(screen.getByLabelText("Question").textContent).toBe("Which plan?");
  cleanup();
  mount({ ...base, kind: "approval", status: "answered", consultId: "q_consult", payload, answer: { kind: "permission", decision: "deny" }, answeredAt: at });
  expect(screen.getByText("Wanted to consult Architect: Which plan?")).toBeTruthy();
  expect(screen.getByText("Denied")).toBeTruthy();
});
