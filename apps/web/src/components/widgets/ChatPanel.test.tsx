// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useAui } from "@assistant-ui/react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";
import "../../test/jsdom-shims.ts";

const fake = vi.hoisted(() => ({
  assistantCommands: vi.fn(),
  runs: { start: vi.fn(), sendChat: vi.fn(), steerQueued: vi.fn(), editQueued: vi.fn(), removeQueued: vi.fn(), interruptChat: vi.fn(), get: vi.fn(), stream: vi.fn(), list: vi.fn() },
  workflows: { get: vi.fn() },
  jobs: { start: vi.fn(), def: vi.fn() },
  questions: { answer: vi.fn() },
  files: { hold: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});

const { ChatPanel } = await import("./ChatPanel.tsx");
const { ChatSessionsProvider } = await import("../../lib/chat-sessions.tsx");
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
      { id: "s_chat", runId: "run_1", nodeId: "n_chat", iteration: 0, status: questions.length ? "waiting" : "running", turnStatus: "unknown", turnId: null, interruptible: false, outputs: null, error: null, startedAt: at, finishedAt: null, queuedAt: null, interactive: true, prompt: null },
    ],
    messages: [],
    questions,
    queue: [],
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
  return <ChatPanel surfaceKey="test" workflowId="wf_1" runId={runId} onRunStarted={setRunId} onNewConversation={() => setRunId(null)} />;
}

function mount(initial: string | null) {
  fake.workflows.get.mockResolvedValue({ id: "wf_1", name: "Chat", version: 1, def: { trigger: { type: "manual", field: { id: "n_chat" } }, steps: [], edges: [] } });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider>
      <Harness initial={initial} />
    </ChatSessionsProvider></QueryClientProvider>,
  );
  return userEvent.setup();
}

test.each([
  { turnStatus: "unknown" as const, interruptible: true, turnId: "turn_1" },
  { turnStatus: "idle" as const, interruptible: true, turnId: "turn_1" },
  { turnStatus: "running" as const, interruptible: false, turnId: "turn_1" },
  { turnStatus: "running" as const, interruptible: true, turnId: null },
  { turnStatus: "running" as const, interruptible: true, turnId: "turn_1", status: "succeeded" },
])("Stop requires a known supported active turn: %j", async (turn) => {
  const snap = snapshot();
  Object.assign(snap.steps[0]!, turn);
  fake.runs.stream.mockImplementation(streamOf(snap));
  mount("run_1");
  await screen.findByLabelText("Message");
  expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
});

test("Stop targets the current turn, keeps the draft, and can retry a failed request", async () => {
  const snap = snapshot();
  Object.assign(snap.steps[0]!, { turnStatus: "running", turnId: "turn_1", interruptible: true });
  fake.runs.stream.mockImplementation(streamOf(snap));
  let fail!: (error: Error) => void;
  fake.runs.interruptChat.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; })).mockResolvedValue({ outcome: "requested" });
  const user = mount("run_1");
  const stop = await screen.findByRole<HTMLButtonElement>("button", { name: "Stop response" });
  const box = screen.getByLabelText<HTMLTextAreaElement>("Message");
  await user.type(box, "Keep this draft");
  await user.click(stop);
  expect(stop.disabled).toBe(true);
  await user.click(stop);
  expect(fake.runs.interruptChat).toHaveBeenCalledTimes(1);
  expect(fake.runs.interruptChat).toHaveBeenCalledWith({ runId: "run_1", turnId: "turn_1" });
  await user.type(box, " while stopping");
  fail(new Error("Internal transport detail"));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not stop the response. Try again.");
  expect(box.value).toBe("Keep this draft while stopping");
  await user.click(stop);
  await waitFor(() => expect(fake.runs.interruptChat).toHaveBeenCalledTimes(2));
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  expect(fake.questions.answer).not.toHaveBeenCalled();
  expect(box.value).toBe("Keep this draft while stopping");
});

test("a stale Stop refreshes the current turn instead of leaving a stale control", async () => {
  const snap = snapshot();
  Object.assign(snap.steps[0]!, { turnStatus: "running", turnId: "turn_1", interruptible: true });
  fake.runs.stream.mockImplementation(streamOf(snap));
  const idle = snapshot();
  Object.assign(idle.steps[0]!, { turnStatus: "idle" });
  fake.runs.get.mockResolvedValue(idle);
  fake.runs.interruptChat.mockResolvedValue({ outcome: "stale" });
  const user = mount("run_1");
  await user.click(await screen.findByRole("button", { name: "Stop response" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull());
  expect(fake.runs.get).toHaveBeenCalledWith({ runId: "run_1" }, expect.anything());
});

test("a refused Stop reports a localized retryable error", async () => {
  const snap = snapshot();
  Object.assign(snap.steps[0]!, { turnStatus: "running", turnId: "turn_1", interruptible: true });
  fake.runs.stream.mockImplementation(streamOf(snap));
  fake.runs.interruptChat.mockResolvedValue({ outcome: "failed" });
  const user = mount("run_1");
  await user.click(await screen.findByRole("button", { name: "Stop response" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not stop the response. Try again.");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop response" }).disabled).toBe(false);
});

test("Stop while an approval waits never answers or approves it", async () => {
  const snap = snapshot([proposalQuestion()]);
  Object.assign(snap.steps[0]!, { turnStatus: "running", turnId: "turn_1", interruptible: true });
  fake.runs.stream.mockImplementation(streamOf(snap));
  fake.runs.interruptChat.mockResolvedValue({ outcome: "requested" });
  const user = mount("run_1");
  await user.click(await screen.findByRole("button", { name: "Stop response" }));
  expect(fake.runs.interruptChat).toHaveBeenCalledWith({ runId: "run_1", turnId: "turn_1" });
  expect(fake.questions.answer).not.toHaveBeenCalled();
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  fake.questions.answer.mockResolvedValue(undefined);
  await user.type(screen.getByLabelText("Message"), "Change the proposal{Enter}");
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledWith({ questionId: "q1", answer: { kind: "permission", decision: "deny", message: "Change the proposal" } }));
});

test("Stop never cancels a local message submission", async () => {
  const snap = snapshot();
  Object.assign(snap.steps[0]!, { turnStatus: "running", turnId: "turn_1", interruptible: true });
  fake.runs.stream.mockImplementation(streamOf(snap));
  let finish!: () => void;
  fake.runs.sendChat.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const user = mount("run_1");
  await screen.findByRole("button", { name: "Stop response" });
  await user.type(screen.getByLabelText("Message"), "Steer the response{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(1));
  const stop = screen.queryByRole<HTMLButtonElement>("button", { name: "Stop response" });
  if (stop) {
    expect(stop.disabled).toBe(true);
    await user.click(stop);
  }
  expect(fake.runs.interruptChat).not.toHaveBeenCalled();
  finish();
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop response" }).disabled).toBe(false));
});

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
  expect(box.value).toBe(" and more");
});

test("a chat that failed says why", async () => {
  const failed = snapshot();
  failed.run = { ...failed.run, status: "failed", error: "claude is not signed in" };
  failed.steps = [{ ...failed.steps[0]!, status: "failed", error: "claude is not signed in" }];
  fake.runs.stream.mockImplementation(streamOf(failed));
  fake.runs.get.mockResolvedValue(failed);
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
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("");
});

/** A chat whose turn runs, with messages queued behind it. */
function busySnapshot(queue: Partial<RunSnapshot["queue"][number]>[] = []): RunSnapshot {
  const snap = snapshot();
  Object.assign(snap.steps[0]!, { turnStatus: "running", turnId: "turn_1", interruptible: true });
  snap.queue = queue.map((q, i) => ({ id: `msg_q${i}`, runId: "run_1", stepRunId: "s_chat", state: "pending", text: `Queued ${i}`, skillId: null, error: null, createdAt: at, ...q }));
  return snap;
}

test("queued messages show above the composer and can be edited or removed while they wait", async () => {
  fake.runs.stream.mockImplementation(streamOf(busySnapshot([{}, { state: "failed", error: JSON.stringify({ key: "engine.chatOver" }) }])));
  fake.runs.editQueued.mockResolvedValue(undefined);
  fake.runs.removeQueued.mockResolvedValue(undefined);
  const user = mount("run_1");
  const list = await screen.findByRole("list", { name: "Queued messages" });
  expect(list.textContent).toContain("Queued 0");
  expect(list.textContent).toContain("Sends when the agent finishes its turn");
  expect(list.textContent).toContain("Not sent: The chat is over.");
  // A failed one can only be removed.
  expect(screen.getAllByRole("button", { name: "Edit queued message" })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Edit queued message" }));
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit queued message" });
  await user.clear(editor);
  await user.type(editor, "Changed");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(fake.runs.editQueued).toHaveBeenCalledWith({ runId: "run_1", queuedId: "msg_q0", text: "Changed" }));
  await user.click(screen.getAllByRole("button", { name: "Remove queued message" })[1]!);
  await waitFor(() => expect(fake.runs.removeQueued).toHaveBeenCalledWith({ runId: "run_1", queuedId: "msg_q1" }));
});

test("an edit that loses to the dispatch keeps its words in the composer", async () => {
  fake.runs.stream.mockImplementation(streamOf(busySnapshot([{}])));
  fake.runs.editQueued.mockRejectedValue(Object.assign(new Error("Conflict"), { code: "CONFLICT" }));
  const user = mount("run_1");
  await user.click(await screen.findByRole("button", { name: "Edit queued message" }));
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit queued message" });
  await user.clear(editor);
  await user.type(editor, "Too late{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("The message was sent before your edit. Your edit is back in the message box.");
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("Too late");
});

/** `busySnapshot` whose chat runs on a harness that steers as `steering` says. */
function steerableSnapshot(steering: { interruptsTools: boolean } | undefined, queue: Partial<RunSnapshot["queue"][number]>[]): RunSnapshot {
  const snap = busySnapshot(queue);
  if (steering) snap.steps[0]!.steering = steering;
  return snap;
}

test.each([
  [true, "Interrupt and send", "Stops the agent's running tool and sends this message into its turn"],
  [false, "Send now", "Sends this message into the agent's current turn"],
])("a pending message can be sent now into the running turn, labelled as its harness takes it (stops tools: %s)", async (interruptsTools, label, hint) => {
  fake.runs.stream.mockImplementation(streamOf(steerableSnapshot({ interruptsTools }, [{}, { state: "failed" }, { skillId: "skill_1" }])));
  fake.runs.steerQueued.mockResolvedValue(undefined);
  const user = mount("run_1");
  await screen.findByRole("list", { name: "Queued messages" });
  // Not for a failed message, nor one calling a skill: those wait for the turn's end.
  const buttons = screen.getAllByRole("button", { name: label });
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.title).toBe(hint);
  await user.click(buttons[0]!);
  await waitFor(() => expect(fake.runs.steerQueued).toHaveBeenCalledWith({ runId: "run_1", queuedId: "msg_q0" }));
});

test("send now isn't offered without a harness that steers or a turn running, and a late one says it", async () => {
  fake.runs.stream.mockImplementation(streamOf(steerableSnapshot(undefined, [{}])));
  mount("run_1");
  await screen.findByRole("list", { name: "Queued messages" });
  expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  cleanup();
  const idle = steerableSnapshot({ interruptsTools: false }, [{}]);
  Object.assign(idle.steps[0]!, { turnStatus: "idle", turnId: null });
  fake.runs.stream.mockImplementation(streamOf(idle));
  mount("run_1");
  await screen.findByRole("list", { name: "Queued messages" });
  expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  cleanup();
  fake.runs.stream.mockImplementation(streamOf(steerableSnapshot({ interruptsTools: false }, [{}])));
  fake.runs.steerQueued.mockRejectedValue(Object.assign(new Error("Conflict"), { code: "CONFLICT" }));
  const user = mount("run_1");
  await user.click(await screen.findByRole("button", { name: "Send now" }));
  expect((await screen.findByRole("alert")).textContent).toBe("This message didn't go now: it was already sent, or the agent's turn just ended. If it is still queued, it goes after the turn.");
});

test("a message sent during a turn goes to the server's queue; a failed one gives its words back", async () => {
  fake.runs.stream.mockImplementation(streamOf(busySnapshot()));
  fake.runs.sendChat.mockResolvedValueOnce({ queuedId: "msg_new" }).mockRejectedValueOnce(new Error("Offline"));
  const user = mount("run_1");
  const box = await screen.findByLabelText<HTMLTextAreaElement>("Message");
  await user.type(box, "While you work{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "While you work" }));
  await waitFor(() => expect(box.value).toBe(""));
  await user.type(box, "Lost{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(box.value).toBe("Lost"));
  expect((await screen.findByRole("alert")).textContent).toBe("Offline");
});

const proposalPayload = { kind: "permission" as const, toolName: "request_approval", input: { message: "May I let Clerk answer questions?", proposal: "prop_1" }, canAlwaysAllow: false };
/** The chat's Approval of a proposal, with the proposal as the run shows it (`proposal: null`: one the thread can't show). */
function proposalQuestion(shown = true): RunSnapshot["questions"][number] {
  return {
    id: "q1",
    about: null,
    proposalId: "prop_1",
    proposal: shown ? { id: "prop_1", status: "asked", plugin: null, items: [{ tool: "agents_update", input: { id: "agt_1", name: "Clerk" }, used: false, pending: false, failed: false, refs: ["id"], creates: null, createdId: null }], names: { agt_1: { kind: "agent", name: "Clerk" } } } : null,
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
  expect(await screen.findAllByRole("button", { name: "Approve" })).toHaveLength(2);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").disabled).toBe(true);
});

test("a finished Job with a recorded transcript sends to the same conversation", async () => {
  const snap = snapshot();
  snap.run = { ...snap.run, source: "agent", workflowId: null, agentId: "agent_1", status: "succeeded", finishedAt: at };
  snap.steps = snap.steps.map((s) => ({ ...s, status: "succeeded", finishedAt: at, resumable: true }));
  fake.runs.stream.mockImplementation(streamOf(snap));
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "n_chat", type: "chat" } }, steps: [], edges: [] });
  fake.runs.sendChat.mockResolvedValue(undefined);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider><ChatPanel surfaceKey="test" runId="run_1" onRunStarted={() => {}} onNewConversation={() => {}} /></ChatSessionsProvider></QueryClientProvider>);
  const user = userEvent.setup();
  const input = await screen.findByLabelText("Message");
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
  await user.type(input, "One more thing.");
  await user.click(screen.getByRole("button", { name: /^Send$/ }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "One more thing." }));
  expect(fake.jobs.start).not.toHaveBeenCalled();
});

test("Assistant slash picker selects without sending and passes a Dispand skill on submission", async () => {
  fake.assistantCommands.mockResolvedValue({ entries: [{ name: "office:tidy", description: "Tidy tables", source: "dispand", skillId: "skill_tidy" }], nativeUnavailable: false });
  fake.workflows.get.mockResolvedValue({ def: { trigger: { field: { id: "n_chat" } }, steps: [], edges: [] } });
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  fake.runs.sendChat.mockResolvedValue(undefined);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider><ChatPanel surfaceKey="test" assistantAgentId="assistant" workflowId="wf_1" runId="run_1" onRunStarted={() => {}} onNewConversation={() => {}} /></ChatSessionsProvider></QueryClientProvider>);
  const user = userEvent.setup();
  const box = screen.getByLabelText("Message");
  await user.type(box, "/ti");
  expect(await screen.findByRole("option", { name: /office:tidy/ })).toBeTruthy();
  await user.keyboard("{Enter}");
  expect((box as HTMLTextAreaElement).value).toBe("/office:tidy ");
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  await user.type(box, "these rows{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "/office:tidy these rows", skillId: "skill_tidy" }));
});

test("Assistant picker supports arrows, Tab, mouse, Escape and discovery fallback", async () => {
  fake.assistantCommands.mockResolvedValue({ entries: [{ name: "first", description: "First", source: "harness" }, { name: "office:tidy", description: "Tidy tables", source: "dispand", skillId: "skill_tidy" }], nativeUnavailable: true });
  fake.workflows.get.mockResolvedValue({ def: { trigger: { field: { id: "n_chat" } }, steps: [], edges: [] } });
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider><ChatPanel surfaceKey="test" assistantAgentId="assistant" workflowId="wf_1" runId="run_1" onRunStarted={() => {}} onNewConversation={() => {}} /></ChatSessionsProvider></QueryClientProvider>);
  const user = userEvent.setup();
  const box = screen.getByLabelText("Message");
  await user.type(box, "/");
  expect(await screen.findByText(/Harness commands unavailable/)).toBeTruthy();
  await user.keyboard("{ArrowDown}{Tab}");
  expect((box as HTMLTextAreaElement).value).toBe("/office:tidy ");
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  await user.clear(box);
  await user.type(box, "/");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  await user.type(box, "ti");
  await user.click(await screen.findByRole("option", { name: /office:tidy/ }));
  expect((box as HTMLTextAreaElement).value).toBe("/office:tidy ");
  expect(document.activeElement).toBe(box);
});

test("files attached for one conversation don't go with another: opening a new one takes them off", async () => {
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  fake.files.hold.mockResolvedValue({ id: "att_1", name: "notes.txt", mime: "application/octet-stream", size: 2, image: false });
  const user = mount("run_1");
  await user.click(await screen.findByRole("button", { name: "Attach a file" }));
  await user.upload(document.body.querySelector<HTMLInputElement>("input[type=file]")!, new File(["hi"], "notes.txt"));
  expect(await screen.findByText("notes.txt")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "New conversation" }));
  await waitFor(() => expect(screen.queryByText("notes.txt")).toBeNull());
  expect(screen.getByLabelText("Message")).toBeTruthy();
});

test("opening another conversation from outside takes the draft's files off too", async () => {
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  fake.files.hold.mockResolvedValue({ id: "att_1", name: "notes.txt", mime: "application/octet-stream", size: 2, image: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fake.workflows.get.mockResolvedValue({ id: "wf_1", name: "Chat", version: 1, def: { trigger: { type: "manual", field: { id: "n_chat" } }, steps: [], edges: [] } });
  const panel = (runId: string) => (
    <QueryClientProvider client={client}><ChatSessionsProvider>
      <ChatPanel surfaceKey="test" workflowId="wf_1" runId={runId} onRunStarted={() => {}} />
    </ChatSessionsProvider></QueryClientProvider>
  );
  const { rerender } = render(panel("run_1"));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Attach a file" }));
  await user.upload(document.body.querySelector<HTMLInputElement>("input[type=file]")!, new File(["hi"], "notes.txt"));
  expect(await screen.findByText("notes.txt")).toBeTruthy();
  rerender(panel("run_2"));
  await waitFor(() => expect(screen.queryByText("notes.txt")).toBeNull());
  expect(screen.getByLabelText("Message")).toBeTruthy();
});

function LibraryComposerActions() {
  const aui = useAui();
  return <button type="button" onClick={() => aui.composer().setQuote({ text: "First line\nSecond line", messageId: "answer_1" })}>Select quote</button>;
}

function mountComposer(questions: RunSnapshot["questions"] = []) {
  fake.runs.stream.mockImplementation(streamOf(snapshot(questions)));
  fake.jobs.def.mockResolvedValue({ trigger: { field: { id: "n_chat", type: "chat" } }, steps: [], edges: [] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider>
    <ChatPanel surfaceKey="test" runId="run_1" onRunStarted={() => {}} assistantAgentId="assistant" composerTools={<LibraryComposerActions />} />
  </ChatSessionsProvider></QueryClientProvider>);
  return userEvent.setup();
}

test("starter suggestions fill the controlled draft without sending and remain editable", async () => {
  const user = mountComposer();
  await user.click(await screen.findByRole("button", { name: "Set up an agent" }));
  const box = screen.getByLabelText<HTMLTextAreaElement>("Message");
  expect(box.value).toBe("Help me set up an agent for a recurring task.");
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  await user.type(box, " Every Monday.");
  fake.runs.sendChat.mockResolvedValue(undefined);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "Help me set up an agent for a recurring task. Every Monday." }));
  await waitFor(() => expect(box.value).toBe(""));
});

test("a quote is previewed, survives a failed send, and is included once on successful retry", async () => {
  const user = mountComposer();
  await user.click(screen.getByRole("button", { name: "Select quote" }));
  expect(await screen.findByLabelText("Quoted text")).toBeTruthy();
  const box = screen.getByLabelText<HTMLTextAreaElement>("Message");
  await user.type(box, "Explain this");
  fake.runs.sendChat.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined);
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByLabelText("Quoted text").textContent).toContain("First line");
  expect(box.value).toBe("Explain this");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(2));
  expect(fake.runs.sendChat.mock.calls.map(([input]) => input.text)).toEqual(Array(2).fill("Explain this\n\n> First line\n> Second line"));
  await waitFor(() => expect(screen.queryByLabelText("Quoted text")).toBeNull());
});

test("a quote can be dismissed without changing the draft", async () => {
  const user = mountComposer();
  await user.type(screen.getByLabelText("Message"), "Keep this");
  await user.click(screen.getByRole("button", { name: "Select quote" }));
  await user.click(await screen.findByRole("button", { name: "Remove quote" }));
  expect(screen.queryByLabelText("Quoted text")).toBeNull();
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("Keep this");
});

test("starter suggestions are hidden when a proposal waits and a quote cannot approve it", async () => {
  const user = mountComposer([proposalQuestion()]);
  await screen.findByRole("button", { name: "Approve" });
  expect(screen.queryByRole("button", { name: "Set up an agent" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Select quote" }));
  expect(fake.questions.answer).not.toHaveBeenCalled();
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Quoted text")).toBeNull();
  fake.questions.answer.mockResolvedValue(undefined);
  await user.type(screen.getByLabelText("Message"), "Change this{Enter}");
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledWith({ questionId: "q1", answer: { kind: "permission", decision: "deny", message: "Change this" } }));
});


test("a failed stock-composer send restores the message ahead of newer typing", async () => {
  let fail!: (error: Error) => void;
  fake.runs.sendChat.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  const user = mount("run_1");
  const box = await screen.findByLabelText<HTMLTextAreaElement>("Message");
  await user.type(box, "First message{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(1));
  await user.type(box, "New draft");
  fail(new Error("Offline"));
  await screen.findByRole("alert");
  await waitFor(() => expect(box.value).toBe("First message\nNew draft"));
});

test("stock attachment submission sends held ids and restores them after failure", async () => {
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  fake.files.hold.mockResolvedValue({ id: "att_1", name: "notes.txt", mime: "application/octet-stream", size: 2, image: false });
  fake.runs.sendChat.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined);
  const user = mount("run_1");
  await user.click(await screen.findByRole("button", { name: "Attach a file" }));
  await user.upload(document.body.querySelector<HTMLInputElement>("input[type=file]")!, new File(["hi"], "notes.txt"));
  await screen.findByText("notes.txt");
  await user.type(screen.getByLabelText("Message"), "Read this{Enter}");
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("Read this"));
  expect(screen.getByRole("button", { name: "Remove this file" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(2));
  expect(fake.runs.sendChat.mock.calls.map(([input]) => input)).toEqual(Array(2).fill({ runId: "run_1", text: "Read this", attachmentIds: ["att_1"] }));
});

 test("a conversation created here gets a fresh draft when starting another", async () => {
  fake.runs.start.mockResolvedValue({ runId: "run_1" });
  fake.runs.sendChat.mockResolvedValue(undefined);
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  const user = mount(null);
  await user.type(screen.getByLabelText("Message"), "Hello");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "New conversation" }).disabled).toBe(false));
  await user.type(screen.getByLabelText("Message"), "Private draft");
  await user.click(screen.getByRole("button", { name: "New conversation" }));
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("");
});

test("quoting keeps a native slash command at the beginning of the submitted prompt", async () => {
  const user = mountComposer();
  await user.click(screen.getByRole("button", { name: "Select quote" }));
  await user.type(screen.getByLabelText("Message"), "/review");
  fake.runs.sendChat.mockResolvedValue(undefined);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "/review\n\n> First line\n> Second line" }));
});

test("dropping a file uses the composer attachment adapter", async () => {
  fake.runs.sendChat.mockResolvedValue(undefined);
  fake.files.hold.mockResolvedValue({ id: "att_drop", image: false });
  const user = mountComposer();
  const file = new File(["notes"], "dropped.txt", { type: "text/plain" });
  fireEvent.drop(screen.getByLabelText("Message").closest("form")!, { dataTransfer: { types: ["Files"], files: [file] } });
  await waitFor(() => expect(fake.files.hold).toHaveBeenCalledWith({ file }));
  await screen.findByText("dropped.txt");
  await user.type(screen.getByLabelText("Message"), "Read the file");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "Read the file", attachmentIds: ["att_drop"] }));
});

test("dropping files cannot attach to a proposal answer", async () => {
  mountComposer([proposalQuestion()]);
  await screen.findByRole("button", { name: "Approve" });
  fireEvent.drop(screen.getByLabelText("Message").closest("form")!, { dataTransfer: { types: ["Files"], files: [new File(["notes"], "dropped.txt")] } });
  expect(fake.files.hold).not.toHaveBeenCalled();
  expect(fake.questions.answer).not.toHaveBeenCalled();
});

test.each(["loading", "empty"])("Assistant slash %s results allow Tab to leave the input", async (state) => {
  fake.assistantCommands.mockImplementation(() => state === "loading" ? new Promise(() => {}) : Promise.resolve({ entries: [], nativeUnavailable: false }));
  fake.workflows.get.mockResolvedValue({ def: { trigger: { field: { id: "n_chat" } }, steps: [], edges: [] } });
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider><ChatPanel surfaceKey="test" assistantAgentId="assistant" workflowId="wf_1" runId="run_1" onRunStarted={() => {}} onNewConversation={() => {}} /></ChatSessionsProvider></QueryClientProvider>);
  const user = userEvent.setup();
  const box = screen.getByLabelText("Message");
  expect(fake.assistantCommands).not.toHaveBeenCalled();
  await user.type(box, "/missing");
  expect(await screen.findByRole("listbox")).toBeTruthy();
  expect(await screen.findByText(state === "loading" ? "Loading commands and skills…" : "No matching commands or skills.")).toBeTruthy();
  await user.tab();
  expect(document.activeElement).not.toBe(box);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  expect(fake.questions.answer).not.toHaveBeenCalled();
});

test("Assistant slash choice during approval never submits or approves, including IME Enter", async () => {
  fake.assistantCommands.mockResolvedValue({ entries: [{ name: "tidy", description: "Tidy tables", source: "dispand", skillId: "skill_tidy" }], nativeUnavailable: false });
  fake.workflows.get.mockResolvedValue({ def: { trigger: { field: { id: "n_chat" } }, steps: [], edges: [] } });
  fake.runs.stream.mockImplementation(streamOf(snapshot([proposalQuestion()])));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider><ChatPanel surfaceKey="test" assistantAgentId="assistant" workflowId="wf_1" runId="run_1" onRunStarted={() => {}} onNewConversation={() => {}} /></ChatSessionsProvider></QueryClientProvider>);
  const user = userEvent.setup();
  const box = await screen.findByLabelText<HTMLTextAreaElement>("Message");
  await user.type(box, "/ti");
  await screen.findByRole("option");
  fireEvent.keyDown(box, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(box.value).toBe("/ti");
  expect(fake.questions.answer).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(box.value).toBe("/tidy ");
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  expect(fake.questions.answer).not.toHaveBeenCalled();
});

test("Assistant same-name commands retain their source identity and manual edits do not reuse a different skill", async () => {
  fake.assistantCommands.mockResolvedValue({ entries: [{ name: "tidy", description: "Native tidy", source: "harness" }, { name: "tidy", description: "Dispand tidy", source: "dispand", skillId: "skill_tidy" }], nativeUnavailable: false });
  fake.workflows.get.mockResolvedValue({ def: { trigger: { field: { id: "n_chat" } }, steps: [], edges: [] } });
  fake.runs.stream.mockImplementation(streamOf(snapshot()));
  fake.runs.sendChat.mockResolvedValue(undefined);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider><ChatPanel surfaceKey="test" assistantAgentId="assistant" workflowId="wf_1" runId="run_1" onRunStarted={() => {}} onNewConversation={() => {}} /></ChatSessionsProvider></QueryClientProvider>);
  const user = userEvent.setup();
  const box = screen.getByLabelText<HTMLTextAreaElement>("Message");
  await user.type(box, "/ti");
  await user.click(await screen.findByRole("option", { name: /Dispand tidy/ }));
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  await user.type(box, "first{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenLastCalledWith({ runId: "run_1", text: "/tidy first", skillId: "skill_tidy" }));
  await waitFor(() => expect(box.value).toBe(""));
  await user.type(box, "/ti");
  await user.click(await screen.findByRole("option", { name: /Native tidy/ }));
  await user.type(box, "second{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenLastCalledWith({ runId: "run_1", text: "/tidy second" }));
  await waitFor(() => expect(box.value).toBe(""));
  await user.type(box, "/ti");
  await user.click(await screen.findByRole("option", { name: /Dispand tidy/ }));
  await user.clear(box);
  await user.type(box, "Different prompt{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenLastCalledWith({ runId: "run_1", text: "Different prompt" }));
});
