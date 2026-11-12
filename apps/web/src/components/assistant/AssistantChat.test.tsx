// @vitest-environment jsdom
import "../../test/jsdom-shims.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  agents: { assistant: vi.fn(), ensureAssistant: vi.fn() },
  harnesses: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), models: vi.fn() },
  runners: { list: vi.fn() },
  runs: { sendChat: vi.fn(), stream: vi.fn(), list: vi.fn(), get: vi.fn() },
  jobs: { start: vi.fn(), def: vi.fn() },
  workflows: { get: vi.fn() },
  questions: { answer: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));
const { AssistantChat } = await import("./AssistantChat.tsx");

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

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AssistantChat />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

test("the Assistant's chat starts a Job of its chat trigger with the first message", async () => {
  fake.agents.assistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  fake.runs.list.mockResolvedValue([]);
  fake.jobs.start.mockResolvedValue({ runId: "run_1" });
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "trigger_chat", key: "trigger", type: "chat", label: "Chat", agentId: "agent_a", prompt: "" } }, steps: [], edges: [] });
  fake.runs.sendChat.mockResolvedValue(undefined);
  fake.runs.stream.mockImplementation(idle);
  const user = mount();
  await user.type(await screen.findByLabelText("Message"), "Which agents touch Matters?{Enter}");
  // The empty thread opens the day-one conversation.
  expect(screen.getByText("Describe your business or use case and how you'd like to automate it.")).toBeTruthy();
  await waitFor(() => expect(fake.runs.sendChat.mock.calls[0]![0]).toEqual({ runId: "run_1", text: "Which agents touch Matters?" }));
  expect(fake.jobs.start.mock.calls[0]![0]).toEqual({ triggerId: "trigger_chat" });
  // Only the Assistant's chat Jobs are followed.
  expect(fake.runs.list.mock.calls[0]![0]).toEqual({ triggerId: "trigger_chat" });
});

test("without an Assistant, picking a harness makes it", async () => {
  fake.agents.assistant.mockResolvedValue(null);
  fake.harnesses.list.mockResolvedValue([{ id: "harness_1", name: "Claude" }]);
  fake.agents.ensureAssistant.mockResolvedValue({ agentId: "agent_a", triggerId: "trigger_chat" });
  const user = mount();
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
  const user = mount();
  expect(await screen.findByText("Choose where the Assistant runs")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Add a harness" }));
  // The harness sheet: a cloud provider and key, or a runner's CLI.
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByRole("button", { name: /^Cloud/ })).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: /^CLI/ })).toBeTruthy();
  expect(fake.agents.ensureAssistant).not.toHaveBeenCalled();
});
