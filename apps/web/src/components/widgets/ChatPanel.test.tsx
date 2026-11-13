// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";
import "../../test/jsdom-shims.ts";

const fake = vi.hoisted(() => ({
  runs: { start: vi.fn(), sendChat: vi.fn(), stream: vi.fn(), list: vi.fn() },
  workflows: { get: vi.fn() },
  jobs: { start: vi.fn(), def: vi.fn() },
  questions: { answer: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});

const { ChatPanel } = await import("./ChatPanel.tsx");
// jsdom has no layout.
Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const at = new Date(0);
function snapshot(questions: RunSnapshot["questions"] = []): RunSnapshot {
  return {
    run: { id: "run_1", source: "workflow" as const, workflowId: "wf_1", agentId: null, deletedAgentName: null, triggerId: null, version: 1, status: questions.length ? "waiting" : "running", trigger: { type: "manual" }, error: null, createdAt: at, finishedAt: null },
    steps: [
      { id: "s_chat", runId: "run_1", nodeId: "n_chat", iteration: 0, status: questions.length ? "waiting" : "running", outputs: null, error: null, startedAt: at, finishedAt: null, queuedAt: null, interactive: true, prompt: null },
    ],
    messages: [],
    questions,
  };
}

/** A stream that sends the snapshot, then stays open until aborted. */
function streamOf(snap: RunSnapshot) {
  return async (_input: unknown, { signal }: { signal: AbortSignal }) =>
    (async function* () {
      yield { type: "snapshot" as const, ...snap };
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    })();
}

function Harness({ initial }: { initial: string | null }) {
  const [runId, setRunId] = useState(initial);
  return <ChatPanel workflowId="wf_1" runId={runId} onRunStarted={setRunId} onNewConversation={() => setRunId(null)} />;
}

function mount(initial: string | null) {
  fake.workflows.get.mockResolvedValue({ id: "wf_1", name: "Chat", version: 1, def: { trigger: { type: "manual", field: { id: "n_chat" } }, steps: [], edges: [] } });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

test("while the chat's question waits, sending is off with a hint", async () => {
  fake.runs.stream.mockImplementation(
    streamOf(
      snapshot([
        {
          id: "q1",
          about: null,
          proposalId: null,
          proposal: null,
          rootId: null,
          consultId: null,
          runId: "run_1",
          stepRunId: "s_chat",
          placement: "chat",
          status: "pending",
          answer: null,
          createdAt: at,
          payload: { kind: "choice", questions: [{ question: "Who?", header: "Who", options: [{ label: "Me" }], multiSelect: false }] },
        },
      ]),
    ),
  );
  mount("run_1");
  expect(await screen.findByText("Answer the question above to continue.")).toBeTruthy();
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").disabled).toBe(true);
});

test("a first message that fails after the run started is kept and goes to that run on retry", async () => {
  fake.runs.start.mockResolvedValue({ runId: "run_1" });
  fake.runs.sendChat.mockRejectedValueOnce(new Error("The runner is offline")).mockResolvedValueOnce(undefined);
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  const user = mount(null);
  await user.type(screen.getByLabelText("Message"), "Hello");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("Hello");

  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(2));
  expect(fake.runs.start).toHaveBeenCalledTimes(1);
  expect(fake.runs.sendChat.mock.calls.map((c) => c[0])).toEqual([
    { runId: "run_1", text: "Hello" },
    { runId: "run_1", text: "Hello" },
  ]);
  await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe(""));
});

test("what is typed while a message is sending stays in the composer", async () => {
  let finish!: () => void;
  fake.runs.sendChat.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  const user = mount("run_1");
  const box = await screen.findByLabelText<HTMLTextAreaElement>("Message");
  await user.type(box, "Hello");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(1));
  await user.type(box, " and more");
  finish();
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(box.value).toBe("Hello and more");
});

test("a chat that failed says why", async () => {
  const failed = snapshot();
  failed.run = { ...failed.run, status: "failed", error: "claude is not signed in" };
  failed.steps = [{ ...failed.steps[0]!, status: "failed", error: "claude is not signed in" }];
  fake.runs.stream.mockImplementation(streamOf(failed));
  mount("run_1");
  expect((await screen.findByRole("alert")).textContent).toContain("The conversation stopped: claude is not signed in");
  expect(screen.queryByText("Say hello to start.")).toBeNull();
});

test("a new conversation can't start while a message is on its way", async () => {
  let finish!: () => void;
  fake.runs.sendChat.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  const user = mount("run_1");
  await user.type(await screen.findByLabelText("Message"), "Hello");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(1));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "New conversation" }).disabled).toBe(true);
  finish();
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "New conversation" }).disabled).toBe(false));
});


test("Enter sends while the agent works; Shift+Enter adds a line, and a new conversation clears the draft", async () => {
  fake.runs.sendChat.mockResolvedValue(undefined);
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  const user = mount("run_1");
  const box = await screen.findByLabelText<HTMLTextAreaElement>("Message");
  await user.type(box, "First{Shift>}{Enter}{/Shift}Second");
  expect(box.value).toBe("First\nSecond");
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "First\nSecond" }));
  await waitFor(() => expect(box.value).toBe(""));
  await user.type(box, "Unsent");
  await user.click(screen.getByRole("button", { name: "New conversation" }));
  expect(box.value).toBe("");
});

const proposalPayload = { kind: "permission" as const, toolName: "request_approval", input: { message: "May I let Clerk answer questions?", proposal: "prop_1" }, canAlwaysAllow: false };
/** The chat's Approval of a proposal, with the proposal as the run shows it (`proposal: null`: one the thread can't show). */
function proposalQuestion(shown = true): RunSnapshot["questions"][number] {
  return {
    id: "q1",
    about: null,
    proposalId: "prop_1",
    proposal: shown ? { id: "prop_1", status: "asked", plugin: null, items: [{ tool: "agents_update", input: { id: "agt_1", name: "Clerk" }, used: false, failed: false, refs: ["id"], creates: null, createdId: null }], names: { agt_1: { kind: "agent", name: "Clerk" } } } : null,
    rootId: null,
    consultId: null,
    runId: "run_1",
    stepRunId: "s_chat",
    placement: "chat",
    status: "pending",
    answer: null,
    createdAt: at,
    payload: proposalPayload,
  };
}

test("Approve shows in the composer only while a proposal waits, and a click approves it", async () => {
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  mount("run_1");
  await screen.findByLabelText("Message");
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  cleanup();
  fake.runs.stream.mockImplementation(streamOf(snapshot([proposalQuestion()])));
  fake.questions.answer.mockResolvedValue(undefined);
  const user = mount("run_1");
  await user.click(await screen.findByRole("button", { name: "Approve" }));
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledTimes(1));
  expect(fake.questions.answer.mock.calls[0]![0]).toEqual({ questionId: "q1", answer: { kind: "permission", decision: "allow" } });
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
});

test("a proposal the thread can't show offers no Approve, and sending waits", async () => {
  fake.runs.stream.mockImplementation(streamOf(snapshot([proposalQuestion(false)])));
  mount("run_1");
  expect(await screen.findByText("Answer the question above to continue.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").disabled).toBe(true);
});

test("words sent while a proposal waits decline it with them, and never approve it", async () => {
  fake.runs.stream.mockImplementation(streamOf(snapshot([proposalQuestion()])));
  fake.questions.answer.mockResolvedValue(undefined);
  const user = mount("run_1");
  const box = await screen.findByLabelText<HTMLTextAreaElement>("Message");
  expect(box.disabled).toBe(false);
  expect(box.placeholder).toMatch(/declines the proposal/);
  // An empty send does nothing.
  await user.click(box);
  await user.keyboard("{Enter}");
  expect(fake.questions.answer).not.toHaveBeenCalled();
  // Words, even with the Approve shortcut, are sent as a decline.
  await user.type(box, "Approve, but only on Clients");
  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledTimes(1));
  expect(fake.questions.answer.mock.calls[0]![0]).toEqual({ questionId: "q1", answer: { kind: "permission", decision: "deny", message: "Approve, but only on Clients" } });
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  await waitFor(() => expect(box.value).toBe(""));
});

test("the shortcut on an empty composer approves", async () => {
  fake.runs.stream.mockImplementation(streamOf(snapshot([proposalQuestion()])));
  fake.questions.answer.mockResolvedValue(undefined);
  const user = mount("run_1");
  await user.click(await screen.findByLabelText("Message"));
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledTimes(1));
  expect(fake.questions.answer.mock.calls[0]![0]).toEqual({ questionId: "q1", answer: { kind: "permission", decision: "allow" } });
});

test("a proposal answered elsewhere first says so, and the words stay in the composer", async () => {
  fake.runs.stream.mockImplementation(streamOf(snapshot([proposalQuestion()])));
  fake.questions.answer.mockRejectedValue(Object.assign(new Error("This question is no longer waiting for an answer"), { code: "CONFLICT" }));
  const user = mount("run_1");
  const box = await screen.findByLabelText<HTMLTextAreaElement>("Message");
  await user.type(box, "Not this one");
  await user.keyboard("{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("This proposal was already answered elsewhere.");
  expect(box.value).toBe("Not this one");
  await user.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("alert").textContent).toBe("This proposal was already answered elsewhere.");
});

test("with two proposals waiting, the composer answers neither: each is answered on its card", async () => {
  fake.runs.stream.mockImplementation(streamOf(snapshot([proposalQuestion(), { ...proposalQuestion(), id: "q2", proposalId: "prop_2" }])));
  mount("run_1");
  expect(await screen.findByText("Answer the question above to continue.")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").disabled).toBe(true);
});

test("a finished Job with a recorded transcript sends to the same conversation", async () => {
  const snap = snapshot();
  snap.run = { ...snap.run, source: "agent", workflowId: null, agentId: "agent_1", status: "succeeded", finishedAt: at };
  snap.steps = snap.steps.map((s) => ({ ...s, status: "succeeded", finishedAt: at, resumable: true }));
  fake.runs.stream.mockImplementation(streamOf(snap));
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "n_chat", type: "chat" } }, steps: [], edges: [] });
  fake.runs.sendChat.mockResolvedValue(undefined);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatPanel runId="run_1" onRunStarted={() => {}} onNewConversation={() => {}} /></QueryClientProvider>);
  const user = userEvent.setup();
  const input = await screen.findByLabelText("Message");
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
  await user.type(input, "One more thing.");
  await user.click(screen.getByRole("button", { name: "Send", exact: true }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "One more thing." }));
  expect(fake.jobs.start).not.toHaveBeenCalled();
});
