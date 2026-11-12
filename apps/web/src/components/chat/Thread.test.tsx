// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";
import "../../test/jsdom-shims.ts";

const fake = vi.hoisted(() => ({ questions: { answer: vi.fn() }, agents: { list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { ChatThread } = await import("./Thread.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
const message = (id: string, role: "assistant" | "user" | "tool", text: string, s: number) => ({ id, role, text, createdAt: at(s), stepRunId: "s_chat", runId: "run_1" });
const choice = { kind: "choice" as const, questions: [{ question: "Who is it for?", header: "Who", options: [{ label: "Me" }, { label: "You" }], multiSelect: false }] };
const question = (id: string, s: number, extra: Record<string, unknown> = {}) => ({ id, runId: "run_1", stepRunId: "s_chat", placement: "chat", status: "pending", createdAt: at(s), about: null, proposalId: null, payload: choice, answer: null, ...extra });
const run = (messages: unknown[], questions: unknown[] = [], step = "running") =>
  ({ run: { id: "run_1", status: "running", error: null }, steps: [{ id: "s_chat", status: step, interactive: true, error: null }], messages, questions }) as unknown as RunSnapshot;

function mount(snapshot: RunSnapshot | null) {
  const view = (snap: RunSnapshot | null) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChatThread run={snap} chatStepId="s_chat" canSend onSend={async () => {}} />
    </QueryClientProvider>
  );
  const rendered = render(view(snapshot));
  return { user: userEvent.setup(), update: (snap: RunSnapshot) => rendered.rerender(view(snap)) };
}

test("the conversation shows in order, each message an item of the list: the owner's words, the agent's, the tools it used", () => {
  mount(run([message("m1", "user", "Plan my day", 1), message("m2", "assistant", "Let me look.", 2), message("m3", "tool", "Read", 3), message("m4", "assistant", "Done.", 4)]));
  const items = screen.getAllByRole("listitem");
  expect(items.map((i) => i.textContent)).toEqual(["Plan my day", "Let me look.", "Read", "Done."]);
  expect(screen.queryByText("Say hello to start.")).toBeNull();
});

test("nothing said yet invites to start; a conversation that failed before a word doesn't", () => {
  mount(run([]));
  expect(screen.getByText("Say hello to start.")).toBeTruthy();
  cleanup();
  mount(run([], [], "failed"));
  expect(screen.queryByText("Say hello to start.")).toBeNull();
});

test("a question of the chat is answered in place through questions.answer, and reads as answered once the run says so", async () => {
  fake.questions.answer.mockResolvedValue({});
  const asked = run([message("m1", "user", "Plan my day", 1)], [question("q1", 2)]);
  const { user, update } = mount(asked);
  const item = screen.getAllByRole("listitem")[1]!;
  expect(within(item).getByText("Who is it for?")).toBeTruthy();
  await user.click(within(item).getByRole("radio", { name: /Me/ }));
  await user.click(within(item).getByRole("button", { name: /Answer|Send|Continue/ }));
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledTimes(1));
  expect(fake.questions.answer.mock.calls[0]![0]).toMatchObject({ questionId: "q1", answer: { kind: "choice", answers: { "Who is it for?": "Me" } } });
  // Nothing is shown as answered until the run's own state says so.
  update(run([message("m1", "user", "Plan my day", 1)], [question("q1", 2, { status: "answered", answer: { kind: "choice", answers: { "Who is it for?": "Me" } } })]));
  expect(await screen.findByText("You answered Me")).toBeTruthy();
  expect(screen.queryByText("Who is it for?")).toBeNull();
});

test("a question answered elsewhere first says so instead of taking a second answer", async () => {
  fake.questions.answer.mockRejectedValue(Object.assign(new Error("This question is no longer waiting for an answer"), { code: "CONFLICT" }));
  const { user } = mount(run([], [question("q1", 1)]));
  await user.click(screen.getByRole("radio", { name: /Me/ }));
  await user.click(screen.getByRole("button", { name: /Answer|Send|Continue/ }));
  expect(await screen.findByText("This question was already answered elsewhere.")).toBeTruthy();
});

test("a proposal the run can't show is not answered in the chat: it sends the owner to the Inbox", () => {
  const payload = { kind: "permission", toolName: "request_approval", input: { message: "May I add a clerk?", proposal: "prop_1" }, canAlwaysAllow: false };
  mount(run([], [question("q1", 1, { payload, proposalId: "prop_1", proposal: null })]));
  expect(screen.getByRole("link", { name: /Inbox/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
});

test("a proposal in the chat shows every item whole, long instructions included, with no control of its own", () => {
  const payload = { kind: "permission", toolName: "request_approval", input: { message: "May I add a clerk?", proposal: "prop_1" }, canAlwaysAllow: false };
  const instructions = Array.from({ length: 400 }, (_, i) => `Rule ${i + 1}: file every letter of a client under its matter.`).join("\n");
  const proposal = { id: "prop_1", status: "asked", items: [{ tool: "agents_create", input: { name: "Clerk", systemPrompt: instructions }, used: false, refs: [] }], names: {} };
  mount(run([], [question("q1", 1, { payload, proposalId: "prop_1", proposal })]));
  const card = screen.getByRole("region", { name: "Proposal" });
  expect(within(card).getByText("Create an agent")).toBeTruthy();
  expect(within(card).getByText("May I add a clerk?")).toBeTruthy();
  expect(card.textContent).toContain(instructions);
  // Nothing in the card clips it: the thread scrolls.
  for (const el of [card, ...card.querySelectorAll("*")]) expect(el.className).not.toMatch(/max-h-|line-clamp|truncate|overflow-hidden/);
  expect(within(card).queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link", { name: /Inbox/ })).toBeNull();
});

test("two proposals waiting at once: each card answers its own, with every item shown", async () => {
  const ask = (id: string, words: string) => ({ kind: "permission", toolName: "request_approval", input: { message: words, proposal: id }, canAlwaysAllow: false });
  const view = (id: string, name: string) => ({ id, status: "asked", items: [{ tool: "agents_create", input: { name }, used: false, refs: [] }], names: {} });
  fake.questions.answer.mockResolvedValue(undefined);
  const { user } = mount(run([], [question("q1", 1, { payload: ask("prop_1", "Add a clerk"), proposalId: "prop_1", proposal: view("prop_1", "Clerk") }), question("q2", 2, { payload: ask("prop_2", "Add a typist"), proposalId: "prop_2", proposal: view("prop_2", "Typist") })]));
  expect(screen.queryByRole("region", { name: "Proposal" })).toBeNull();
  const second = screen.getAllByRole("listitem").find((li) => li.textContent?.includes("Add a typist"))!;
  expect(within(second).getByText("Typist")).toBeTruthy();
  await user.click(within(second).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledTimes(1));
  expect(fake.questions.answer.mock.calls[0]![0]).toMatchObject({ questionId: "q2", answer: { kind: "permission", decision: "allow" } });
});

test("a proposal answered says approved, or declined with the owner's words", () => {
  const payload = { kind: "permission", toolName: "request_approval", input: { message: "May I add a clerk?", proposal: "prop_1" }, canAlwaysAllow: false };
  mount(run([], [question("q1", 1, { payload, proposalId: "prop_1", proposal: null, status: "answered", answer: { kind: "permission", decision: "deny", message: "Only on Clients" } })]));
  expect(screen.getByText("You declined it: Only on Clients")).toBeTruthy();
});

test("copy actions copy the original message text, never a tool trace or question", async () => {
  const { user, update } = mount(run([message("m1", "user", "Hello", 1), message("m2", "assistant", "A **formatted** reply", 2), message("m3", "tool", "Read", 3)], [question("q1", 4)]));
  const copy = vi.spyOn(navigator.clipboard, "writeText");
  const actions = screen.getAllByRole("button", { name: "Copy message" });
  expect(actions).toHaveLength(2);
  await user.click(actions[1]!);
  expect(copy).toHaveBeenCalledWith("A **formatted** reply");
  expect(await screen.findByText("Copied")).toBeTruthy();
  await user.click(actions[0]!);
  expect(copy).toHaveBeenLastCalledWith("Hello");
  // A running Job can be between turns; copy stays available, including after a text delta.
  update(run([message("m1", "user", "Hello", 1), message("m2", "assistant", "A **formatted** reply, continued", 2)]));
  await user.click(screen.getAllByRole("button", { name: "Copy message" })[1]!);
  expect(copy).toHaveBeenLastCalledWith("A **formatted** reply, continued");
});

test("a consult shows as a line naming the agent, with no control to answer it", async () => {
  fake.agents.list.mockResolvedValue([{ id: "agent_2", name: "Architect" }]);
  const consult = (status: string, answer: unknown = null) => question("q1", 2, { status, payload: { kind: "consult", agentId: "agent_2", question: "Which plan?" }, answer });
  const { update } = mount(run([message("m1", "user", "Plan my day", 1)], [consult("pending")]));
  expect(await screen.findByText("Consulting Architect…")).toBeTruthy();
  const item = screen.getAllByRole("listitem")[1]!;
  expect(within(item).queryByRole("button")).toBeNull();
  expect(screen.queryByText("Which plan?")).toBeNull();
  update(run([message("m1", "user", "Plan my day", 1)], [consult("answered", { kind: "consult", outcome: "answered", text: "Plan B." })]));
  expect(await screen.findByText("Consulted Architect")).toBeTruthy();
  update(run([message("m1", "user", "Plan my day", 1)], [consult("answered", { kind: "consult", outcome: "failed", text: "The consulted Job failed" })]));
  expect(await screen.findByText("Architect gave no answer")).toBeTruthy();
});
