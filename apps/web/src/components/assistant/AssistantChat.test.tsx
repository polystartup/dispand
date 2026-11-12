// @vitest-environment jsdom
import "../../test/jsdom-shims.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";

const fake = vi.hoisted(() => ({
  agents: { assistant: vi.fn(), ensureAssistant: vi.fn() },
  harnesses: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), models: vi.fn() },
  runners: { list: vi.fn() },
  runs: { sendChat: vi.fn(), stream: vi.fn(), list: vi.fn(), get: vi.fn() },
  jobs: { start: vi.fn(), def: vi.fn() },
  workflows: { get: vi.fn() },
  questions: { answer: vi.fn() },
  triggers: { get: vi.fn(), update: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));
const { AssistantChat } = await import("./AssistantChat.tsx");
const { localTimezone } = await import("../agents/TriggerSheet.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

/** A run stream that says nothing until it is aborted. */
const idle = async (_input: unknown, { signal }: { signal: AbortSignal }) => ({
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<never>>((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))),
  }),
});

/** The route's part: the open conversation lives in the URL's `run`, here a state. */
function Url({ initial, seen }: { initial?: string; seen: (run: string | undefined) => void }) {
  const [run, setRun] = useState(initial);
  return (
    <AssistantChat
      run={run}
      onOpen={(next) => {
        seen(next);
        setRun(next);
      }}
    />
  );
}

function mount(initial?: string) {
  const opened: (string | undefined)[] = [];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Url initial={initial} seen={(run) => opened.push(run)} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), opened };
}

const at = new Date(0);
const chatDef = { trigger: { type: "manual", field: { id: "trigger_chat", key: "trigger", type: "chat", label: "Chat", agentId: "agent_a", prompt: "" } }, steps: [], edges: [] };
const job = (id: string, title: string | null, createdAt: Date) => ({ id, source: "agent", workflowId: null, version: 1, agentId: "agent_a", deletedAgentName: null, triggerId: "trigger_chat", status: "running", trigger: { type: "manual" }, error: null, createdAt, finishedAt: null, queued: false, title });

/** A conversation as its run stream tells it: the owner's message, then the answer. */
function conversation(runId: string, said: string, answered: string): RunSnapshot {
  const message = (role: "user" | "assistant", text: string, n: number) => ({ id: `${runId}_${n}`, runId, stepRunId: `${runId}_s`, role, text, createdAt: at });
  return {
    run: { id: runId, source: "agent", workflowId: null, agentId: "agent_a", deletedAgentName: null, triggerId: "trigger_chat", version: 1, status: "running", trigger: { type: "manual" }, error: null, createdAt: at, finishedAt: null },
    steps: [{ id: `${runId}_s`, runId, nodeId: "trigger_chat", iteration: 0, status: "running", outputs: null, error: null, startedAt: at, finishedAt: null, queuedAt: null, interactive: true, prompt: null }],
    messages: [message("user", said, 1), message("assistant", answered, 2)],
    questions: [],
  } as RunSnapshot;
}

/** Streams each run's conversation, then stays open until aborted. */
function streams(byRun: Record<string, RunSnapshot>) {
  return async ({ runId }: { runId: string }, { signal }: { signal: AbortSignal }) =>
    (async function* () {
      yield { type: "snapshot" as const, ...byRun[runId]! };
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    })();
}

test("the Assistant's chat starts a Job of its chat trigger with the first message", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([]);
  fake.jobs.start.mockResolvedValue({ runId: "run_1" });
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "trigger_chat", key: "trigger", type: "chat", label: "Chat", agentId: "agent_a", prompt: "" } }, steps: [], edges: [] });
  fake.runs.sendChat.mockResolvedValue(undefined);
  fake.runs.stream.mockImplementation(idle);
  const { user, opened } = mount();
  await user.type(await screen.findByLabelText("Message"), "Which agents touch Matters?{Enter}");
  // The empty thread opens the day-one conversation.
  expect(screen.getByText("Describe your business or use case and how you'd like to automate it.")).toBeTruthy();
  await waitFor(() => expect(fake.runs.sendChat.mock.calls[0]![0]).toEqual({ runId: "run_1", text: "Which agents touch Matters?" }));
  expect(fake.jobs.start.mock.calls[0]![0]).toEqual({ triggerId: "trigger_chat" });
  // Only the Assistant's chat Jobs are followed.
  expect(fake.runs.list.mock.calls[0]![0]).toEqual({ triggerId: "trigger_chat", kind: "chat" });
  // The URL takes the conversation it started.
  expect(opened).toEqual(["run_1"]);
});

test("the conversations are listed newest first with their titles; opening one shows its messages, a new one starts empty", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([job("run_new", "Which agents touch Matters?", new Date(2000)), job("run_old", "Set up my practice", new Date(1000))]);
  fake.jobs.def.mockResolvedValue(chatDef);
  fake.runs.stream.mockImplementation(streams({ run_new: conversation("run_new", "Which agents touch Matters?", "The Clerk does."), run_old: conversation("run_old", "Set up my practice", "Here is a plan.") }));
  const { user, opened } = mount();
  const list = await screen.findByRole("navigation", { name: "Conversations" });
  const entries = within(list).getAllByRole("listitem");
  expect(entries.map((li) => within(li).getByText(/\?$|practice$/).textContent)).toEqual(["Which agents touch Matters?", "Set up my practice"]);
  // With nothing in the URL, the latest is open.
  expect(await screen.findByText("The Clerk does.")).toBeTruthy();
  expect(within(entries[0]!).getByRole("button").getAttribute("aria-current")).toBe("true");

  await user.click(within(entries[1]!).getByRole("button"));
  expect(await screen.findByText("Here is a plan.")).toBeTruthy();
  expect(screen.queryByText("The Clerk does.")).toBeNull();
  expect(opened).toEqual(["run_old"]);

  await user.click(within(list).getByRole("button", { name: "New conversation" }));
  expect(await screen.findByText("Describe your business or use case and how you'd like to automate it.")).toBeTruthy();
  expect(screen.queryByText("Here is a plan.")).toBeNull();
  expect(opened).toEqual(["run_old", "new"]);
});

test("the conversation the URL names opens on load, and a draft stays with the conversation it was typed in", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([job("run_new", "Which agents touch Matters?", new Date(2000)), job("run_old", "Set up my practice", new Date(1000)), job("run_none", null, new Date(500))]);
  fake.jobs.def.mockResolvedValue(chatDef);
  fake.runs.stream.mockImplementation(streams({ run_new: conversation("run_new", "a", "The Clerk does."), run_old: conversation("run_old", "b", "Here is a plan."), run_none: conversation("run_none", "c", "Hello.") }));
  const { user } = mount("run_old");
  expect(await screen.findByText("Here is a plan.")).toBeTruthy();
  expect(screen.queryByText("The Clerk does.")).toBeNull();
  // A conversation with no message yet is still listed.
  expect(screen.getByText("No message yet")).toBeTruthy();

  await user.type(screen.getByLabelText("Message"), "half a thought");
  await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByText("Which agents touch Matters?"));
  expect(await screen.findByText("The Clerk does.")).toBeTruthy();
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
});

test("the weekly review is off until the owner turns it on, in their time zone", async () => {
  const review = { id: "trigger_review", enabled: false, config: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Paris" } };
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat", reviewTriggerId: "trigger_review" });
  fake.runs.list.mockResolvedValue([]);
  fake.triggers.get.mockResolvedValue(review);
  fake.triggers.update.mockImplementation(async ({ enabled }: { enabled: boolean }) => (review.enabled = enabled, review));
  const { user } = mount();
  const box = (await screen.findByRole("checkbox", { name: /Weekly review/ })) as HTMLInputElement;
  expect(box.checked).toBe(false);
  await user.click(box);
  await waitFor(() => expect(fake.triggers.update).toHaveBeenCalled());
  expect(fake.triggers.update.mock.calls[0]![0]).toEqual({ id: "trigger_review", enabled: true, config: { kind: "schedule", cron: "0 9 * * 1", timezone: localTimezone() } });
  await waitFor(() => expect(box.checked).toBe(true));
  // Turning it off keeps its schedule as it is.
  await user.click(box);
  await waitFor(() => expect(fake.triggers.update.mock.calls[1]![0]).toEqual({ id: "trigger_review", enabled: false }));
});

test("without an Assistant, picking a harness makes it", async () => {
  fake.agents.assistant.mockResolvedValue(null);
  fake.harnesses.list.mockResolvedValue([{ id: "harness_1", name: "Claude" }]);
  fake.agents.ensureAssistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  const { user } = mount();
  const start = await screen.findByRole("button", { name: "Start the Assistant" });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  await user.selectOptions(screen.getByRole("combobox", { name: "Harness" }), "harness_1");
  await user.click(start);
  await waitFor(() => expect(fake.agents.ensureAssistant).toHaveBeenCalled());
  expect(fake.agents.ensureAssistant.mock.calls[0]![0]).toEqual({ harnessId: "harness_1" });
});

test("without an Assistant or a harness, it offers to add one, and the Assistant waits for the owner to start it", async () => {
  fake.agents.assistant.mockResolvedValue(null);
  fake.harnesses.list.mockResolvedValue([]);
  fake.runners.list.mockResolvedValue([]);
  const { user } = mount();
  expect(await screen.findByText("Choose where the Assistant runs")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Add a harness" }));
  // The harness sheet: a cloud provider and key, or a runner's CLI.
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByRole("button", { name: /^Cloud/ })).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: /^CLI/ })).toBeTruthy();
  expect(fake.agents.ensureAssistant).not.toHaveBeenCalled();
});
