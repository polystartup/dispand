// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ workspace: { checkpoint: vi.fn(), setCheckpoint: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { CheckpointSetting } = await import("./CheckpointSetting.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("the checkpoint shows and changes in place, within its bounds", async () => {
  fake.workspace.checkpoint.mockResolvedValue({ checkpoint: 100 });
  fake.workspace.setCheckpoint.mockResolvedValue({ checkpoint: 250 });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CheckpointSetting />
    </QueryClientProvider>,
  );
  const input = (await screen.findByLabelText("Ask every")) as HTMLInputElement;
  expect(input.value).toBe("100");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  const user = userEvent.setup();
  await user.clear(input);
  await user.type(input, "0");
  expect(screen.getByRole("alert").textContent).toBe("A whole number from 1 to 100,000");
  await user.clear(input);
  await user.type(input, "250");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.workspace.setCheckpoint.mock.calls[0]![0]).toEqual({ checkpoint: 250 });
});
