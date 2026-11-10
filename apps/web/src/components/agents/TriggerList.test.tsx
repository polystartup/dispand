// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  triggers: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  pages: { home: vi.fn() },
  widgets: { create: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));
const { TriggerList } = await import("./TriggerList.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const base = { agentId: "agent_1", enabled: true, instructions: "", concurrency: "parallel", lastFires: [] };
const daily = { ...base, id: "trigger_1", name: "Morning mail", kind: "schedule", config: { kind: "schedule", cron: "0 10 * * *", timezone: "Europe/Paris" }, nextFireAt: new Date("2026-11-05T09:00:00Z") };
const ask = { ...base, id: "trigger_2", name: "Ask the clerk", kind: "manual", config: { kind: "manual", placement: "chat" } };

function mount() {
  fake.pages.home.mockResolvedValue({ id: "page_home", widgets: [] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TriggerList agentId="agent_1" />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

test("TriggerList shows a schedule trigger's next run in its timezone", async () => {
  fake.triggers.list.mockResolvedValue([daily, ask]);
  mount();
  const row = (await screen.findByText("Morning mail")).closest("li")!;
  // 09:00 UTC is 10:00 in Paris.
  expect(within(row).getByText(/Next: Thu 5 Nov, 10:00 \(Europe\/Paris\)/)).toBeTruthy();
  expect(within(screen.getByText("Ask the clerk").closest("li")!).getByText("Chat")).toBeTruthy();
});

test("TriggerList says a paused schedule is paused, and an agent without trigger has none", async () => {
  fake.triggers.list.mockResolvedValue([{ ...daily, enabled: false }]);
  mount();
  expect(await screen.findByText(/Paused/)).toBeTruthy();
  cleanup();
  fake.triggers.list.mockResolvedValue([]);
  mount();
  expect(await screen.findByText("No trigger yet")).toBeTruthy();
});

test("TriggerList adds a manual trigger to Home", async () => {
  fake.triggers.list.mockResolvedValue([ask]);
  fake.widgets.create.mockResolvedValue({});
  const user = mount();
  await user.click(await screen.findByRole("button", { name: "Add Ask the clerk to Home" }));
  expect(fake.widgets.create.mock.calls[0]![0]).toEqual({ pageId: "page_home", type: "trigger-form", triggerId: "trigger_2" });
});
