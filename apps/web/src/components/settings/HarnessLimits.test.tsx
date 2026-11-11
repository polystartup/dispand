// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ harnesses: { limits: vi.fn(), setLimit: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { HarnessLimits } = await import("./HarnessLimits.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HarnessLimits />
    </QueryClientProvider>,
  );

test("each harness shows what works and waits, and its limit changes in place", async () => {
  fake.harnesses.limits.mockResolvedValue([{ id: "harness_1", name: "Claude", kind: "claude-code", maxWorking: 5, working: 2, queued: 1 }]);
  fake.harnesses.setLimit.mockResolvedValue({ id: "harness_1", maxWorking: 8 });
  mount();
  expect(await screen.findByText("2 working · 1 waiting")).toBeTruthy();
  const input = screen.getByLabelText("At most at once");
  const user = userEvent.setup();
  await user.clear(input);
  await user.type(input, "0");
  expect(screen.getByRole("alert").textContent).toBe("A whole number from 1 to 100");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(input);
  await user.type(input, "8");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.harnesses.setLimit.mock.calls[0]![0]).toEqual({ id: "harness_1", maxWorking: 8 });
});
