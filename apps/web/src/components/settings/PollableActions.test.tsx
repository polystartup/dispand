// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ tools: { pollable: vi.fn(), setPollable: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PollableActions } = await import("./PollableActions.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("each action says whether polls may read it and why not, and a tick changes the list", async () => {
  fake.tools.pollable.mockResolvedValue([
    { name: "search", readOnly: true, allowed: true, askedBy: [], pollable: true },
    { name: "read", readOnly: false, allowed: true, askedBy: ["Clerk"], pollable: false },
    { name: "send", readOnly: false, allowed: false, askedBy: [], pollable: false },
  ]);
  fake.tools.setPollable.mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PollableActions toolId="tool_mail" />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Not polled: Clerk must ask before using it.")).toBeTruthy();
  expect(screen.getByText("read-only, says the server")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("checkbox", { name: /send/ }));
  expect(fake.tools.setPollable.mock.calls[0]![0]).toEqual({ id: "tool_mail", actions: ["search", "read", "send"] });
});
