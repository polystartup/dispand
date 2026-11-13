// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ runners: { create: vi.fn(), list: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(fake as never) };
});
const { AddRunner } = await import("./AddRunner.tsx");
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

test("native plugin permission is opt-in and the copied installer command follows the choice", async () => {
  const command = "install --server https://dispand.test";
  fake.runners.create.mockResolvedValue({ runnerId: "r1", installCommand: command });
  fake.runners.list.mockResolvedValue([]);
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AddRunner onCancel={vi.fn()} onConnected={vi.fn()} /></QueryClientProvider>);
  await user.type(screen.getByLabelText("Runner name"), "Workstation");
  await user.click(screen.getByRole("button", { name: "Get the install command" }));
  const checkbox = await screen.findByRole("checkbox", { name: /Enable native plugin installation/ });
  expect((checkbox as HTMLInputElement).checked).toBe(false);
  expect(screen.getByLabelText("Install command").textContent).not.toContain("--native-plugins");
  await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "Copy command" }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith(`${command} --native-plugins`));
  await user.click(checkbox);
  expect(screen.getByLabelText("Install command").textContent?.trim()).toBe(command);
});
