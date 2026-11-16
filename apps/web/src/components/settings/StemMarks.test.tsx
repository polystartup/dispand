// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ plugins: { conflicts: vi.fn(), resolveConflict: vi.fn() }, agents: {}, tools: {}, triggers: {} }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to, search }: { children: unknown; to: string; search?: { item?: string } }) => <a href={`${to}?item=${search?.item ?? ""}`}>{children as never}</a> }));
const { StemMarks } = await import("./StemMarks.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("each field handed to Stem says where it is: Stem looking, its suggestion waiting in the Inbox's Approval (linked), or the owner's three choices", async () => {
  fake.plugins.conflicts.mockResolvedValue([
    { id: "c1", field: "systemPrompt", status: "approval", mine: "Mine", next: "New", merged: "Mine, and New", reviewed: "r1", approvalId: "q_9" },
    { id: "c2", field: "description", status: "stem", mine: "a", next: "b", merged: null, reviewed: "r2", approvalId: null },
    { id: "c3", field: "name", status: "open", mine: "Mine", next: "Theirs", merged: null, reviewed: "r3", approvalId: null },
  ]);
  fake.plugins.resolveConflict.mockResolvedValue({ ok: true });
  const onResolved = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StemMarks kind="agent" id="agent_1" labels={{ systemPrompt: "Instructions", description: "Description", name: "Name" }} onResolved={onResolved} />
    </QueryClientProvider>,
  );
  // Stem's value is answered in the Inbox, not here.
  const link = await screen.findByRole("link", { name: "Open the Approval in the Inbox" });
  expect(link.getAttribute("href")).toBe("/inbox?item=q_9");
  expect(screen.getByText(/waits for your Approval in the Inbox/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept Stem's" })).toBeNull();
  expect(screen.getByText(/Stem is looking/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Take the plugin's" }));
  expect(fake.plugins.resolveConflict.mock.calls[0]![0]).toEqual({ id: "c3", choice: "plugin", reviewed: "r3" });
  // The editor starts over from the saved element, read again first: its form can't write the old value back.
  await vi.waitFor(() => expect(onResolved).toHaveBeenCalled());
  expect(fake.plugins.conflicts.mock.invocationCallOrder.at(-1)!).toBeLessThan(onResolved.mock.invocationCallOrder[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Let Stem deal with it" }));
  expect(fake.plugins.resolveConflict.mock.calls[1]![0]).toEqual({ id: "c3", choice: "stem", reviewed: "r3" });
});

test("before Stem's Job ends, its suggestion says its Approval is on the way, with no link yet", async () => {
  fake.plugins.conflicts.mockResolvedValue([{ id: "c1", field: "systemPrompt", status: "approval", mine: "Mine", next: "New", merged: "Mine, and New", reviewed: "r1", approvalId: null }]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StemMarks kind="agent" id="agent_1" labels={{}} onResolved={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/its Approval reaches the Inbox once Stem is done/)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});
