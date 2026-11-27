// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../lib/api.ts", async () => (await import("../../test/fake-api.ts")).apiModule());
const { fake } = await import("../../test/fake-api.ts");
const { widgetRow, homePage, triggerRow } = await import("../../test/fixtures.ts");
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children, useNavigate: () => navigate }));
const { TriggerList } = await import("./TriggerList.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const daily = triggerRow({
  id: "trigger_1",
  name: "Morning mail",
  kind: "schedule",
  config: { kind: "schedule", cron: "0 10 * * *", timezone: "Europe/Paris" },
  nextFireAt: new Date("2026-11-05T09:00:00Z"),
});
const ask = triggerRow({ id: "trigger_2", name: "Ask the clerk", kind: "manual", config: { kind: "manual", placement: "chat" } });

function mount() {
  const { home } = fake.pages;
  home.mockResolvedValue(homePage());
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
  expect(within(row).getByText(/Next: Thu, Nov 5, 10:00 \(Europe\/Paris\)/)).toBeTruthy();
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
  fake.widgets.create.mockResolvedValue(widgetRow());
  const user = mount();
  await user.click(await screen.findByRole("button", { name: "Add Ask the clerk to Home" }));
  expect(fake.widgets.create.mock.calls[0]![0]).toEqual({ pageId: "page_home", type: "trigger-form", triggerId: "trigger_2" });
});

test("TriggerList is in French", async () => {
  const { I18nextProvider } = await import("react-i18next");
  const { createI18n } = await import("../../lib/i18n.ts");
  fake.triggers.list.mockResolvedValue([{ ...daily, lastFires: [{ scheduledFor: new Date("2026-11-04T09:00:00Z"), status: "skipped-overlap" }] }, ask]);
  const { home } = fake.pages;
  home.mockResolvedValue(homePage());
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TriggerList agentId="agent_1" />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  const row = (await screen.findByText("Morning mail")).closest("li")!;
  expect(within(row).getByText(/Planification · Prochaine : .*10:00 \(Europe\/Paris\)/)).toBeTruthy();
  expect(within(row).getByText(/Dernier : .*, ignoré, un Job était encore en cours/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Nouveau déclencheur" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Ajouter Ask the clerk à l’Accueil" })).toBeTruthy();
});

test("TriggerList starts a manual button trigger and not a chat one", async () => {
  const press = { ...ask, id: "trigger_3", name: "Run the report", config: { kind: "manual" as const, placement: "button" as const } };
  fake.triggers.list.mockResolvedValue([ask, press]);
  fake.jobs.start.mockResolvedValue({ runId: "run_1" });
  const user = mount();
  await screen.findByText("Run the report");
  expect(screen.getAllByRole("button", { name: /^Start / })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Start Run the report" }));
  expect(fake.jobs.start.mock.calls[0]![0]).toMatchObject({ triggerId: "trigger_3" });
  // The started Job's page opens.
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/settings/workflows/runs/$runId", params: { runId: "run_1" } }));
});
