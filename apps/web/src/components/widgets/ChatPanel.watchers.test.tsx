// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAui } from "@assistant-ui/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";
import "../../test/jsdom-shims.ts";

const fake = vi.hoisted(() => ({
  assistantCommands: vi.fn(),
  runs: { start: vi.fn(), sendChat: vi.fn(), stream: vi.fn(), list: vi.fn() },
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
const { ChatSessionsProvider, useChatSessions } = await import("../../lib/chat-sessions.tsx");

test("inactive conversations release watchers and reactivate with their draft", async () => {
  const { show, user } = mountSession();
  await user.type(await screen.findByLabelText("Message"), "Retained draft");
  const firstSignal = fake.runs.stream.mock.calls[0]![1].signal as AbortSignal;
  show([{ surfaceKey: "left", runId: "run_2" }]);
  await waitFor(() => expect(firstSignal.aborted).toBe(true));
  await waitFor(() => expect(fake.runs.stream).toHaveBeenCalledTimes(2));
  const secondSignal = fake.runs.stream.mock.calls[1]![1].signal as AbortSignal;
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await waitFor(() => expect(secondSignal.aborted).toBe(true));
  await waitFor(() => expect(fake.runs.stream).toHaveBeenCalledTimes(3));
  expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("Retained draft");
  show([]);
  await waitFor(() => expect((fake.runs.stream.mock.calls[2]![1].signal as AbortSignal).aborted).toBe(true));
});

test("explicit New disposes unreachable fresh runtimes after an upload settles", async () => {
  const upload = deferred<{ id: string; image: boolean }>();
  fake.files.hold.mockReturnValue(upload.promise);
  const { user } = mountSession([{ surfaceKey: "left", runId: null }]);
  await user.type(box(), "Discarded draft");
  await user.click(screen.getByRole("button", { name: "Attach a file" }));
  await user.upload(document.body.querySelector<HTMLInputElement>("input[type=file]")!, new File(["bytes"], "pending.txt"));
  await waitFor(() => expect(fake.files.hold).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: "Fresh session" }));
  expect(box().value).toBe("");
  expect(screen.getByTestId("host-count").textContent).toBe("2");
  await act(async () => upload.resolve({ id: "att_old", image: false }));
  await waitFor(() => expect(screen.getByTestId("host-count").textContent).toBe("1"));
  expect(screen.queryByText("pending.txt")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Fresh session" }));
  expect(screen.getByTestId("host-count").textContent).toBe("1");
});

function SessionControls() {
  const sessions = useChatSessions();
  const hosts = useSyncExternalStore(sessions.subscribe, sessions.getHosts, sessions.getHosts);
  return <><span data-testid="host-count">{hosts.length}</span><button onClick={() => sessions.newConversation("left")}>Fresh session</button></>;
}

test("another visible widget keeps the shared run watcher until it also leaves", async () => {
  const { show } = mountSession([{ surfaceKey: "left", runId: "run_1" }, { surfaceKey: "right", runId: "run_1" }]);
  await waitFor(() => expect(fake.runs.stream).toHaveBeenCalledOnce());
  const signal = fake.runs.stream.mock.calls[0]![1].signal as AbortSignal;
  show([{ surfaceKey: "right", runId: "run_1" }]);
  expect(signal.aborted).toBe(false);
  show([]);
  await waitFor(() => expect(signal.aborted).toBe(true));
});

test("reactivation waits for a current run snapshot before sending a retained draft", async () => {
  const { show, user } = mountSession();
  await user.type(await screen.findByLabelText("Message"), "Retained draft");
  show([]);
  const resumed = deferred<RunSnapshot>();
  fake.runs.stream.mockImplementationOnce(async (_input: unknown, { signal }: { signal: AbortSignal }) => (async function* () {
    yield { type: "snapshot", ...await resumed.promise };
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  })());
  show([{ surfaceKey: "left", runId: "run_1" }]);
  await waitFor(() => expect(fake.runs.stream).toHaveBeenCalledTimes(2));
  expect(box().value).toBe("Retained draft");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(true);
  await act(async () => resumed.resolve(snapshot("run_1")));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(false));
});

const at = new Date(0);
function snapshot(runId: string): RunSnapshot {
  return {
    run: { id: runId, source: "workflow", workflowId: "wf_1", agentId: null, deletedAgentName: null, triggerId: null, version: 1, status: "running", trigger: { type: "manual" }, error: null, createdAt: at, finishedAt: null },
    steps: [{ id: `${runId}_chat`, runId, nodeId: "n_chat", iteration: 0, status: "running", turnStatus: "unknown", turnId: null, interruptible: false, outputs: null, error: null, startedAt: at, finishedAt: null, queuedAt: null, interactive: true, prompt: null }],
    messages: [],
    questions: [],
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
      <SessionControls />
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

