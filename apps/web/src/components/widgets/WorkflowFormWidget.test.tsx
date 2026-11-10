// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  runs: { start: vi.fn(), sendChat: vi.fn(), stream: vi.fn(), list: vi.fn(), get: vi.fn() },
  workflows: { get: vi.fn() },
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
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkflowFormWidget widget={widget} editing={false} />
    </QueryClientProvider>,
  );
  expect(await screen.findByLabelText("Message")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Go|Run/ })).toBeNull();
});
