// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAui } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";
import "../../test/jsdom-shims.ts";

const fake = vi.hoisted(() => ({
  assistantCommands: vi.fn(),
  runs: { start: vi.fn(), sendChat: vi.fn(), interruptChat: vi.fn(), stream: vi.fn(), list: vi.fn() },
  workflows: { get: vi.fn() },
  jobs: { def: vi.fn() },
  questions: { answer: vi.fn() },
  files: { hold: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});

const { ChatPanel } = await import("./ChatPanel.tsx");
const { ChatSessionsProvider } = await import("../../lib/chat-sessions.tsx");

const at = new Date(0);
function snapshot(runId: string): RunSnapshot {
  return {
    run: { id: runId, source: "workflow", workflowId: "wf_1", agentId: null, deletedAgentName: null, triggerId: null, version: 1, status: "running", trigger: { type: "manual" }, error: null, createdAt: at, finishedAt: null },
    steps: [{ id: `${runId}_chat`, runId, nodeId: "n_chat", iteration: 0, status: "running", turnStatus: "unknown", turnId: null, interruptible: false, outputs: null, error: null, startedAt: at, finishedAt: null, queuedAt: null, interactive: true, prompt: null }],
    messages: [],
    questions: [],
    queue: [],
  };
}

beforeEach(() => {
  fake.workflows.get.mockResolvedValue({ id: "wf_1", version: 1, def: { trigger: { type: "manual", field: { id: "n_chat", type: "chat" } }, steps: [], edges: [] } });
  fake.runs.stream.mockImplementation(async ({ runId }: { runId: string }, { signal }: { signal: AbortSignal }) => (async function* () {
    yield { type: "snapshot", ...snapshot(runId) };
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  })());
  fake.assistantCommands.mockResolvedValue({ entries: [{ name: "tidy", description: "Tidy tables", source: "dispand", skillId: "skill_tidy" }], nativeUnavailable: false });
  fake.files.hold.mockResolvedValue({ id: "att_notes", name: "notes.txt", mime: "application/octet-stream", size: 2, image: false });
  fake.runs.sendChat.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function QuoteAction() {
  const aui = useAui();
  return <button type="button" onClick={() => aui.composer().setQuote({ text: "Quoted source", messageId: "answer_1" })}>Quote source</button>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Surface = { surfaceKey: string; runId: string | null };
function mountSession(initial: Surface[] = [{ surfaceKey: "left", runId: "run_1" }]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const started = vi.fn();
  const tree = (surfaces: Surface[], session: string) => <QueryClientProvider client={client}>
    <ChatSessionsProvider key={session}>
      {surfaces.map(({ surfaceKey, runId }) => <section aria-label={surfaceKey} key={surfaceKey}>
        <ChatPanel surfaceKey={surfaceKey} workflowId="wf_1" assistantAgentId="assistant" runId={runId} onRunStarted={started} composerTools={<QuoteAction />} />
      </section>)}
    </ChatSessionsProvider>
  </QueryClientProvider>;
  const view = render(tree(initial, "session_1"));
  return {
    user: userEvent.setup(),
    started,
    show: (surfaces: Surface[], session = "session_1") => view.rerender(tree(surfaces, session)),
  };
}

const box = () => screen.getByLabelText<HTMLTextAreaElement>("Message");

test("switching conversations retains the text, quote, held file and selected skill together", async () => {
  const { user, show } = mountSession();
  await user.type(await screen.findByLabelText("Message"), "/ti");
  await user.click(await screen.findByRole("option", { name: /Tidy tables/ }));
  await user.type(box(), "these rows");
  await user.click(screen.getByRole("button", { name: "Quote source" }));
  await user.click(screen.getByRole("button", { name: "Attach a file" }));
  await user.upload(document.body.querySelector<HTMLInputElement>("input[type=file]")!, new File(["hi"], "notes.txt"));
  await screen.findByText("notes.txt");

  show([{ surfaceKey: "left", runId: "run_2" }]);
  await waitFor(() => expect(box().value).toBe(""));
  expect(screen.queryByLabelText("Quoted text")).toBeNull();
  expect(screen.queryByText("notes.txt")).toBeNull();
  await user.type(box(), "Another draft");
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await waitFor(() => expect(box().value).toBe("/tidy these rows"));
  expect(screen.getByLabelText("Quoted text").textContent).toContain("Quoted source");
  expect(screen.getByText("notes.txt")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "/tidy these rows\n\n> Quoted source", skillId: "skill_tidy", attachmentIds: ["att_notes"] }));
  expect(fake.files.hold).toHaveBeenCalledTimes(1);
  show([{ surfaceKey: "left", runId: "run_2" }]);
  await waitFor(() => expect(box().value).toBe("Another draft"));
});

test("stopping in the background retains its draft, quote, file and skill in the original conversation", async () => {
  fake.runs.stream.mockImplementation(async ({ runId }: { runId: string }, { signal }: { signal: AbortSignal }) => (async function* () {
    const snap = snapshot(runId);
    Object.assign(snap.steps[0]!, { turnStatus: "running", turnId: runId + "_turn", interruptible: true });
    yield { type: "snapshot", ...snap };
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  })());
  const interrupt = deferred<{ outcome: "failed" }>();
  fake.runs.interruptChat.mockReturnValue(interrupt.promise);
  const { user, show } = mountSession();
  await user.type(await screen.findByLabelText("Message"), "/ti");
  await user.click(await screen.findByRole("option", { name: /Tidy tables/ }));
  await user.type(box(), "these rows");
  await user.click(screen.getByRole("button", { name: "Quote source" }));
  await user.click(screen.getByRole("button", { name: "Attach a file" }));
  await user.upload(document.body.querySelector<HTMLInputElement>("input[type=file]")!, new File(["hi"], "notes.txt"));
  await screen.findByText("notes.txt");
  await user.click(screen.getByRole("button", { name: "Stop response" }));
  expect(fake.runs.interruptChat).toHaveBeenCalledWith({ runId: "run_1", turnId: "run_1_turn" });
  show([{ surfaceKey: "left", runId: "run_2" }]);
  await waitFor(() => expect(box().value).toBe(""));
  await user.type(box(), "Other draft");
  await act(async () => interrupt.resolve({ outcome: "failed" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(box().value).toBe("Other draft");
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await waitFor(() => expect(box().value).toBe("/tidy these rows"));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not stop the response. Try again.");
  expect(screen.getByLabelText("Quoted text").textContent).toContain("Quoted source");
  expect(screen.getByText("notes.txt")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "/tidy these rows\n\n> Quoted source", skillId: "skill_tidy", attachmentIds: ["att_notes"] }));
});

test("two widgets showing the same Job have independent composers", async () => {
  const { user, show } = mountSession([{ surfaceKey: "left", runId: "run_1" }, { surfaceKey: "right", runId: "run_1" }]);
  const left = within(screen.getByRole("region", { name: "left" }));
  const right = within(screen.getByRole("region", { name: "right" }));
  await user.type(await left.findByLabelText("Message"), "Left draft");
  await user.type(await right.findByLabelText("Message"), "Right draft");
  show([{ surfaceKey: "left", runId: "run_2" }, { surfaceKey: "right", runId: "run_1" }]);
  await waitFor(() => expect(left.getByLabelText<HTMLTextAreaElement>("Message").value).toBe(""));
  expect(right.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("Right draft");
  await user.click(right.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "Right draft" }));
  show([{ surfaceKey: "left", runId: "run_1" }, { surfaceKey: "right", runId: "run_1" }]);
  await waitFor(() => expect(left.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("Left draft"));
});

test("navigation keeps a surface's draft while a new signed-in session clears it", async () => {
  const { user, show } = mountSession();
  await user.type(await screen.findByLabelText("Message"), "Keep until logout");
  await user.click(screen.getByRole("button", { name: "Quote source" }));
  show([]);
  expect(screen.queryByLabelText("Message")).toBeNull();
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await waitFor(() => expect(box().value).toBe("Keep until logout"));
  expect(screen.getByLabelText("Quoted text")).toBeTruthy();
  show([{ surfaceKey: "left", runId: "run_1" }], "session_2");
  await waitFor(() => expect(box().value).toBe(""));
  expect(screen.queryByLabelText("Quoted text")).toBeNull();
});

test("an upload finishes in its original conversation while another conversation is open", async () => {
  const upload = deferred<{ id: string; image: boolean }>();
  fake.files.hold.mockReturnValue(upload.promise);
  const { user, show } = mountSession();
  await user.type(await screen.findByLabelText("Message"), "Read this");
  await user.click(screen.getByRole("button", { name: "Attach a file" }));
  await user.upload(document.body.querySelector<HTMLInputElement>("input[type=file]")!, new File(["hi"], "notes.txt"));
  await waitFor(() => expect(fake.files.hold).toHaveBeenCalledTimes(1));
  show([{ surfaceKey: "left", runId: "run_2" }]);
  await act(async () => upload.resolve({ id: "att_notes", image: false }));
  expect(screen.queryByText("notes.txt")).toBeNull();
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await screen.findByText("notes.txt");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "Read this", attachmentIds: ["att_notes"] }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a background send failure restores its own draft ahead of newer typing", async () => {
  const sent = deferred<void>();
  fake.runs.sendChat.mockReturnValueOnce(sent.promise);
  const { user, show } = mountSession();
  await user.type(await screen.findByLabelText("Message"), "First message{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledTimes(1));
  await user.type(box(), "Newer typing");
  show([{ surfaceKey: "left", runId: "run_2" }]);
  await user.type(await screen.findByLabelText("Message"), "Other conversation");
  await act(async () => sent.reject(new Error("Offline")));
  expect(box().value).toBe("Other conversation");
  expect(screen.queryByRole("alert")).toBeNull();
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await waitFor(() => expect(box().value).toBe("First message\nNewer typing"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenLastCalledWith({ runId: "run_1", text: "First message\nNewer typing" }));
});

test("creating a Job keeps newer typing in the same conversation after the first send settles", async () => {
  const sent = deferred<void>();
  fake.runs.start.mockResolvedValue({ runId: "run_1" });
  fake.runs.sendChat.mockReturnValueOnce(sent.promise);
  const { user, show } = mountSession([{ surfaceKey: "left", runId: null }]);
  await user.type(await screen.findByLabelText("Message"), "Start this{Enter}");
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenCalledWith({ runId: "run_1", text: "Start this" }));
  await user.type(box(), "Keep this next");
  show([{ surfaceKey: "left", runId: "run_2" }]);
  await act(async () => sent.resolve());
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await waitFor(() => expect(box().value).toBe("Keep this next"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenLastCalledWith({ runId: "run_1", text: "Keep this next" }));
  expect(fake.runs.start).toHaveBeenCalledTimes(1);
});

test("a first-send start resolving after logout cannot submit into the next session", async () => {
  const start = deferred<{ runId: string }>();
  fake.runs.start.mockReturnValueOnce(start.promise);
  const { user, show, started } = mountSession([{ surfaceKey: "left", runId: null }]);
  await user.type(await screen.findByLabelText("Message"), "Old session message{Enter}");
  await waitFor(() => expect(fake.runs.start).toHaveBeenCalledTimes(1));
  show([{ surfaceKey: "left", runId: null }], "session_2");
  await act(async () => start.resolve({ runId: "run_old" }));
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  expect(started).not.toHaveBeenCalled();
  expect(box().value).toBe("");
});

test("an old null route during first-send navigation does not replace the promoted conversation", async () => {
  const sent = deferred<void>();
  fake.runs.start.mockResolvedValue({ runId: "run_1" });
  fake.runs.sendChat.mockReturnValueOnce(sent.promise);
  const { user, show, started } = mountSession([{ surfaceKey: "left", runId: null }]);
  await user.type(await screen.findByLabelText("Message"), "First message{Enter}");
  await waitFor(() => expect(started).toHaveBeenCalledWith("run_1"));
  await user.type(box(), "Draft during navigation");
  // The router has not committed the run ID when the parent renders again.
  show([{ surfaceKey: "left", runId: null }]);
  await waitFor(() => expect(box().value).toBe("Draft during navigation"));
  await act(async () => sent.resolve());
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await waitFor(() => expect(box().value).toBe("Draft during navigation"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.runs.sendChat).toHaveBeenLastCalledWith({ runId: "run_1", text: "Draft during navigation" }));
  expect(fake.runs.start).toHaveBeenCalledTimes(1);
});

test("a pending proposal decline cannot clear an already-visited conversation's identical draft", async () => {
  const answered = deferred<void>();
  fake.questions.answer.mockReturnValueOnce(answered.promise);
  fake.runs.stream.mockImplementation(async ({ runId }: { runId: string }, { signal }: { signal: AbortSignal }) => (async function* () {
    const run = snapshot(runId);
    if (runId === "run_1") {
      run.questions = [{
        id: "q_decline", runId, stepRunId: `${runId}_chat`, placement: "chat", status: "pending", answer: null, createdAt: at,
        about: null, proposalId: "prop_1", rootId: null, consultId: null,
        proposal: { id: "prop_1", status: "asked", plugin: null, items: [{ tool: "agents_update", input: { id: "agt_1", name: "Clerk" }, used: false, pending: false, failed: false, refs: ["id"], creates: null, createdId: null }], names: { agt_1: { kind: "agent", name: "Clerk" } } },
        payload: { kind: "permission", toolName: "request_approval", input: { message: "May I update Clerk?", proposal: "prop_1" }, canAlwaysAllow: false },
      }];
    }
    yield { type: "snapshot", ...run };
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  })());
  const { user, show } = mountSession([{ surfaceKey: "left", runId: "run_2" }]);
  await user.type(await screen.findByLabelText("Message"), "Make it smaller");
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await screen.findByRole("button", { name: "Approve" });
  await user.type(box(), "Make it smaller");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fake.questions.answer).toHaveBeenCalledWith({ questionId: "q_decline", answer: { kind: "permission", decision: "deny", message: "Make it smaller" } }));

  show([{ surfaceKey: "left", runId: "run_2" }]);
  await waitFor(() => expect(box().value).toBe("Make it smaller"));
  await act(async () => answered.resolve());
  expect(box().value).toBe("Make it smaller");
  expect(fake.runs.sendChat).not.toHaveBeenCalled();
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await waitFor(() => expect(box().value).toBe(""));
  expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Approve" })).disabled).toBe(false);
  expect(fake.questions.answer).toHaveBeenCalledTimes(1);
});
