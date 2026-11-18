// @vitest-environment jsdom
import "../../test/jsdom-shims.ts";
import { ChatSessionsProvider } from "../../lib/chat-sessions.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  runs: { start: vi.fn(), sendChat: vi.fn(), stream: vi.fn(), list: vi.fn(), get: vi.fn() },
  files: { hold: vi.fn() },
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
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ChatSessionsProvider>
      <TriggerWidget widget={widget} editing={false} />
    </ChatSessionsProvider></QueryClientProvider>,
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

test("a chat trigger's composer takes files: one attached before the first message goes with it", async () => {
  fake.triggers.get.mockResolvedValue(trigger("chat"));
  fake.runs.list.mockResolvedValue([]);
  fake.jobs.start.mockResolvedValue({ runId: "run_1", chatSessionId: "ses_1" });
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "trigger_1", key: "trigger", type: "chat", label: "Mail", agentId: "agent_1", prompt: "" } }, steps: [], edges: [] });
  fake.files.hold.mockResolvedValue({ id: "att_1", name: "invoice.pdf", mime: "application/octet-stream", size: 3, image: false });
  fake.runs.sendChat.mockResolvedValue(undefined);
  fake.runs.stream.mockImplementation(idle);
  const user = mount();
  await user.click(await screen.findByRole("button", { name: "Attach a file" }));
  await user.upload(document.body.querySelector<HTMLInputElement>("input[type=file]")!, new File(["pdf"], "invoice.pdf"));
  expect(await screen.findByText("invoice.pdf")).toBeTruthy();
  expect(fake.files.hold.mock.calls[0]![0].file.name).toBe("invoice.pdf");
  expect(fake.jobs.start).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("Message"), "Pay this{Enter}");
  await waitFor(() => expect(fake.runs.sendChat.mock.calls[0]![0]).toEqual({ runId: "run_1", text: "Pay this", attachmentIds: ["att_1"] }));
  await waitFor(() => expect(within(screen.getByLabelText("Message").closest("form")!).queryByText("invoice.pdf")).toBeNull());
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

test("a disabled trigger still shows the Job it ran, without a Start", async () => {
  fake.triggers.get.mockResolvedValue(trigger("chat", false));
  fake.runs.list.mockResolvedValue([{ id: "run_1", triggerId: "trigger_1" }]);
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "trigger_1", key: "trigger", type: "chat", label: "Mail", agentId: "agent_1", prompt: "" } }, steps: [], edges: [] });
  fake.runs.stream.mockImplementation(idle);
  mount();
  expect(await screen.findByLabelText("Message")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
  cleanup();
  fake.triggers.get.mockResolvedValue(trigger("button", false));
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "trigger_1", key: "trigger", type: "button", label: "Mail" } }, steps: [], edges: [] });
  mount();
  expect(await screen.findByText("This trigger is disabled.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sort the mail" })).toBeNull();
});


test("two widgets for the same trigger keep separate new conversations across navigation", async () => {
  fake.triggers.get.mockResolvedValue(trigger("chat"));
  fake.runs.list.mockResolvedValue([{ id: "existing", version: 1 }]);
  fake.jobs.def.mockResolvedValue({ trigger: { type: "manual", field: { id: "trigger_1", key: "trigger", type: "chat", label: "Mail", agentId: "agent_1", prompt: "" } }, steps: [], edges: [] });
  fake.runs.stream.mockImplementation(idle);
  fake.jobs.start.mockResolvedValue({ runId: "new_run" });
  fake.runs.sendChat.mockResolvedValue(undefined);
  const second = { id: "w2", pageId: "p", type: "trigger-form", title: "Second mail", triggerId: "trigger_1", layout: {} } as never;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (shown: boolean) => <QueryClientProvider client={client}><ChatSessionsProvider>{shown && <><TriggerWidget widget={widget} editing={false} /><TriggerWidget widget={second} editing={false} /></>}</ChatSessionsProvider></QueryClientProvider>;
  const rendered = render(view(true));
  const user = userEvent.setup();
  const first = within(screen.getByRole("region", { name: "Mail" }));
  const other = within(screen.getByRole("region", { name: "Second mail" }));
  await user.click(await first.findByRole("button", { name: "New conversation" }));
  await user.type(first.getByLabelText("Message"), "First draft");
  await user.type(await other.findByLabelText("Message"), "Second draft");
  rendered.rerender(view(false));
  rendered.rerender(view(true));
  const restored = within(screen.getByRole("region", { name: "Mail" }));
  await waitFor(() => expect((restored.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("First draft"));
  expect((within(screen.getByRole("region", { name: "Second mail" })).getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Second draft");
  await user.type(restored.getByLabelText("Message"), "{Enter}");
  await waitFor(() => expect(fake.jobs.start).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(fake.runs.sendChat.mock.calls[0]?.[0]).toEqual({ runId: "new_run", text: "First draft" }));
});


test("a button trigger follows the latest Job after navigation and releases selection when it becomes a chat", async () => {
  fake.triggers.get.mockResolvedValue(trigger("button"));
  fake.runs.list.mockResolvedValue([]);
  fake.jobs.def.mockResolvedValue({ trigger: { field: { type: "button" } } });
  fake.jobs.start.mockResolvedValue({ runId: "run_a" });
  fake.runs.stream.mockImplementation(idle);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (shown: boolean) => <QueryClientProvider client={client}><ChatSessionsProvider>{shown && <TriggerWidget widget={widget} editing={false} />}</ChatSessionsProvider></QueryClientProvider>;
  const rendered = render(view(true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Sort the mail" }));
  await waitFor(() => expect([...fake.runs.stream.mock.calls, ...fake.runs.get.mock.calls].map(([input]) => input.runId)).toContain("run_a"));
  rendered.rerender(view(false));
  fake.runs.list.mockResolvedValue([{ id: "run_b" }]);
  rendered.rerender(view(true));
  await waitFor(() => expect([...fake.runs.stream.mock.calls, ...fake.runs.get.mock.calls].map(([input]) => input.runId)).toContain("run_b"));
  await user.click(screen.getByRole("button", { name: "Sort the mail" }));
  fake.triggers.get.mockResolvedValue(trigger("chat"));
  fake.jobs.def.mockResolvedValue({ trigger: { field: { type: "chat", id: "trigger_1" } }, steps: [], edges: [] });
  await client.invalidateQueries();
  await user.click(await screen.findByRole("button", { name: "New conversation" }));
  fake.jobs.start.mockResolvedValue({ runId: "run_c" });
  fake.runs.sendChat.mockResolvedValue(undefined);
  await user.type(await screen.findByLabelText("Message"), "A fresh conversation{Enter}");
  await waitFor(() => expect(fake.runs.sendChat.mock.calls[0]?.[0]).toEqual({ runId: "run_c", text: "A fresh conversation" }));
});
