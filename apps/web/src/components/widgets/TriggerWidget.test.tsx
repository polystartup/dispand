// @vitest-environment jsdom
import "../../test/jsdom-shims.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  runs: { start: vi.fn(), sendChat: vi.fn(), stream: vi.fn(), list: vi.fn(), get: vi.fn() },
  jobs: { start: vi.fn(), def: vi.fn() },
  triggers: { get: vi.fn() },
  workflows: { get: vi.fn() },
  widgets: { update: vi.fn(), delete: vi.fn() },
  questions: { answer: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));
const { TriggerWidget } = await import("./TriggerWidget.tsx");
const { localTimezone } = await import("../agents/TriggerSheet.tsx");
// jsdom has no layout.
Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const widget = { id: "w1", pageId: "p", type: "trigger-form", title: "Mail", triggerId: "trigger_1", layout: {} } as never;
const trigger = (placement: "chat" | "button", enabled = true) => ({ id: "trigger_1", agentId: "agent_1", name: "Sort the mail", kind: "manual", enabled, instructions: "", concurrency: "parallel", config: { kind: "manual", placement }, lastFires: [] });

/** A run stream that says nothing until it is aborted. */
const idle = async (_input: unknown, { signal }: { signal: AbortSignal }) => ({
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<never>>((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))),
  }),
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TriggerWidget widget={widget} editing={false} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

test("TriggerWidget with a button placement starts a Job on click", async () => {
  fake.triggers.get.mockResolvedValue(trigger("button"));
  fake.runs.list.mockResolvedValue([]);
  fake.jobs.start.mockResolvedValue({ runId: "run_1" });
  fake.runs.stream.mockImplementation(idle);
  const user = mount();
  await user.click(await screen.findByRole("button", { name: "Sort the mail" }));
  expect(fake.jobs.start.mock.calls[0]![0]).toEqual({ triggerId: "trigger_1", timezone: localTimezone() });
  expect(fake.runs.start).not.toHaveBeenCalled();
  // Only this trigger's Jobs are followed.
  expect(fake.runs.list.mock.calls[0]![0]).toEqual({ triggerId: "trigger_1" });
});

test("TriggerWidget with a chat placement starts the Job with the first message", async () => {
  fake.triggers.get.mockResolvedValue(trigger("chat"));
  fake.runs.list.mockResolvedValue([]);
  fake.jobs.start.mockResolvedValue({ runId: "run_1", chatSessionId: "ses_1" });
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "trigger_1", key: "trigger", type: "chat", label: "Mail", agentId: "agent_1", prompt: "" } }, steps: [], edges: [] });
  fake.runs.sendChat.mockResolvedValue(undefined);
  fake.runs.stream.mockImplementation(idle);
  const user = mount();
  await user.type(await screen.findByLabelText("Message"), "Anything urgent?{Enter}");
  await waitFor(() => expect(fake.runs.sendChat.mock.calls[0]![0]).toEqual({ runId: "run_1", text: "Anything urgent?" }));
  expect(fake.jobs.start.mock.calls[0]![0]).toEqual({ triggerId: "trigger_1", timezone: localTimezone() });
  expect(fake.runs.start).not.toHaveBeenCalled();
});

test("TriggerWidget says when its trigger is disabled or gone", async () => {
  fake.triggers.get.mockResolvedValue(trigger("button", false));
  fake.runs.list.mockResolvedValue([]);
  mount();
  expect(await screen.findByText("This trigger is disabled.")).toBeTruthy();
  cleanup();
  fake.triggers.get.mockRejectedValue(Object.assign(new Error("gone"), { code: "NOT_FOUND" }));
  mount();
  expect(await screen.findByText("This trigger is no longer available.")).toBeTruthy();
});

test("a chat Job stays a chat after its trigger became a button", async () => {
  fake.triggers.get.mockResolvedValue(trigger("button"));
  fake.runs.list.mockResolvedValue([{ id: "run_1", triggerId: "trigger_1" }]);
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "trigger_1", key: "trigger", type: "chat", label: "Mail", agentId: "agent_1", prompt: "" } }, steps: [], edges: [] });
  fake.runs.stream.mockImplementation(idle);
  mount();
  expect(await screen.findByLabelText("Message")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sort the mail" })).toBeNull();
});
