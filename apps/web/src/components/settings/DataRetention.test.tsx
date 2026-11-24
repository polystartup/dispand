// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ organization: { retention: vi.fn(), setRetention: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { DataRetention } = await import("./DataRetention.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("the organization's data retention shows both settings and saves them together, within 1 to 3,650 days", async () => {
  fake.organization.retention.mockResolvedValue({ personDays: 90, auditDays: 730 });
  fake.organization.setRetention.mockResolvedValue({ personDays: 30, auditDays: 365 });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DataRetention />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("heading", { name: "Data retention" })).toBeTruthy();
  const person = screen.getByLabelText("Permanently delete users and their data") as HTMLInputElement;
  const audit = screen.getByLabelText("Prune audit records older than") as HTMLInputElement;
  expect([person.value, audit.value]).toEqual(["90", "730"]);
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const user = userEvent.setup();
  await user.clear(audit);
  await user.type(audit, "3651");
  expect(screen.getByRole("alert").textContent).toBe("A whole number of days from 1 to 3,650");
  expect(save.disabled).toBe(true);
  await user.clear(audit);
  await user.type(audit, "365");
  await user.clear(person);
  await user.type(person, "30");
  await user.click(save);
  expect(fake.organization.setRetention.mock.calls[0]![0]).toEqual({ personDays: 30, auditDays: 365 });
});
