// @vitest-environment jsdom
import { SHORT } from "@dispand/runner-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";
import "../../test/jsdom-shims.ts";

const fake = vi.hoisted(() => ({ questions: { answer: vi.fn() }, agents: { list: vi.fn() }, jobs: { consults: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { ChatThread, ChatTranscript } = await import("./Thread.tsx");
const { createI18n } = await import("../../lib/i18n.ts");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
const message = (id: string, role: "assistant" | "user" | "tool", text: string, s: number) => ({ id, role, text, createdAt: at(s), stepRunId: "s_chat", runId: "run_1" });
const choice = { kind: "choice" as const, questions: [{ question: "Who is it for?", header: "Who", options: [{ label: "Me" }, { label: "You" }], multiSelect: false }] };
const question = (id: string, s: number, extra: Record<string, unknown> = {}) => ({ id, runId: "run_1", stepRunId: "s_chat", placement: "chat", status: "pending", createdAt: at(s), about: null, proposalId: null, payload: choice, answer: null, ...extra });
const run = (messages: unknown[], questions: unknown[] = [], step = "running") =>
  ({ run: { id: "run_1", status: "running", error: null }, steps: [{ id: "s_chat", status: step, turnStatus: "unknown", turnId: null, interruptible: false, interactive: true, error: null }], messages, questions }) as unknown as RunSnapshot;

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

test("a proposal shows every item whole and edits revision feedback beneath its own actions", async () => {
  const payload = { kind: "permission", toolName: "request_approval", input: { message: "May I add a clerk?", proposal: "prop_1" }, canAlwaysAllow: false };
  const instructions = Array.from({ length: 400 }, (_, i) => `Rule ${i + 1}: file every letter of a client under its matter.`).join("\n");
  const proposal = { id: "prop_1", status: "asked", items: [{ tool: "agents_create", input: { name: "Clerk", systemPrompt: instructions }, used: false, refs: [] }], names: {} };
  const { user } = mount(run([], [question("q1", 1, { payload, proposalId: "prop_1", proposal })]));
  const card = screen.getByRole("region", { name: "Proposal" });
  expect(within(card).getByText("Create an agent")).toBeTruthy();
  expect(within(card).getByText("May I add a clerk?")).toBeTruthy();
  expect(card.textContent).toContain(instructions);
  // Nothing in the card clips it: the thread scrolls.
  for (const el of [card, ...card.querySelectorAll("*")]) expect(el.className).not.toMatch(/max-h-|line-clamp|truncate|overflow-hidden/);
  const request = within(card).getByRole("button", { name: "Request changes" });
  await user.click(request);
  const field = within(card).getByRole("textbox", { name: "What should change?" });
  expect(document.activeElement).toBe(field);
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(request);
  expect(fake.questions.answer).not.toHaveBeenCalled();
  await user.click(request);
  const send = within(card).getByRole("button", { name: "Send feedback" });
  expect(send).toHaveProperty("disabled", true);
  const editor = within(card).getByRole("textbox", { name: "What should change?" });
  await user.paste("x".repeat(SHORT + 1));
  expect(editor).toHaveProperty("value", "x".repeat(SHORT + 1));
  expect(send).toHaveProperty("disabled", true);
  expect(within(card).getByRole("alert").textContent).toContain("4,000");
  await user.clear(editor);
  await user.type(editor, "  Use client files only.  ");
  fake.questions.answer.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
  await user.click(send);
  expect((await within(card).findByRole("alert")).textContent).toBe("Offline");
  expect(document.activeElement).toBe(card);
  expect(editor).toHaveProperty("value", "  Use client files only.  ");
  await user.click(send);
  await waitFor(() => expect(send).toHaveProperty("disabled", true));
  expect(fake.questions.answer.mock.calls[1]![0]).toMatchObject({ questionId: "q1", answer: { kind: "permission", decision: "deny", message: "Use client files only." } });
  expect(screen.queryByRole("link", { name: /Inbox/ })).toBeNull();
});

test("two proposals waiting at once: each card answers its own, with every item shown", async () => {
  const ask = (id: string, words: string) => ({ kind: "permission", toolName: "request_approval", input: { message: words, proposal: id }, canAlwaysAllow: false });
  const view = (id: string, name: string) => ({ id, status: "asked", items: [{ tool: "agents_create", input: { name }, used: false, refs: [] }], names: {} });
  fake.questions.answer.mockResolvedValue(undefined);
  const { user } = mount(run([], [question("q1", 1, { payload: ask("prop_1", "Add a clerk"), proposalId: "prop_1", proposal: view("prop_1", "Clerk") }), question("q2", 2, { payload: ask("prop_2", "Add a typist"), proposalId: "prop_2", proposal: view("prop_2", "Typist") })]));
  const cards = screen.getAllByRole("region", { name: "Proposal" });
  expect(cards).toHaveLength(2);
  const second = cards.find((card) => card.textContent?.includes("Add a typist"))!;
  expect(within(second).getByText("Typist")).toBeTruthy();
  await user.click(within(second).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledTimes(1));
  expect(document.activeElement).toBe(second);
  expect(fake.questions.answer.mock.calls[0]![0]).toMatchObject({ questionId: "q2", answer: { kind: "permission", decision: "allow" } });
  // The Inbox can answer the other question before this card's decision reaches the server.
  fake.questions.answer.mockRejectedValueOnce(Object.assign(new Error("Already answered"), { code: "CONFLICT" }));
  const first = cards.find((card) => card.textContent?.includes("Add a clerk"))!;
  await user.click(within(first).getByRole("button", { name: "Decline" }));
  expect(await within(first).findByText("This question was already answered elsewhere.")).toBeTruthy();
  expect(document.activeElement).toBe(first);
  expect(within(first).getByText("Clerk")).toBeTruthy();
  expect(within(first).queryByRole("button")).toBeNull();
  expect(fake.questions.answer.mock.calls[1]![0]).toMatchObject({ questionId: "q1", answer: { kind: "permission", decision: "deny" } });
});

test("a proposal answered says approved, or declined with the owner's words", () => {
  const payload = { kind: "permission", toolName: "request_approval", input: { message: "May I add a clerk?", proposal: "prop_1" }, canAlwaysAllow: false };
  mount(run([], [question("q1", 1, { payload, proposalId: "prop_1", proposal: null, status: "answered", answer: { kind: "permission", decision: "deny", message: "Only on Clients" } })]));
  expect(screen.getByText("You declined it: Only on Clients")).toBeTruthy();
});

test.each(["allow", "deny"])("an answered proposal retains scope and item outcomes: %s", (decision) => {
  const payload = { kind: "permission", toolName: "request_approval", input: { message: "Add the clerks", proposal: "prop_1" }, canAlwaysAllow: false };
  const instructions = "Keep every original instruction.\n".repeat(100);
  const proposal = { id: "prop_1", status: "asked", items: [
    { tool: "agents_create", input: { name: "Clerk", systemPrompt: instructions }, used: false, refs: [] },
    { tool: "agents_create", input: { name: "Second" }, used: false, refs: [] },
    { tool: "agents_create", input: { name: "Third" }, used: false, refs: [] },
  ], names: {} };
  const q = question("q1", 1, { payload, proposalId: proposal.id, proposal });
  const { update } = mount(run([], [q]));
  // A decision arriving from another tab leaves focus on the owner's current work.
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  elsewhere.focus();
  update(run([], [{ ...q, status: "answered", answer: { kind: "permission", decision, message: "Only on Clients" }, proposal: {
    ...proposal, status: decision === "allow" ? "approved" : "declined",
    items: proposal.items.map((item, i) => ({ ...item, used: decision === "allow" && i < 2, failed: decision === "allow" && i === 1 })),
  } }]));
  const card = screen.getByRole("region", { name: "Proposal" });
  expect(document.activeElement).toBe(elsewhere);
  elsewhere.remove();
  expect(card.textContent).toContain(instructions.trim());
  expect(within(card).getByText(decision === "allow" ? "You approved it" : "You declined it: Only on Clients")).toBeTruthy();
  expect(within(card).queryByRole("button")).toBeNull();
  expect(within(card).getByText("Third")).toBeTruthy();
  if (decision === "allow") {
    expect(within(card).getByText("done")).toBeTruthy();
    expect(within(card).getByText("refused")).toBeTruthy();
    const last = within(card).getAllByRole("listitem")[2]!;
    expect(last.textContent).not.toMatch(/done|refused/);
  }
  expect(fake.questions.answer).not.toHaveBeenCalled();
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

test("a consult of a deleted agent names it as its consulted Job kept it", async () => {
  fake.agents.list.mockResolvedValue([]);
  fake.jobs.consults.mockResolvedValue({ asked: [{ questionId: "q1", agent: "Order drafter (Deleted)" }], answering: null });
  const consult = question("q1", 2, { status: "answered", payload: { kind: "consult", agentId: "agent_2", question: "Which plan?" }, answer: { kind: "consult", outcome: "answered", text: "Plan B." } });
  mount(run([message("m1", "user", "Plan my day", 1)], [consult]));
  expect(await screen.findByText("Consulted Order drafter (Deleted)")).toBeTruthy();
  expect(fake.jobs.consults).toHaveBeenCalledWith({ runId: "run_1" }, expect.anything());
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

test("the thread is in French: the invitation, a consult, an answer and the copy action", () => {
  fake.agents.list.mockResolvedValue([]);
  const view = (snap: RunSnapshot) => (
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient()}>
        <ChatThread run={snap} chatStepId="s_chat" canSend onSend={async () => {}} />
      </QueryClientProvider>
    </I18nextProvider>
  );
  const { unmount } = render(view(run([])));
  expect(screen.getByText("Dites bonjour pour commencer.")).toBeTruthy();
  unmount();
  render(view(run([message("m1", "assistant", "Bonjour", 1)], [question("q1", 2, { status: "answered", answer: { kind: "choice", answers: { "Who is it for?": ["Me", "You"] } } })])));
  expect(screen.getByRole("button", { name: "Copier le message" })).toBeTruthy();
  expect(screen.getByText("Vous avez répondu Me et You")).toBeTruthy();
});

test("consecutive tool calls collapse together without hiding a question or the agent's result", async () => {
  const { user, update } = mount(run([
    message("m1", "tool", "Read", 1),
    message("m2", "tool", "Search", 2),
    message("m3", "assistant", "Here is the result.", 4),
    message("m4", "tool", "Write", 5),
  ], [question("q1", 3)]));
  const toggle = screen.getByRole("button", { name: "2 tool calls" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Read")).toBeNull();
  expect(screen.queryByText("Search")).toBeNull();
  expect(screen.getByText("Who is it for?")).toBeTruthy();
  expect(screen.getByText("Here is the result.")).toBeTruthy();
  expect(screen.getByText("Write")).toBeTruthy();
  await user.click(toggle);
  expect(screen.getByText("Read")).toBeTruthy();
  expect(screen.getByText("Search")).toBeTruthy();
  update(run([
    message("m1", "tool", "Read", 1),
    message("m2", "tool", "Search", 2),
    message("m3", "assistant", "Here is the result, updated.", 4),
    message("m4", "tool", "Write", 5),
  ], [question("q1", 3)]));
  expect(screen.getByRole("button", { name: "2 tool calls" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Search")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "2 tool calls" }));
  expect(screen.queryByText("Search")).toBeNull();
  expect(screen.getByText("Who is it for?")).toBeTruthy();
});

test("a failed consult remains visible between separate tool groups", async () => {
  fake.agents.list.mockResolvedValue([{ id: "agent_2", name: "Architect" }]);
  mount(run([
    message("m1", "tool", "Read", 1), message("m2", "tool", "Search", 2),
    message("m3", "tool", "Write", 4), message("m4", "tool", "Inspect", 5),
  ], [question("q1", 3, {
    status: "answered", payload: { kind: "consult", agentId: "agent_2", question: "Which plan?" },
    answer: { kind: "consult", outcome: "failed", text: "The consulted Job failed" },
  })]));
  expect(await screen.findByText("Architect gave no answer")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "2 tool calls" })).toHaveLength(2);
});


test("saved record results stay visible between routine traces and render untrusted values as text", async () => {
  const saved = { ...message("record", "tool", "rows_get", 3), result: {
    toolCallId: "call_1", turnId: "turn_1", args: { id: "row_1" },
    record: { kind: "record", tableId: "table_1", rowId: "row_1", fields: [
      { id: "name", name: "<img src=x onerror=alert(1)>", type: "text", value: "<script>alert(1)</script>" },
      { id: "link", name: "Website", type: "url", value: "javascript:alert(1)" },
      { id: "count", name: "Count", type: "number", value: 0 },
      { id: "active", name: "Active", type: "checkbox", value: false },
      { id: "missing", name: "Related record", type: "reference", value: null },
      { id: "files", name: "Files", type: "attachment", value: ["report.pdf", "notes.txt"] },
    ] },
  } };
  const snap = run([message("t1", "tool", "Read", 1), message("t2", "tool", "Search", 2), saved, message("t3", "tool", "Inspect", 4), message("t4", "tool", "Check", 5)]);
  const { user } = mount(snap);
  expect(screen.getAllByRole("button", { name: "2 tool calls" })).toHaveLength(2);
  const toggle = screen.getByRole("button", { name: "Record result" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  expect(screen.getByText("javascript:alert(1)")).toBeTruthy();
  expect(screen.getByText("0")).toBeTruthy();
  expect(screen.getByText("No")).toBeTruthy();
  expect(screen.getByText("Empty")).toBeTruthy();
  expect(screen.getByText(/report.pdf/).textContent).toBe("report.pdf\nnotes.txt");
  expect(document.querySelector("script, img, a[href]")).toBeNull();
  toggle.focus();
  await user.keyboard("{Enter}");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await user.keyboard(" ");
  expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
  cleanup();
  render(<ChatTranscript messages={snap.messages} />);
  expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
  expect(fake.questions.answer).not.toHaveBeenCalled();
  expect(fake.agents.list).not.toHaveBeenCalled();
  expect(fake.jobs.consults).not.toHaveBeenCalled();
});

test("old rows_get traces remain readable and an empty saved record is explicit", () => {
  mount(run([message("old", "tool", "rows_get", 1), { ...message("new", "tool", "rows_get", 2), result: {
    toolCallId: "call_1", turnId: "turn_1", args: { id: "row_1" },
    record: { kind: "record", tableId: "table_1", rowId: "row_1", fields: [] },
  } }]));
  expect(screen.getByText("rows_get")).toBeTruthy();
  expect(screen.getByText("This record has no saved fields.")).toBeTruthy();
});

test("read-only transcripts use the same tool disclosure", async () => {
  const user = userEvent.setup();
  render(<ChatTranscript messages={[
    message("m1", "tool", "Read", 1), message("m2", "tool", "Search", 2),
    message("m3", "assistant", "The result.", 3),
  ] as RunSnapshot["messages"]} />);
  expect(screen.getByText("The result.")).toBeTruthy();
  expect(screen.queryByText("Search")).toBeNull();
  await user.click(screen.getByRole("button", { name: "2 tool calls" }));
  expect(screen.getByText("Read")).toBeTruthy();
  expect(screen.getByText("Search")).toBeTruthy();
});
