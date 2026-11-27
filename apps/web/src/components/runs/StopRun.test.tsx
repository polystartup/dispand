// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../../lib/query-client.ts";

vi.mock("../../lib/api.ts", async () => (await import("../../test/fake-api.ts")).apiModule());
const { fake } = await import("../../test/fake-api.ts");
const { StopRun } = await import("./StopRun.tsx");
const { orpc } = await import("../../lib/api.ts");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function mount(status: "running" | "waiting" | "succeeded" | "failed", client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <StopRun runId="run_1" status={status} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

test("StopRun asks before stopping a run still going, then stops it", async () => {
  fake.runs.stop.mockResolvedValue(undefined);
  const user = mount("waiting");
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(fake.runs.stop).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Stop this run" }));
  expect(fake.runs.stop.mock.calls[0]![0]).toEqual({ runId: "run_1" });
});

test("StopRun shows nothing for a run that is over, and says why a stop failed", async () => {
  mount("succeeded");
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  fake.runs.stop.mockRejectedValue(new Error("This run is over"));
  const user = mount("running");
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await user.click(screen.getByRole("button", { name: "Stop this run" }));
  expect((await screen.findByRole("alert")).textContent).toBe("This run is over");
});

test("a stop that fails reads the runs again: it may have applied in part", async () => {
  fake.runs.list.mockResolvedValue([]);
  fake.runs.stop.mockRejectedValue(new Error("Offline"));
  const client = createQueryClient();
  // A run list on screen.
  const unsubscribe = new QueryObserver(client, orpc.runs.list.queryOptions({ input: {} })).subscribe(() => {});
  const user = mount("running", client);
  await vi.waitFor(() => expect(fake.runs.list).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await user.click(screen.getByRole("button", { name: "Stop this run" }));
  await screen.findByRole("alert");
  await vi.waitFor(() => expect(fake.runs.list).toHaveBeenCalledTimes(2));
  unsubscribe();
});

test("StopRun is in French", async () => {
  const { createI18n } = await import("../../lib/i18n.ts");
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <QueryClientProvider client={new QueryClient()}>
        <StopRun runId="run_1" status="running" />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Arrêter" }));
  expect(screen.getByRole("button", { name: "Arrêter cette exécution" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "La laisser continuer" })).toBeTruthy();
});
