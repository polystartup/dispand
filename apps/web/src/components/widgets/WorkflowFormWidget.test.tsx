// @vitest-environment jsdom
import "../../test/jsdom-shims.ts";
import { ChatSessionsProvider } from "../../lib/chat-sessions.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  runs: { start: vi.fn(), sendChat: vi.fn(), stream: vi.fn(), list: vi.fn(), get: vi.fn() },
  workflows: { get: vi.fn() },
  jobs: { start: vi.fn(), def: vi.fn() },
  widgets: { update: vi.fn(), delete: vi.fn() },
  questions: { answer: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));
const { WorkflowFormWidget } = await import("./WorkflowFormWidget.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const at = new Date(0);
const chat = { trigger: { type: "manual", field: { id: "n_chat", key: "chat", type: "chat", label: "Chat", agentId: "a", prompt: "" } }, steps: [], edges: [] };
const button = { trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } }, steps: [], edges: [] };

test("a run keeps the trigger of its own version: the chat stays a chat after it became a button", async () => {
  fake.workflows.get.mockImplementation(async ({ version }: { version?: number }) =>
    version === 1 ? { id: "wf_1", name: "W", version: 1, def: chat } : { id: "wf_1", name: "W", version: 2, def: button },
  );
  fake.runs.list.mockResolvedValue([{ id: "run_1", workflowId: "wf_1", version: 1, status: "running", error: null, createdAt: at, finishedAt: null }]);
  fake.runs.stream.mockImplementation(async (_input: unknown, { signal }: { signal: AbortSignal }) =>
    (async function* () {
      yield { type: "snapshot" as const, run: { id: "run_1", workflowId: "wf_1", version: 1, status: "running", error: null, createdAt: at, finishedAt: null }, steps: [], messages: [], questions: [] };
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    })(),
  );
  const widget = { id: "w1", pageId: "p", type: "workflow-form", title: "W", workflowId: "wf_1", layout: {} } as never;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider>
      <WorkflowFormWidget widget={widget} editing={false} />
    </ChatSessionsProvider></QueryClientProvider>,
  );
  expect(await screen.findByLabelText("Message")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Go|Run/ })).toBeNull();
});


test("a button workflow follows the latest run after navigation and releases selection when it becomes a chat", async () => {
  fake.workflows.get.mockResolvedValue({ id: "wf_1", name: "W", version: 1, def: button });
  fake.runs.list.mockResolvedValue([]);
  fake.runs.start.mockResolvedValue({ runId: "run_a" });
  fake.runs.stream.mockImplementation(async (_input: unknown, { signal }: { signal: AbortSignal }) => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))) }),
  }));
  const widget = { id: "w1", pageId: "p", type: "workflow-form", title: "W", workflowId: "wf_1", layout: {} } as never;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (shown: boolean) => <QueryClientProvider client={client}><ChatSessionsProvider>{shown && <WorkflowFormWidget widget={widget} editing={false} />}</ChatSessionsProvider></QueryClientProvider>;
  const rendered = render(view(true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Go" }));
  await waitFor(() => expect([...fake.runs.stream.mock.calls, ...fake.runs.get.mock.calls].map(([input]) => input.runId)).toContain("run_a"));
  rendered.rerender(view(false));
  fake.runs.list.mockResolvedValue([{ id: "run_b", version: 1 }]);
  rendered.rerender(view(true));
  await waitFor(() => expect([...fake.runs.stream.mock.calls, ...fake.runs.get.mock.calls].map(([input]) => input.runId)).toContain("run_b"));
  await user.click(screen.getByRole("button", { name: "Go" }));
  fake.workflows.get.mockResolvedValue({ id: "wf_1", name: "W", version: 2, def: chat });
  await client.invalidateQueries();
  await user.click(await screen.findByRole("button", { name: "New conversation" }));
  fake.runs.start.mockResolvedValue({ runId: "run_c" });
  fake.runs.sendChat.mockResolvedValue(undefined);
  await user.type(await screen.findByLabelText("Message"), "A fresh conversation{Enter}");
  await waitFor(() => expect(fake.runs.sendChat.mock.calls[0]?.[0]).toEqual({ runId: "run_c", text: "A fresh conversation" }));
});
