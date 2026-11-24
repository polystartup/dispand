// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ organization: { archived: vi.fn(), restoreMember: vi.fn(), directory: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { DeletedPeople } = await import("./DeletedPeople.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DeletedPeople />
  </QueryClientProvider>,
);

test("deleted people show with the date the purge takes them, and one is restored", async () => {
  const pat = { userId: "pat", name: "Pat", email: "pat@example.com", archivedAt: new Date("2026-11-01T10:00:00Z"), purgeAfter: new Date("2027-01-30T10:00:00Z") };
  fake.organization.archived.mockResolvedValueOnce([pat]).mockResolvedValue([]);
  fake.organization.restoreMember.mockResolvedValue({ restored: true });
  mount();
  const row = (await screen.findByText("Pat")).closest("li")!;
  expect(row.textContent).toContain("pat@example.com");
  expect(row.textContent).toMatch(/Deleted for good on .*2027/);
  await userEvent.setup().click(screen.getByRole("button", { name: "Restore Pat" }));
  expect(fake.organization.restoreMember.mock.calls[0]![0]).toEqual({ userId: "pat" });
  expect(await screen.findByText("Pat restored.")).toBeTruthy();
  expect(await screen.findByText("No deleted people.")).toBeTruthy();
});

test("a failed restore says why", async () => {
  fake.organization.archived.mockResolvedValue([{ userId: "pat", name: "Pat", email: "pat@example.com", archivedAt: new Date(), purgeAfter: new Date() }]);
  fake.organization.restoreMember.mockRejectedValue(new Error("Workspace or membership not found."));
  mount();
  await userEvent.setup().click(await screen.findByRole("button", { name: "Restore Pat" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Workspace or membership not found.");
});
