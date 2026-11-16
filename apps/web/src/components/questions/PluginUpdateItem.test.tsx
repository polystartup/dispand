// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ questions: { list: vi.fn(), answer: vi.fn() }, plugins: { resolveConflict: vi.fn() }, agents: {}, tools: {}, triggers: {} }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => <a>{children as never}</a> }));
const { InboxItem } = await import("./InboxItem.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const item = (status: string, items: unknown[], answer: unknown = null) => ({
  id: "q_1",
  runId: "run_1",
  stepRunId: null,
  placement: "notifications",
  createdAt: new Date("2026-11-16T09:00:00Z"),
  orphaned: false,
  workflow: null,
  agent: { id: "agent_stem", name: "Stem", builtIn: "assistant" },
  trigger: null,
  run: { id: "run_1" },
  step: { name: "Stem" },
  kind: "approval",
  status,
  payload: { kind: "permission", toolName: "plugin_update", input: { pluginId: "plugin_1" }, canAlwaysAllow: false },
  answer,
  answeredAt: answer ? new Date("2026-11-16T09:05:00Z") : null,
  answeredBy: answer ? { type: "user", userId: "u" } : null,
  proposal: null,
  update: { plugin: { id: "plugin_1", name: "law-firm" }, items },
});

const entry = (id: string, name: string, field: string, merged: string) => ({ id, kind: "agent", elementId: "agent_1", name, field, status: "approval", mine: "Mine", next: "Next", merged, reviewed: `r_${id}` });

/** The Inbox keeps what an answer couldn't make, by question; here, one item's. */
function Kept({ value }: { value: unknown }) {
  const [notices, setNotices] = useState<string[]>([]);
  return <InboxItem item={value as never} notices={notices} onNotices={(said) => setNotices((prev) => [...prev, ...said])} />;
}

function mount(value: unknown) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Kept value={value} />
    </QueryClientProvider>,
  );
}

test("a plugin update's Approval lists each of Stem's values, each answered on its own", async () => {
  fake.plugins.resolveConflict.mockResolvedValue({ ok: true });
  mount(item("pending", [entry("c1", "Drafting", "systemPrompt", "Mine, and Next"), entry("c2", "Drafting", "description", "Merged description")]));
  expect(screen.getByText(/Stem merged these values for the update of law-firm/)).toBeTruthy();
  // No whole answer: the generic form isn't there.
  expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  const prompt = screen.getByRole("listitem", { name: "Drafting: Instructions" });
  expect(within(prompt).getByText("Mine, and Next")).toBeTruthy();
  await userEvent.click(within(prompt).getByRole("button", { name: "Accept Stem's" }));
  expect(fake.plugins.resolveConflict.mock.calls[0]![0]).toEqual({ id: "c1", choice: "accept", reviewed: "r_c1" });
  await userEvent.click(within(screen.getByRole("listitem", { name: "Drafting: Description" })).getByRole("button", { name: "Keep mine" }));
  expect(fake.plugins.resolveConflict.mock.calls[1]![0]).toEqual({ id: "c2", choice: "decline", reviewed: "r_c2" });
});

test("a skill file's merged text is named by the skill and the file's path", async () => {
  fake.plugins.resolveConflict.mockResolvedValue({ ok: true });
  mount(item("pending", [{ ...entry("c1", "legal", "file:legal/SKILL.md", "Mine, and the plugin's."), kind: "skill_file", elementId: "skillpkg_1" }]));
  const file = screen.getByRole("listitem", { name: "legal: legal/SKILL.md" });
  expect(within(file).getByText("Mine, and the plugin's.")).toBeTruthy();
  await userEvent.click(within(file).getByRole("button", { name: "Accept Stem's" }));
  expect(fake.plugins.resolveConflict.mock.calls[0]![0]).toEqual({ id: "c1", choice: "accept", reviewed: "r_c1" });
});

test("a refused answer says why; once done, the item says which update it was for and that each value was answered", async () => {
  fake.plugins.resolveConflict.mockRejectedValue(Object.assign(new Error("This conflict changed: look at it again."), { code: "CONFLICT" }));
  mount(item("pending", [entry("c1", "Drafting", "systemPrompt", "Mine, and Next")]));
  await userEvent.click(screen.getByRole("button", { name: "Accept Stem's" }));
  expect((await screen.findByRole("alert")).textContent).toBe("This conflict changed: look at it again.");
  cleanup();
  mount(item("answered", [], { kind: "permission", decision: "allow" }));
  expect(screen.getByText("Stem merged values for the update of law-firm.")).toBeTruthy();
  expect(screen.getByText("You answered each value.")).toBeTruthy();
});

test("a table's item shows each change Stem picked that removes values, with the values it removes, as plain text", async () => {
  fake.plugins.resolveConflict.mockResolvedValue({ ok: true, refused: [{ key: "remove:Conclusions", reason: { text: "It is the parent." } }] });
  const table = { id: "c3", kind: "table", elementId: "tbl_1", name: "Matters", field: "changes", status: "approval", mine: [], next: { definition: {}, changes: [{ key: "add:Fee", kind: "add", field: "Fee", ticked: true }, { key: "remove:Conclusions", kind: "remove", field: "Conclusions", ticked: false, loses: 1 }] }, merged: { keys: ["remove:Conclusions"], values: { "remove:Conclusions": { count: 51, shown: [["row_1", "<b>Settled.</b>"]], digest: "d" } } }, reviewed: "r_c3" };
  mount(item("pending", [table]));
  const li = screen.getByRole("listitem", { name: "Matters: Changes" });
  expect(within(li).getByText("Remove the field Conclusions")).toBeTruthy();
  expect(within(li).queryByText(/Add the field Fee/)).toBeNull();
  expect(within(li).getByText(/the field holds these now, in 51 rows/)).toBeTruthy();
  expect(within(li).getByText("And 50 more rows.")).toBeTruthy();
  expect(within(li).getByText("<b>Settled.</b>")).toBeTruthy();
  await userEvent.click(within(li).getByRole("button", { name: "Accept Stem's" }));
  expect(fake.plugins.resolveConflict).toHaveBeenCalledWith(expect.objectContaining({ id: "c3", choice: "accept", reviewed: "r_c3" }), expect.anything());
  // What wasn't made is said, by the Inbox item.
  expect(await screen.findByText(/“Remove the field Conclusions” wasn’t made: It is the parent\. The plugin’s next update offers it again\./)).toBeTruthy();
});
