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
const { StemMarks } = await import("./StemMarks.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("each field handed to Stem says where it is: Stem looking, its suggestion to accept, or the owner's three choices", async () => {
  fake.plugins.conflicts.mockResolvedValue([
    { id: "c1", field: "systemPrompt", status: "approval", mine: "Mine", next: "New", merged: "Mine, and New", reviewed: "r1" },
    { id: "c2", field: "description", status: "stem", mine: "a", next: "b", merged: null, reviewed: "r2" },
    { id: "c3", field: "name", status: "open", mine: "Mine", next: "Theirs", merged: null, reviewed: "r3" },
  ]);
  fake.plugins.resolveConflict.mockResolvedValue({ ok: true });
  const onResolved = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StemMarks kind="agent" id="agent_1" labels={{ systemPrompt: "Instructions", description: "Description", name: "Name" }} onResolved={onResolved} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Mine, and New")).toBeTruthy();
  expect(screen.getByText(/Stem is looking/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Accept Stem's" }));
  expect(fake.plugins.resolveConflict.mock.calls[0]![0]).toEqual({ id: "c1", choice: "accept", reviewed: "r1" });
  // The editor starts over from the saved element: its form can't write the old value back.
  await vi.waitFor(() => expect(onResolved).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "Let Stem deal with it" }));
  expect(fake.plugins.resolveConflict.mock.calls[1]![0]).toEqual({ id: "c3", choice: "stem", reviewed: "r3" });
});
