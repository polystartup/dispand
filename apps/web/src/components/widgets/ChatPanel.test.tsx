// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";

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
    run: { id: "run_1", source: "workflow" as const, workflowId: "wf_1", agentId: null, triggerId: null, version: 1, status: questions.length ? "waiting" : "running", trigger: { type: "manual" }, error: null, createdAt: at, finishedAt: null },
    steps: [
      { id: "s_chat", runId: "run_1", nodeId: "n_chat", iteration: 0, status: questions.length ? "waiting" : "running", outputs: null, error: null, startedAt: at, finishedAt: null, interactive: true, prompt: null },
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
