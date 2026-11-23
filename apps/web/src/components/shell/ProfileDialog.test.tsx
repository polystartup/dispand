// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ profile: { get: vi.fn(), update: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { ProfileDialog } = await import("./ProfileDialog.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function open(onOpenChange = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProfileDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

test("ProfileDialog › shows the counter and the hint, saves, and blocks above 1,000", async () => {
  fake.profile.get.mockResolvedValue({ description: "Billing" });
  fake.profile.update.mockResolvedValue({ description: "Refunds" });
  const onOpenChange = open();
  const box = (await screen.findByRole("textbox", { name: "Your profile" })) as HTMLTextAreaElement;
  await vi.waitFor(() => expect(box.value).toBe("Billing"));
  expect(screen.getByText("What you know and can answer. Agents in every workspace you belong to read this to decide whether to ask you.")).toBeTruthy();
  expect(screen.getByText("7 / 1,000")).toBeTruthy();

  const user = userEvent.setup();
  await user.clear(box);
  await user.click(box);
  await user.paste("a".repeat(1001));
  expect(screen.getByText("1,001 / 1,000")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

  await user.clear(box);
  await user.type(box, "  Refunds ");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.profile.update.mock.calls[0]![0]).toEqual({ description: "  Refunds " });
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

test("ProfileDialog › a failed save shows the error and keeps the text", async () => {
  fake.profile.get.mockResolvedValue({ description: null });
  fake.profile.update.mockRejectedValue(new Error("Could not save"));
  open();
  const box = (await screen.findByRole("textbox", { name: "Your profile" })) as HTMLTextAreaElement;
  // Disabled until the saved text is read.
  await vi.waitFor(() => expect(box.disabled).toBe(false));
  const user = userEvent.setup();
  await user.type(box, "Billing");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not save");
  expect(box.value).toBe("Billing");
});

test("ProfileDialog › reopening shows nothing cached: it waits for what the server has now", async () => {
  fake.profile.get.mockResolvedValueOnce({ description: "Billing" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (isOpen: boolean) => (
    <QueryClientProvider client={client}>
      <ProfileDialog open={isOpen} onOpenChange={vi.fn()} />
    </QueryClientProvider>
  );
  const { rerender } = render(view(true));
  const box = () => screen.getByRole("textbox", { name: "Your profile" }) as HTMLTextAreaElement;
  await vi.waitFor(() => expect(box().value).toBe("Billing"));
  rerender(view(false));
  await vi.waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  // Another person's session: the next read answers differently, and until it does the field is empty and locked.
  fake.profile.get.mockReturnValueOnce(new Promise(() => {}));
  rerender(view(true));
  expect(box().value).toBe("");
  expect(box().disabled).toBe(true);
});

test("ProfileDialog › a failed read on reopening shows no cached text and no way to save", async () => {
  fake.profile.get.mockResolvedValueOnce({ description: "Billing" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (isOpen: boolean) => (
    <QueryClientProvider client={client}>
      <ProfileDialog open={isOpen} onOpenChange={vi.fn()} />
    </QueryClientProvider>
  );
  const { rerender } = render(view(true));
  const box = () => screen.getByRole("textbox", { name: "Your profile" }) as HTMLTextAreaElement;
  await vi.waitFor(() => expect(box().value).toBe("Billing"));
  rerender(view(false));
  await vi.waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  fake.profile.get.mockRejectedValueOnce(new Error("Sign in"));
  rerender(view(true));
  await screen.findByRole("alert");
  expect(box().value).toBe("");
  expect(box().disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});
