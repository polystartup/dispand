// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ triggers: { create: vi.fn(), update: vi.fn(), delete: vi.fn() }, tables: { list: vi.fn(), get: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { TriggerSheet } = await import("./TriggerSheet.tsx");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

test("TriggerSheet doesn't save while the schedule shown can't be saved", async () => {
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "Morning mail");
  await user.click(screen.getByRole("radio", { name: "Schedule" }));
  await user.click(screen.getByRole("radio", { name: "Custom" }));
  await user.clear(screen.getByLabelText("Cron"));
  await user.type(screen.getByLabelText("Cron"), "invalid");
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create).not.toHaveBeenCalled();
  expect(screen.getByText("Fix the schedule first")).toBeTruthy();
});

test("TriggerSheet starts a schedule in a timezone schedules accept, whatever the browser's", async () => {
  // A browser set to UTC: schedules take IANA zones only.
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "UTC" } as Intl.ResolvedDateTimeFormatOptions);
  fake.triggers.create.mockResolvedValue({});
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "Morning mail");
  await user.click(screen.getByRole("radio", { name: "Schedule" }));
  expect(screen.queryByText("Unknown timezone")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toMatchObject({ config: { kind: "schedule", timezone: "Europe/Paris" } });
});

const clients = { id: "tbl_1", name: "Clients", primitive: true, rowCount: 2, updatedAt: new Date() };
const clientFields = { id: "tbl_1", name: "Clients", fields: [{ id: "fld_name", name: "Name" }, { id: "fld_city", name: "City" }] };

test("TriggerSheet creates a table-change trigger on a primitive table: its changes, its fields and its hour's cap", async () => {
  fake.triggers.create.mockResolvedValue({});
  fake.tables.list.mockResolvedValue([clients, { ...clients, id: "tbl_2", name: "Notes", primitive: false }]);
  fake.tables.get.mockResolvedValue(clientFields);
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "New clients");
  await user.type(screen.getByLabelText("Instructions"), "Welcome them.");
  await user.click(screen.getByRole("radio", { name: "Table change" }));
  // Only primitive tables are offered.
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Pick a table", "Clients"]);
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(screen.getByRole("alert").textContent).toBe("Pick the table whose changes start the Job");
  await user.selectOptions(screen.getByLabelText("Table"), "tbl_1");
  await user.click(screen.getByRole("checkbox", { name: "A row is created" }));
  await user.click(await screen.findByRole("checkbox", { name: "Any field" }));
  await user.click(screen.getByRole("checkbox", { name: "City" }));
  await user.clear(screen.getByLabelText("At most, Jobs an hour"));
  await user.type(screen.getByLabelText("At most, Jobs an hour"), "10");
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toEqual({
    agentId: "agent_1",
    name: "New clients",
    instructions: "Welcome them.",
    concurrency: "parallel",
    rateCap: 10,
    config: { kind: "primitive", tableId: "tbl_1", operations: ["updated", "created"], fields: ["fld_city"] },
  });
});

test("TriggerSheet edits a table-change trigger as one, and shows what its latest events did", async () => {
  fake.triggers.update.mockResolvedValue({});
  fake.tables.list.mockResolvedValue([clients]);
  fake.tables.get.mockResolvedValue(clientFields);
  const trigger = {
    id: "trigger_1",
    agentId: "agent_1",
    name: "On change",
    kind: "primitive",
    enabled: true,
    instructions: "Look.",
    concurrency: "parallel",
    rateCap: 60,
    config: { kind: "primitive", tableId: "tbl_1", operations: ["deleted"] },
    lastFires: [],
    lastEvents: [
      { eventId: "evt_2", at: new Date(), status: "chain-limit", message: "Chain limit reached" },
      { eventId: "evt_1", at: new Date(), status: "out-of-scope", message: "The agent may no longer read this table" },
    ],
  };
  const { user } = mount(trigger);
  expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Table change"]);
  const recent = screen.getByRole("list", { name: "Recent" }).textContent;
  expect(recent).toContain("Skipped: chain limit reached");
  expect(recent).toContain("Skipped: the agent may no longer read this table");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.triggers.update.mock.calls[0]![0]).toEqual({
    id: "trigger_1",
    name: "On change",
    instructions: "Look.",
    concurrency: "parallel",
    enabled: true,
    rateCap: 60,
    config: { kind: "primitive", tableId: "tbl_1", operations: ["deleted"] },
  });
});
