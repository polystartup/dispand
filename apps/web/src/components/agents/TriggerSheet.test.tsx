// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ triggers: { create: vi.fn(), update: vi.fn(), delete: vi.fn() }, tables: { list: vi.fn(), get: vi.fn() }, tools: { pollable: vi.fn(), list: vi.fn(), catalog: vi.fn() }, agents: { get: vi.fn() }, plugins: { resetOverride: vi.fn(), conflicts: vi.fn(), resolveConflict: vi.fn() } }));
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
  // A browser whose zone schedules can't read.
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "Mars/Olympus" } as Intl.ResolvedDateTimeFormatOptions);
  fake.triggers.create.mockResolvedValue({});
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "Morning mail");
  await user.click(screen.getByRole("radio", { name: "Schedule" }));
  expect(screen.queryByText("Unknown timezone")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toMatchObject({ config: { kind: "schedule", timezone: "Europe/Paris" } });
});

test("TriggerSheet starts a schedule in a browser's UTC", async () => {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "UTC" } as Intl.ResolvedDateTimeFormatOptions);
  fake.triggers.create.mockResolvedValue({});
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "Morning mail");
  await user.click(screen.getByRole("radio", { name: "Schedule" }));
  expect(screen.queryByText("Unknown timezone")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toMatchObject({ config: { kind: "schedule", timezone: "UTC" } });
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
  // Only primitive tables are offered, and Questions and Approvals.
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Pick a table", "A Question or an Approval", "Clients"]);
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

test("TriggerSheet creates a trigger on Questions and Approvals, with their operations and no fields", async () => {
  fake.triggers.create.mockResolvedValue({});
  fake.tables.list.mockResolvedValue([clients]);
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "Questions");
  await user.type(screen.getByLabelText("Instructions"), "Help.");
  await user.click(screen.getByRole("radio", { name: "Table change" }));
  await user.selectOptions(screen.getByLabelText("Table"), "interaction");
  // A row's changes aren't offered, nor its fields; a changed row's "updated" is dropped.
  expect(screen.queryByRole("checkbox", { name: "A row is changed" })).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: "One is asked" }));
  await user.click(screen.getByRole("checkbox", { name: "One is answered" }));
  expect(screen.queryByRole("checkbox", { name: "Any field" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toMatchObject({ config: { kind: "primitive", tableId: "interaction", operations: ["created", "answered"] } });
  expect(fake.tables.get).not.toHaveBeenCalled();
});

test("TriggerSheet drops the field filter with row changes", async () => {
  fake.triggers.create.mockResolvedValue({});
  fake.tables.list.mockResolvedValue([clients]);
  fake.tables.get.mockResolvedValue(clientFields);
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "New clients");
  await user.type(screen.getByLabelText("Instructions"), "Welcome them.");
  await user.click(screen.getByRole("radio", { name: "Table change" }));
  await user.selectOptions(screen.getByLabelText("Table"), "tbl_1");
  await user.click(await screen.findByRole("checkbox", { name: "Any field" }));
  await user.click(screen.getByRole("checkbox", { name: "A row is created" }));
  await user.click(screen.getByRole("checkbox", { name: "A row is changed" }));
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toMatchObject({ config: { kind: "primitive", tableId: "tbl_1", operations: ["created"] } });
  expect(fake.triggers.create.mock.calls[0]![0].config).not.toHaveProperty("fields");
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
      { eventId: "evt_2", at: new Date(), status: "stopped", message: "Stopped at a checkpoint" },
      { eventId: "evt_1", at: new Date(), status: "out-of-scope", message: "The agent may no longer read this table" },
    ],
  };
  const { user } = mount(trigger);
  expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Table change"]);
  const recent = screen.getByRole("list", { name: "Recent" }).textContent;
  expect(recent).toContain("Stopped: its work was declined at a checkpoint");
  expect(recent).toContain("Skipped: the agent may not read this");
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

test("TriggerSheet creates a poll trigger on an action a poll may read: its arguments, its paths, its interval and its hour's cap", async () => {
  fake.triggers.create.mockResolvedValue({});
  fake.agents.get.mockResolvedValue({ id: "agent_1", tools: [{ toolId: "tool_mail", name: "Mail", kind: "http" }] });
  fake.tools.pollable.mockResolvedValue([
    { name: "list_mail", readOnly: true, allowed: true, askedBy: [], pollable: true },
    { name: "send", readOnly: false, allowed: false, askedBy: [], pollable: false },
  ]);
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "New mail");
  await user.type(screen.getByLabelText("Instructions"), "Triage it.");
  await user.click(screen.getByRole("radio", { name: "Poll" }));
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(screen.getByRole("alert").textContent).toBe("Pick the tool and the action a poll reads");
  await user.selectOptions(await screen.findByLabelText("Tool"), "tool_mail");
  const action = await screen.findByLabelText("Action");
  await screen.findByRole("option", { name: "list_mail" });
  expect(screen.queryByRole("option", { name: "send" })).toBeNull();
  await user.selectOptions(action, "list_mail");
  const args = screen.getByLabelText("Arguments (JSON)");
  await user.clear(args);
  await user.type(args, "not json");
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(screen.getByRole("alert").textContent).toBe("The arguments aren't JSON");
  await user.clear(args);
  await user.paste('{"filter":"receivedDateTime gt {{lastPoll}}"}');
  await user.type(screen.getByLabelText("Items at"), "value");
  const every = screen.getByLabelText("Every (minutes)");
  await user.clear(every);
  await user.type(every, "10");
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toEqual({
    agentId: "agent_1",
    name: "New mail",
    instructions: "Triage it.",
    concurrency: "parallel",
    rateCap: 60,
    config: { kind: "poll", toolId: "tool_mail", action: "list_mail", arguments: { filter: "receivedDateTime gt {{lastPoll}}" }, itemsPath: "value", idPath: "id", interval: 600 },
  });
});

test("TriggerSheet edits a poll trigger as one, and shows what its latest polls found", async () => {
  fake.triggers.update.mockResolvedValue({});
  fake.agents.get.mockResolvedValue({ id: "agent_1", tools: [{ toolId: "tool_mail", name: "Mail", kind: "http" }] });
  fake.tools.pollable.mockResolvedValue([{ name: "list_mail", readOnly: true, allowed: true, askedBy: [], pollable: true }]);
  const config = { kind: "poll", toolId: "tool_mail", action: "list_mail", arguments: { top: 10 }, itemsPath: "value", idPath: "id", interval: 300 };
  const { user } = mount({
    id: "trigger_1",
    agentId: "agent_1",
    name: "New mail",
    kind: "poll",
    enabled: true,
    instructions: "Triage it.",
    concurrency: "parallel",
    rateCap: 5,
    config,
    lastFires: [],
    lastEvents: [],
    lastPolls: [
      { at: new Date("2026-11-12T09:05:00Z"), status: "polled", found: 3, fresh: 1, message: "1 item(s) without an id at “id” left out", items: [{ itemId: "m3", status: "started", runId: "run_1" }] },
      { at: new Date("2026-11-12T09:00:00Z"), status: "skipped", found: 0, fresh: 0, message: "The agent doesn't have this tool", items: [] },
    ],
  });
  expect(screen.queryByRole("radio", { name: "Chat" })).toBeNull();
  const polls = screen.getByRole("list", { name: "Latest polls" });
  expect(polls.textContent).toContain("3 item(s), 1 new (1 item(s) without an id at “id” left out)");
  expect(polls.textContent).toContain("m3");
  expect(polls.textContent).toContain("Skipped: The agent doesn't have this tool");
  await screen.findByRole("option", { name: "list_mail" });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.triggers.update.mock.calls[0]![0]).toMatchObject({ id: "trigger_1", rateCap: 5, enabled: true, config });
});

test("TriggerSheet fills a poll from the catalog preset of the tool picked, continuation included", async () => {
  fake.triggers.create.mockResolvedValue({});
  fake.agents.get.mockResolvedValue({ id: "agent_1", tools: [{ toolId: "tool_outlook", name: "Outlook", kind: "runner" }] });
  fake.tools.pollable.mockResolvedValue([{ name: "list-mail-folder-messages", readOnly: true, allowed: true, askedBy: [], pollable: true }]);
  fake.tools.list.mockResolvedValue([{ id: "tool_outlook", name: "Outlook", catalogId: "microsoft-365" }]);
  const preset = {
    action: "list-mail-folder-messages",
    arguments: { mailFolderId: "inbox", filter: "receivedDateTime ge {{lastPoll}}" },
    itemsPath: "value",
    idPath: "id",
    continuation: { path: "@odata.nextLink", argument: "skiptoken" },
  };
  fake.tools.catalog.mockResolvedValue([{ id: "microsoft-365", name: "Microsoft 365 mail", kind: "runner", poll: preset }]);
  const { user } = mount();
  await user.type(screen.getByLabelText("Name"), "New mail");
  await user.click(screen.getByRole("radio", { name: "Poll" }));
  await screen.findByRole("option", { name: "Outlook" });
  await vi.waitFor(() => expect(fake.tools.catalog).toHaveBeenCalled());
  await user.selectOptions(screen.getByLabelText("Tool"), "tool_outlook");
  await screen.findByText(/Filled in from the tool's catalog entry/);
  expect(screen.getByText(/Pages through the result/).textContent).toContain("@odata.nextLink");
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(fake.triggers.create.mock.calls[0]![0]).toMatchObject({ config: { kind: "poll", toolId: "tool_outlook", interval: 300, ...preset } });
});

test("a plugin's trigger has no Delete, and a reset that fails says so", async () => {
  fake.plugins.resetOverride.mockRejectedValue(new Error("refused"));
  const trigger = { id: "trigger_1", agentId: "agent_1", name: "Go", kind: "manual", enabled: true, instructions: "Mine.", concurrency: "parallel", rateCap: 60, config: { kind: "manual", placement: "button" }, lastFires: [], lastEvents: [], lastPolls: [], plugin: { id: "plugin_1", name: "law-firm" }, overridden: ["instructions"] };
  const { user } = mount(trigger as never);
  expect(screen.getByText(/It is law-firm's/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete trigger" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Reset What the agent is told to the plugin's" }));
  expect(fake.plugins.resetOverride.mock.calls[0]![0]).toEqual({ kind: "trigger", id: "trigger_1", field: "instructions" });
  expect((await screen.findByRole("alert")).textContent).toContain("Could not reset the field");
});
