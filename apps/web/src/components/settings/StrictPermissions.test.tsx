// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ workspace: { strictPermissions: vi.fn(), setStrictPermissions: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { StrictPermissions } = await import("./StrictPermissions.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("strict permissions show off by default, say what each mode binds, and turn on in place", async () => {
  fake.workspace.strictPermissions.mockResolvedValueOnce({ strict: false }).mockResolvedValue({ strict: true });
  fake.workspace.setStrictPermissions.mockResolvedValue({ strict: true });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StrictPermissions />
    </QueryClientProvider>,
  );
  const box = (await screen.findByRole("checkbox", { name: /Enable strict permissions/ })) as HTMLInputElement;
  expect(box.checked).toBe(false);
  screen.getByText(/Off, a choice remembered/);
  screen.getByText(/On, it also holds only/);
  await userEvent.setup().click(box);
  expect(fake.workspace.setStrictPermissions.mock.calls[0]![0]).toEqual({ strict: true });
  await vi.waitFor(() => expect(box.checked).toBe(true));
});
