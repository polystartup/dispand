// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ triggers: { create: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { TriggerSheet } = await import("./TriggerSheet.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function mount(trigger?: unknown) {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TriggerSheet agentId="agent_1" trigger={trigger as never} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onClose };
}

test("TriggerSheet refuses an empty name and saves a chat trigger", async () => {
  fake.triggers.create.mockResolvedValue({});
  const { user, onClose } = mount();
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(screen.getByRole("alert").textContent).toBe("Give the trigger a name");
  expect(fake.triggers.create).not.toHaveBeenCalled();

  await user.type(screen.getByLabelText("Name"), "Ask the clerk");
  await user.type(screen.getByLabelText("Instructions"), "Help with the mail.");
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toEqual({
    agentId: "agent_1",
    name: "Ask the clerk",
    instructions: "Help with the mail.",
    concurrency: "parallel",
    config: { kind: "manual", placement: "chat" },
  });
  expect(onClose).toHaveBeenCalled();
});

test("TriggerSheet creates a schedule trigger, one at a time", async () => {
  fake.triggers.create.mockResolvedValue({});
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "Morning mail");
  await user.click(screen.getByRole("radio", { name: "Schedule" }));
  await user.click(screen.getByRole("radio", { name: "Every day" }));
  await user.click(screen.getByRole("checkbox", { name: /One at a time/ }));
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toMatchObject({
    name: "Morning mail",
    concurrency: "one-at-a-time",
    config: { kind: "schedule", cron: "0 9 * * *", timezone: expect.any(String) },
  });
});

test("TriggerSheet edits a trigger without changing its kind, and deletes it", async () => {
  fake.triggers.update.mockResolvedValue({});
  fake.triggers.delete.mockResolvedValue(undefined);
  const trigger = { id: "trigger_1", agentId: "agent_1", name: "Go", kind: "manual", enabled: true, instructions: "Old.", concurrency: "parallel", config: { kind: "manual", placement: "button" }, lastFires: [] };
  const { user } = mount(trigger);
  expect(screen.queryByRole("radio", { name: "Schedule" })).toBeNull();
  await user.clear(screen.getByLabelText("Instructions"));
  await user.type(screen.getByLabelText("Instructions"), "New.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.triggers.update.mock.calls[0]![0]).toEqual({
    id: "trigger_1",
    name: "Go",
    instructions: "New.",
    concurrency: "parallel",
    enabled: true,
    config: { kind: "manual", placement: "button" },
  });
  await user.click(screen.getByRole("button", { name: "Delete trigger" }));
  expect(fake.triggers.delete.mock.calls[0]![0]).toEqual({ id: "trigger_1" });
});
