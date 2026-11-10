// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ runs: { stop: vi.fn(), list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { StopRun } = await import("./StopRun.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function mount(status: "running" | "waiting" | "succeeded" | "failed") {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
