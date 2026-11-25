// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import "../../test/jsdom-shims.ts";

const fake = vi.hoisted(() => ({ runners: { subscriptions: vi.fn(), startEnrollment: vi.fn(), endSubscription: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { Subscriptions } = await import("./Subscriptions.tsx");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

const runner = { id: "r1", name: "Workstation", status: "online", lastSeenAt: new Date(), clis: { codex: { version: "0.169.0", signedIn: true } } };
const row = (over: object = {}) => ({ id: "enr_1", runnerId: "r1", harness: "codex", mine: true, createdAt: new Date(), signInNeeded: false, ...over });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function mount(queryClient = client()) {
  render(
    <QueryClientProvider client={queryClient}>
      <Subscriptions runner={runner as never} />
    </QueryClientProvider>,
  );
  return queryClient;
}

test("not enrolled: it says so and offers to enroll", async () => {
  fake.runners.subscriptions.mockResolvedValue([]);
  mount();
  expect(await screen.findByText("Not enrolled.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Enroll my subscription" })).toBeTruthy();
});

test("a runner with neither CLI shows nothing", () => {
  fake.runners.subscriptions.mockResolvedValue([]);
  render(<QueryClientProvider client={client()}><Subscriptions runner={{ ...runner, clis: {} } as never} /></QueryClientProvider>);
  expect(screen.queryByText("Your subscription")).toBeNull();
});

test("a runner with Claude Code offers its own enrollment, with its own command", async () => {
  fake.runners.subscriptions.mockResolvedValue([row({ harness: "claude-code", signInNeeded: true })]);
  render(<QueryClientProvider client={client()}><Subscriptions runner={{ ...runner, clis: { claude: "2.1.0" } } as never} /></QueryClientProvider>);
  const card = await screen.findByLabelText("Claude Code");
  expect(within(card).getByLabelText("Command").textContent).toBe("dispand-runner sign-in claude-code");
  expect(screen.queryByLabelText("Codex")).toBeNull();
});

test("waiting for confirmation: the command carries no secret, the challenge is its own copyable value, and it is kept in no cache", async () => {
  fake.runners.subscriptions.mockResolvedValue([]);
  fake.runners.startEnrollment.mockResolvedValue({ challenge: "c-h-a-l-l-e-n-g-e-0123456789", expiresAt: new Date(Date.now() + 600_000) });
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const queryClient = mount();
  await user.click(await screen.findByRole("button", { name: "Enroll my subscription" }));
  expect(fake.runners.startEnrollment).toHaveBeenCalledWith({ runnerId: "r1" });
  expect(await screen.findByText("Waiting for you to confirm it on the runner.")).toBeTruthy();
  const command = screen.getByLabelText("Command");
  expect(command.textContent).toBe("dispand-runner enroll codex");
  expect(command.textContent).not.toContain("c-h-a-l-l-e-n-g-e");
  expect(screen.getByLabelText("Challenge").textContent).toBe("c-h-a-l-l-e-n-g-e-0123456789");
  await user.click(screen.getByRole("button", { name: "Copy Challenge" }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith("c-h-a-l-l-e-n-g-e-0123456789"));
  await user.click(screen.getByRole("button", { name: "Copy Command" }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith("dispand-runner enroll codex"));
  // Neither the mutation nor the query cache holds it.
  expect(JSON.stringify([queryClient.getMutationCache().getAll().map((m) => m.state), queryClient.getQueryCache().getAll().map((q) => q.state.data)])).not.toContain("c-h-a-l-l-e-n-g-e");
});

test("the challenge goes once it is enrolled, and when it expires", async () => {
  fake.runners.subscriptions.mockResolvedValue([]);
  fake.runners.startEnrollment.mockResolvedValue({ challenge: "c-h-a-l-l-e-n-g-e-0123456789", expiresAt: new Date(Date.now() + 600_000) });
  const user = userEvent.setup();
  const queryClient = mount();
  await user.click(await screen.findByRole("button", { name: "Enroll my subscription" }));
  await screen.findByLabelText("Challenge");
  // The runner confirmed it: the list shows it as the person's.
  fake.runners.subscriptions.mockResolvedValue([row()]);
  await queryClient.invalidateQueries();
  expect(await screen.findByText("Your subscription is enrolled on this runner.")).toBeTruthy();
  expect(screen.queryByLabelText("Challenge")).toBeNull();
  expect(screen.queryByText(/c-h-a-l-l-e-n-g-e/)).toBeNull();
  cleanup();

  // Past its expiry, with nothing confirmed.
  fake.runners.subscriptions.mockResolvedValue([]);
  fake.runners.startEnrollment.mockResolvedValue({ challenge: "e-x-p-i-r-i-n-g-0123456789", expiresAt: new Date(Date.now() + 200) });
  mount();
  await user.click(await screen.findByRole("button", { name: "Enroll my subscription" }));
  await screen.findByLabelText("Challenge");
  expect(await screen.findByText("The challenge expired. Start again.", {}, { timeout: 2000 })).toBeTruthy();
  expect(screen.queryByText(/e-x-p-i-r-i-n-g/)).toBeNull();
});

test("hiding the challenge removes it", async () => {
  fake.runners.subscriptions.mockResolvedValue([]);
  fake.runners.startEnrollment.mockResolvedValue({ challenge: "c-h-a-l-l-e-n-g-e-0123456789", expiresAt: new Date(Date.now() + 600_000) });
  const user = userEvent.setup();
  mount();
  await user.click(await screen.findByRole("button", { name: "Enroll my subscription" }));
  await user.click(await screen.findByRole("button", { name: "Hide the challenge" }));
  expect(screen.queryByLabelText("Challenge")).toBeNull();
});

test("enrolled: it says so, offers to revoke, and shows nothing about a sign-in", async () => {
  fake.runners.subscriptions.mockResolvedValue([row()]);
  mount();
  expect(await screen.findByText("Your subscription is enrolled on this runner.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop using my subscription" })).toBeTruthy();
  expect(screen.queryByText(/fresh sign-in/)).toBeNull();
});

test("sign-in needed: the command to run on the machine, and never a link, a code or a token", async () => {
  fake.runners.subscriptions.mockResolvedValue([row({ signInNeeded: true })]);
  mount();
  expect(await screen.findByText(/A fresh sign-in is needed/)).toBeTruthy();
  expect(screen.getByLabelText("Command").textContent).toBe("dispand-runner sign-in codex");
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("revoked: it asks the server, then shows it is gone and offers to enroll again", async () => {
  fake.runners.subscriptions.mockResolvedValueOnce([row()]).mockResolvedValue([]);
  fake.runners.endSubscription.mockResolvedValue(undefined);
  const user = userEvent.setup();
  mount();
  await user.click(await screen.findByRole("button", { name: "Stop using my subscription" }));
  expect(fake.runners.endSubscription).toHaveBeenCalledWith({ enrollmentId: "enr_1" }, expect.anything());
  expect(await screen.findByText("Your enrollment was revoked.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Enroll my subscription" })).toBeTruthy();
});

test("another person's enrollment is only said to exist: no name, and a manager sees its sign-in need", async () => {
  fake.runners.subscriptions.mockResolvedValue([row({ mine: false, signInNeeded: true })]);
  mount();
  const card = await screen.findByLabelText("Codex");
  expect(within(card).getByText(/Another person's subscription is enrolled/)).toBeTruthy();
  expect(within(card).getByText(/Its subscriber signs in again/)).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Stop using my subscription" })).toBeNull();
});

test("a start the server refuses says so", async () => {
  fake.runners.subscriptions.mockResolvedValue([]);
  fake.runners.startEnrollment.mockRejectedValue(new Error("no"));
  const user = userEvent.setup();
  mount();
  await user.click(await screen.findByRole("button", { name: "Enroll my subscription" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
});
