// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ workspace: { auditRetention: vi.fn(), setAuditRetention: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { AuditRetention } = await import("./AuditRetention.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("the retention shows, refuses what is out of bounds, saves, and shows the saved value", async () => {
  fake.workspace.auditRetention.mockResolvedValueOnce({ days: 90 }).mockResolvedValue({ days: 30 });
  fake.workspace.setAuditRetention.mockResolvedValue({ days: 30 });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuditRetention />
    </QueryClientProvider>,
  );
  const input = (await screen.findByLabelText("Keep Audit for")) as HTMLInputElement;
  expect(input.value).toBe("90");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  const user = userEvent.setup();
  await user.clear(input);
  await user.type(input, "3651");
  expect(screen.getByRole("alert").textContent).toBe("A whole number from 1 to 3,650");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(input);
  await user.type(input, "30");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.workspace.setAuditRetention.mock.calls[0]![0]).toEqual({ days: 30 });
  // Saved: the field follows the setting again, read back from the server.
  await vi.waitFor(() => expect(fake.workspace.auditRetention).toHaveBeenCalledTimes(2));
  expect(input.value).toBe("30");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});
