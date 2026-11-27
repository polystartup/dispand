// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../lib/api.ts", async () => (await import("../../test/fake-api.ts")).apiModule());
const { fake } = await import("../../test/fake-api.ts");
const { FilesLimitSetting } = await import("./FilesLimitSetting.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("the install's files limit shows and changes in place, within its bounds", async () => {
  fake.workspace.filesLimit.mockResolvedValue({ mib: 10_240 });
  fake.workspace.setFilesLimit.mockResolvedValue({ mib: 500 });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FilesLimitSetting />
    </QueryClientProvider>,
  );
  const input = await screen.findByLabelText<HTMLInputElement>("Keep at most");
  expect(input.value).toBe("10240");
  const user = userEvent.setup();
  await user.clear(input);
  await user.type(input, "0");
  expect(screen.getByRole("alert").textContent).toBe("A whole number from 1 to 1,048,576");
  await user.clear(input);
  await user.type(input, "500");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.workspace.setFilesLimit.mock.calls[0]![0]).toEqual({ mib: 500 });
});
