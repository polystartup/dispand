// @vitest-environment jsdom
import "../../test/jsdom-shims.ts";
import { ChatSessionsProvider } from "../../lib/chat-sessions.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";

const fake = vi.hoisted(() => ({
  assistantCommands: vi.fn(),
  agents: { assistant: vi.fn(), ensureAssistant: vi.fn(), get: vi.fn(), update: vi.fn() },
  harnesses: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), models: vi.fn() },
  runners: { list: vi.fn() },
  runs: { sendChat: vi.fn(), stream: vi.fn(), list: vi.fn(), get: vi.fn() },
  files: { hold: vi.fn() },
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
const { createI18n } = await import("../../lib/i18n.ts");
const { I18nextProvider } = await import("react-i18next");
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}><ChatSessionsProvider>
      <Url initial={initial} seen={(run) => opened.push(run)} />
    </ChatSessionsProvider></QueryClientProvider>,
  );
  return { user: userEvent.setup(), opened, queryClient };
}

const at = new Date(0);
const chatDef = { trigger: { type: "manual", field: { id: "trigger_chat", key: "trigger", type: "chat", label: "Chat", agentId: "agent_a", prompt: "" } }, steps: [], edges: [] };
const job = (id: string, title: string | null, createdAt: Date) => ({ id, source: "agent", workflowId: null, version: 1, agentId: "agent_a", deletedAgentName: null, triggerId: "trigger_chat", status: "running", trigger: { type: "manual" }, error: null, createdAt, finishedAt: null, queued: false, title });

/** A conversation as its run stream tells it: the owner's message, then the answer. */
function conversation(runId: string, said: string, answered: string): RunSnapshot {
  const message = (role: "user" | "assistant", text: string, n: number) => ({ id: `${runId}_${n}`, runId, stepRunId: `${runId}_s`, role, text, createdAt: at });
  return {
    run: { id: runId, source: "agent", workflowId: null, agentId: "agent_a", deletedAgentName: null, triggerId: "trigger_chat", version: 1, status: "running", trigger: { type: "manual" }, error: null, createdAt: at, finishedAt: null },
    steps: [{ id: `${runId}_s`, runId, nodeId: "trigger_chat", iteration: 0, status: "running", turnStatus: "unknown", turnId: null, interruptible: false, outputs: null, error: null, startedAt: at, finishedAt: null, queuedAt: null, interactive: true, prompt: null }],
    messages: [message("user", said, 1), message("assistant", answered, 2)],
    questions: [],
    queue: [],
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
  expect(fake.jobs.start.mock.calls[0]![0]).toEqual({ triggerId: "trigger_chat", timezone: localTimezone() });
  // Only the Assistant's chat Jobs are followed.
  expect(fake.runs.list.mock.calls[0]![0]).toEqual({ triggerId: "trigger_chat", kind: "chat" });
  // The URL takes the conversation it started.
  expect(opened).toEqual(["run_1"]);
});

test("Stem's composer takes files: an image pasted before the first message goes with it", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([]);
  fake.jobs.start.mockResolvedValue({ runId: "run_1" });
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "trigger_chat", key: "trigger", type: "chat", label: "Chat", agentId: "agent_a", prompt: "" } }, steps: [], edges: [] });
  fake.files.hold.mockResolvedValue({ id: "att_9", name: "screen.png", mime: "image/png", size: 3, image: true });
  fake.runs.sendChat.mockResolvedValue(undefined);
  fake.runs.stream.mockImplementation(idle);
  const { user } = mount();
  expect(await screen.findByRole("button", { name: "Attach a file" })).toBeTruthy();
  const input = await screen.findByLabelText("Message");
  // jsdom has no DataTransfer: the paste carries the clipboard's files as the browser gives them.
  fireEvent.paste(input, { clipboardData: { files: [new File(["png"], "screen.png", { type: "image/png" })], getData: () => "" } });
  expect(await screen.findByText("screen.png")).toBeTruthy();
  await user.type(input, "What's wrong here?{Enter}");
  await waitFor(() => expect(fake.runs.sendChat.mock.calls[0]![0]).toEqual({ runId: "run_1", text: "What's wrong here?", attachmentIds: ["att_9"] }));
});

test("Assistant settings changes the harness and model, preserves other edits, and can restore the harness default", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([]);
  fake.harnesses.list.mockResolvedValue([{ id: "h1", name: "Claude", model: "opus" }, { id: "h2", name: "Codex", model: "codex-default" }]);
  const agent = { id: "agent_a", name: "Assistant", harnessId: "h1", systemPrompt: "Original instructions", model: "sonnet", skills: [{ packageId: "platform" }], tools: [{ toolId: "explicit", explicit: true }, { toolId: "from-skill", explicit: false }] };
  fake.agents.get.mockImplementation(async () => ({ ...agent }));
  fake.agents.update.mockImplementation(async (fields) => { Object.assign(agent, fields, { model: fields.model }); return agent; });
  const { user } = mount();
  await user.type(await screen.findByLabelText("Message"), "Keep this draft");
  await user.click(await screen.findByRole("button", { name: "Stem settings" }));
  let sheet = await screen.findByRole("dialog");
  expect((await within(sheet).findByLabelText("Model") as HTMLInputElement).value).toBe("sonnet");
  await user.click(within(sheet).getByLabelText("Harness"));
  await user.click(await screen.findByRole("option", { name: "Codex" }));
  expect((within(sheet).getByLabelText("Model") as HTMLInputElement).value).toBe("");
  await user.type(within(sheet).getByLabelText("Model"), " codex-model ");
  // Another editor changed the instructions while this sheet was open.
  agent.systemPrompt = "Updated elsewhere";
  await user.click(within(sheet).getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.jobs.start).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect(fake.agents.update.mock.calls[0]![0]).toEqual({ id: "agent_a", name: "Assistant", harnessId: "h2", model: "codex-model", systemPrompt: "Updated elsewhere", skillPackageIds: ["platform"], toolIds: ["explicit"] });

  await user.click(screen.getByRole("button", { name: "Stem settings" }));
  sheet = await screen.findByRole("dialog");
  const model = await within(sheet).findByLabelText("Model");
  expect((model as HTMLInputElement).value).toBe("codex-model");
  await user.clear(model);
  await user.click(within(sheet).getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(fake.agents.update).toHaveBeenCalledTimes(2));
  expect(fake.agents.update.mock.calls[1]![0]).not.toHaveProperty("model");
});

test("reopening settings waits for fresh selections, and background refreshes keep a draft", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([]);
  fake.harnesses.list.mockResolvedValue([{ id: "h1", name: "Claude" }, { id: "h2", name: "Codex" }]);
  const agent = { id: "agent_a", name: "Assistant", harnessId: "h1", model: "sonnet", systemPrompt: "", skills: [], tools: [] };
  fake.agents.get.mockResolvedValue(agent);
  const { user, queryClient } = mount();
  await user.click(await screen.findByRole("button", { name: "Stem settings" }));
  expect((await screen.findByLabelText("Model") as HTMLInputElement).value).toBe("sonnet");
  await user.click(screen.getByRole("button", { name: "Close" }));
  let fetched!: (value: typeof agent) => void;
  fake.agents.get.mockImplementationOnce(() => new Promise((resolve) => { fetched = resolve; }));
  await user.click(screen.getByRole("button", { name: "Stem settings" }));
  expect(screen.queryByLabelText("Model")).toBeNull();
  await waitFor(() => expect(fetched).toBeDefined());
  fetched({ ...agent, harnessId: "h2", model: "new-model" });
  expect((await screen.findByLabelText("Model") as HTMLInputElement).value).toBe("new-model");
  expect(screen.getByLabelText("Harness").textContent).toBe("Codex");
  await user.type(screen.getByLabelText("Model"), "-draft");
  await queryClient.invalidateQueries();
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("new-model-draft");
});

test("a refused harness change keeps the settings open and shows the reason", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([]);
  fake.harnesses.list.mockResolvedValue([{ id: "h1", name: "Cloud" }]);
  fake.agents.get.mockResolvedValue({ id: "agent_a", name: "Assistant", harnessId: "h1", systemPrompt: "", skills: [], tools: [] });
  fake.agents.update.mockRejectedValue(Object.assign(new Error("Runner tools only work with CLI harnesses"), { code: "BAD_REQUEST" }));
  const { user } = mount();
  await user.click(await screen.findByRole("button", { name: "Stem settings" }));
  const sheet = await screen.findByRole("dialog");
  await user.click(await within(sheet).findByRole("button", { name: "Save settings" }));
  expect((await within(sheet).findByRole("alert")).textContent).toBe("Runner tools only work with CLI harnesses");
});

test("the conversations are listed newest first with their titles; opening one shows its messages, a new one starts empty", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([job("run_new", "Which agents touch Matters?", new Date(2000)), job("run_old", "Set up my practice", new Date(1000))]);
  fake.jobs.def.mockResolvedValue(chatDef);
  fake.runs.stream.mockImplementation(streams({ run_new: conversation("run_new", "Which agents touch Matters?", "The Clerk does."), run_old: conversation("run_old", "Set up my practice", "Here is a plan.") }));
  const { user, opened } = mount();
  await user.click(await screen.findByRole("button", { name: "Conversation history" }));
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

  await user.click(screen.getByRole("button", { name: "New conversation" }));
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
  await user.type(screen.getByLabelText("Message"), "half a thought");
  await user.click(screen.getByRole("button", { name: "Conversation history" }));
  // A conversation with no message yet is still listed.
  expect(screen.getByText("No message yet")).toBeTruthy();

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
  await user.click(await screen.findByRole("button", { name: "Stem options" }));
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
  const start = await screen.findByRole("button", { name: "Start Stem" });
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
  expect(await screen.findByText("Choose where Stem runs")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Add a harness" }));
  // The harness sheet: a cloud provider and key, or a runner's CLI.
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByRole("button", { name: /^Cloud/ })).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: /^CLI/ })).toBeTruthy();
  expect(fake.agents.ensureAssistant).not.toHaveBeenCalled();
});

test("full page expands and restores the chat without losing the draft", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([]);
  const { user } = mount();
  await user.type(await screen.findByLabelText("Message"), "Keep this draft");
  await user.click(screen.getByRole("button", { name: "Full page" }));
  expect(screen.getByRole("button", { name: "Exit full page" }).getAttribute("aria-pressed")).toBe("true");
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Keep this draft");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Full page" }).getAttribute("aria-pressed")).toBe("false");
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Keep this draft");
});


test("model search groups provider choices, saves the chosen harness and supports defaults", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([]);
  fake.harnesses.list.mockResolvedValue([{ id: "h1", type: "cloud", name: "Cloud", model: "default-model" }, { id: "h2", type: "cli", name: "Workstation" }]);
  fake.harnesses.models.mockResolvedValue([{ id: "fast", label: "Fast model" }, { id: "deep", label: "Deep model" }]);
  fake.agents.get.mockResolvedValue({ id: "agent_a", name: "Assistant", harnessId: "h2", systemPrompt: "", skills: [], tools: [] });
  fake.agents.update.mockResolvedValue({});
  const { user } = mount();
  await user.click(await screen.findByRole("button", { name: "Full page" }));
  await user.click(screen.getByRole("button", { name: "Stem settings" }));
  const search = await screen.findByRole("textbox", { name: "Find a model" });
  await user.type(search, "fast");
  await user.click(await within(screen.getByRole("group", { name: "Cloud" })).findByRole("button", { name: "Fast model" }));
  expect(screen.queryByRole("button", { name: "Deep model" })).toBeNull();
  expect(within(screen.getByRole("group", { name: "Cloud" })).getByRole("button", { name: "Fast model" }).getAttribute("aria-pressed")).toBe("true");
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(fake.agents.update).toHaveBeenCalledWith(expect.objectContaining({ harnessId: "h1", model: "fast" })));
  await user.click(screen.getByRole("button", { name: "Stem settings" }));
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Exit full page" })).toBeDefined();
  expect(fake.harnesses.models).toHaveBeenCalledWith({ harnessId: "h2" }, expect.anything());
});

test("the chat names the built-in agent Stem, in French too", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([]);
  fake.harnesses.list.mockResolvedValue([]);
  fake.agents.get.mockResolvedValue({ id: "agent_a", name: "Assistant", harnessId: "h1", systemPrompt: "", skills: [], tools: [] });
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider>
        <AssistantChat run={undefined} onOpen={() => {}} />
      </ChatSessionsProvider></QueryClientProvider>
    </I18nextProvider>,
  );
  expect(await screen.findByRole("region", { name: "Stem" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Options de Stem" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Réglages de Stem" })).toBeTruthy();
});

test("without an Assistant, the harness choice is in French and names Stem", async () => {
  fake.agents.assistant.mockResolvedValue(null);
  fake.harnesses.list.mockResolvedValue([{ id: "harness_1", name: "Claude" }]);
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider>
        <AssistantChat run={undefined} onOpen={() => {}} />
      </ChatSessionsProvider></QueryClientProvider>
    </I18nextProvider>,
  );
  expect(await screen.findByRole("button", { name: "Démarrer Stem" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Harnais" })).toBeTruthy();
  expect(screen.getByText(/Choisissez le harnais sur lequel Stem tourne/)).toBeTruthy();
});


test("returning to the Assistant restores its selected conversation while explicit URLs still win", async () => {
  fake.harnesses.list.mockResolvedValue([]);
  fake.agents.get.mockResolvedValue({ id: "agent_a", name: "Assistant", harnessId: "h1", systemPrompt: "", skills: [], tools: [] });
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([job("run_new", "Newer chat", new Date(2000)), job("run_old", "Older chat", new Date(1000))]);
  fake.jobs.def.mockResolvedValue(chatDef);
  fake.runs.stream.mockImplementation(streams({ run_new: conversation("run_new", "new", "New reply"), run_old: conversation("run_old", "old", "Old reply") }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (shown: boolean, run?: string) => <QueryClientProvider client={client}><ChatSessionsProvider>{shown && <AssistantChat run={run} onOpen={() => {}} />}</ChatSessionsProvider></QueryClientProvider>;
  const rendered = render(view(true, "run_old"));
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Message"), "Older draft");
  expect(await screen.findByText("Old reply")).toBeTruthy();
  rendered.rerender(view(false));
  rendered.rerender(view(true));
  expect(await screen.findByText("Old reply")).toBeTruthy();
  await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Older draft"));
  rendered.rerender(view(true, "run_new"));
  expect(await screen.findByText("New reply")).toBeTruthy();
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  rendered.rerender(view(true, "new"));
  await user.type(await screen.findByLabelText("Message"), "Unsent new draft");
  rendered.rerender(view(false));
  rendered.rerender(view(true));
  await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Unsent new draft"));
  expect(screen.queryByText("New reply")).toBeNull();
  await user.click(screen.getByRole("button", { name: "New conversation" }));
  await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(""));
});
