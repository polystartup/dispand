// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../../lib/query-client.ts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../lib/api.ts", async () => (await import("../../test/fake-api.ts")).apiModule());
const { fake } = await import("../../test/fake-api.ts");
const { StrictPermissions } = await import("./StrictPermissions.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("strict permissions show off by default, say what each mode binds, and turn on in place", async () => {
  fake.workspace.strictPermissions.mockResolvedValueOnce({ strict: false }).mockResolvedValue({ strict: true });
  fake.workspace.setStrictPermissions.mockResolvedValue({ strict: true });
  render(
    <QueryClientProvider client={createQueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StrictPermissions />
    </QueryClientProvider>,
  );
  const box = await screen.findByRole<HTMLInputElement>("checkbox", { name: /Enable strict permissions/ });
  expect(box.checked).toBe(false);
  screen.getByText(/Off, a choice remembered/);
  screen.getByText(/On, it also holds only/);
  await userEvent.setup().click(box);
  expect(fake.workspace.setStrictPermissions.mock.calls[0]![0]).toEqual({ strict: true });
  await vi.waitFor(() => expect(box.checked).toBe(true));
});
