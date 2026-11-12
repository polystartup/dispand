// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  memories: { list: vi.fn(), write: vi.fn(), remove: vi.fn(), accept: vi.fn(), revert: vi.fn(), restore: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { MemoryPanel } = await import("./MemoryPanel.tsx");
type Where = Parameters<typeof MemoryPanel>[0]["where"];

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const when = new Date("2026-11-12T10:00:00Z");
const mine = { id: "mem_1", path: "billing.md", name: "Billing", description: "How we bill", type: "business", body: "Monthly.", author: { type: "user" }, acceptedAt: null, removedAt: null, updatedAt: when };
const agents = {
  id: "mem_2",
  path: "clients/acme.md",
  name: "Acme",
  description: "Acme's contact",
  type: "fact",
  body: "Write to Jo.",
  author: { type: "agent", agentId: "agt_1", runId: "run_1", configure: false, name: "Clerk" },
  acceptedAt: null,
  removedAt: null,
  updatedAt: when,
};

function show(list: unknown, where: Where = { scope: "workspace" }) {
  fake.memories.list.mockResolvedValue(list);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryPanel where={where} />
    </QueryClientProvider>,
  );
}

test("adds an entry", async () => {
  show({ index: "", entries: [], removed: [] });
  fake.memories.write.mockResolvedValue({ id: "mem_3" });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add entry" }));
  await user.type(screen.getByLabelText("Path"), "notes/tone.md");
  await user.type(screen.getByLabelText("Name"), "Tone");
  await user.type(screen.getByLabelText("Description"), "How we write to clients");
  await user.selectOptions(screen.getByLabelText("Type"), "practice");
  await user.type(screen.getByLabelText("Body"), "Plain words.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.memories.write.mock.calls[0]![0]).toEqual({
    where: { scope: "workspace" },
    entry: { path: "notes/tone.md", name: "Tone", description: "How we write to clients", type: "practice", body: "Plain words." },
  });
});

test("edits and removes an entry, and shows a refusal's reason", async () => {
  show({ index: "", entries: [mine], removed: [] });
  fake.memories.write.mockRejectedValueOnce(Object.assign(new Error("The body is at most 8000 characters."), { code: "BAD_REQUEST" }));
  fake.memories.remove.mockResolvedValue({ id: "mem_1" });
  const user = userEvent.setup();
  await user.click(within(await screen.findByRole("region", { name: "How the business works" })).getByRole("button", { name: /Billing/ }));
  expect(screen.getByText("Monthly.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect((screen.getByLabelText("Path") as HTMLInputElement).readOnly).toBe(true);
  await user.clear(screen.getByLabelText("Body"));
  await user.type(screen.getByLabelText("Body"), "Quarterly.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.memories.write.mock.calls[0]![0].entry).toMatchObject({ path: "billing.md", body: "Quarterly." });
  expect((await screen.findByRole("alert")).textContent).toBe("The body is at most 8000 characters.");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(fake.memories.remove.mock.calls[0]![0]).toEqual({ id: "mem_1" });
});

test("an agent's entry offers Accept and Revert with what accepting does; a person's doesn't", async () => {
  show({ index: "", entries: [mine, agents], removed: [] });
  fake.memories.accept.mockResolvedValue({ id: "mem_2" });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Acme/ }));
  expect(screen.getByText(/^Clerk · /)).toBeTruthy();
  expect(screen.getByText("Accepting lets this entry instruct agents that configure the workspace.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revert" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Accept" }));
  expect(fake.memories.accept.mock.calls[0]![0]).toEqual({ id: "mem_2" });
  await user.click(await screen.findByRole("button", { name: /Billing/ }));
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
});

test("a removed entry is listed under Removed with Restore", async () => {
  show({ index: "", entries: [mine], removed: [{ ...agents, removedAt: when }] });
  fake.memories.restore.mockResolvedValue({ id: "mem_2" });
  const user = userEvent.setup();
  await user.click(within(await screen.findByRole("region", { name: "Removed" })).getByRole("button", { name: /Acme/ }));
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Restore" }));
  expect(fake.memories.restore.mock.calls[0]![0]).toEqual({ id: "mem_2" });
});

// The table page and the agent page show the same panel under their own scope.
const scopes: [string, Where][] = [
  ["a table", { scope: "table", tableId: "tbl_1" }],
  ["an agent", { scope: "agent", agentId: "agt_1" }],
];

test.each(scopes)("%s: lists its entries, and adds, edits, accepts, reverts and removes one in its scope", async (_name, where) => {
  show({ index: "", entries: [mine, agents], removed: [] }, where);
  fake.memories.write.mockResolvedValue({ id: "mem_3" });
  fake.memories.accept.mockResolvedValue({ id: "mem_2" });
  fake.memories.revert.mockResolvedValue({ id: "mem_2" });
  fake.memories.remove.mockResolvedValue({ id: "mem_1" });
  const user = userEvent.setup();
  await screen.findByRole("button", { name: /Billing/ });
  expect(fake.memories.list.mock.calls[0]![0]).toEqual(where);

  await user.click(screen.getByRole("button", { name: "Add entry" }));
  await user.type(screen.getByLabelText("Path"), "tone.md");
  await user.type(screen.getByLabelText("Name"), "Tone");
  await user.type(screen.getByLabelText("Description"), "How we write");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.memories.write.mock.calls[0]![0]).toMatchObject({ where, entry: { path: "tone.md", name: "Tone" } });

  await user.click(await screen.findByRole("button", { name: /Billing/ }));
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.type(screen.getByLabelText("Body"), " More.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.memories.write.mock.calls[1]![0]).toMatchObject({ where, entry: { path: "billing.md", body: "Monthly. More." } });

  await user.click(await screen.findByRole("button", { name: /Acme/ }));
  await user.click(screen.getByRole("button", { name: "Accept" }));
  expect(fake.memories.accept.mock.calls[0]![0]).toEqual({ id: "mem_2" });
  await user.click(await screen.findByRole("button", { name: /Acme/ }));
  await user.click(screen.getByRole("button", { name: "Revert" }));
  expect(fake.memories.revert.mock.calls[0]![0]).toEqual({ id: "mem_2" });

  await user.click(await screen.findByRole("button", { name: /Billing/ }));
  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(fake.memories.remove.mock.calls[0]![0]).toEqual({ id: "mem_1" });
});

test("an entry agents that configure don't read says so, with Accept; an accepted one, a person's and one written with configure don't", async () => {
  const accepted = { ...agents, id: "mem_3", path: "a.md", name: "Accepted", description: "Taken", acceptedAt: when };
  const configured = { ...agents, id: "mem_4", path: "b.md", name: "Configured", description: "Kept", author: { ...agents.author, configure: true } };
  show({ index: "", entries: [mine, agents, accepted, configured], removed: [] }, { scope: "agent", agentId: "agt_1" });
  const user = userEvent.setup();
  expect(within(await screen.findByRole("button", { name: /Acme/ })).getByText(/Not read by agents that configure/)).toBeTruthy();
  expect(screen.getAllByText(/Not read by agents that configure/)).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: /Acme/ }));
  expect(within(screen.getByRole("dialog")).getByText("Not read by agents that configure")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
  await user.keyboard("{Escape}");
  for (const name of [/Accepted/, /Configured/]) {
    await user.click(await screen.findByRole("button", { name }));
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revert" })).toBeTruthy();
    await user.keyboard("{Escape}");
  }
});
