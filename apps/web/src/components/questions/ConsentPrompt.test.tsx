// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ questions: { consent: vi.fn() }, runs: { get: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { ConsentPrompt } = await import("./ConsentPrompt.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const mount = (question: object) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConsentPrompt question={{ id: "q_1", runId: "run_1", ...question }} />
    </QueryClientProvider>,
  );

test("the subscriber continues another person's answer with one action, and doesn't answer again", async () => {
  fake.questions.consent.mockResolvedValue(undefined);
  const user = userEvent.setup();
  mount({ consent: "awaiting", yoursToConsent: true });
  expect(screen.getByText(/Someone else answered this on your personal action/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Continue with this answer" }));
  expect(fake.questions.consent).toHaveBeenCalledWith({ questionId: "q_1" }, expect.anything());
  expect(screen.queryByRole("button", { name: /Allow|Deny/ })).toBeNull();
});

test("a consent the server refuses says so", async () => {
  fake.questions.consent.mockRejectedValue(new Error("not found"));
  const user = userEvent.setup();
  mount({ consent: "awaiting", yoursToConsent: true });
  await user.click(screen.getByRole("button", { name: "Continue with this answer" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
});

test("anyone else sees it wait for the subscriber, with no button", () => {
  mount({ consent: "awaiting" });
  expect(screen.getByText(/Waiting for the subscriber to continue it/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("an answer whose action paused waits for its recovery", () => {
  mount({ consent: "given", recovery: true });
  expect(screen.getByText(/needs recovery before it can continue/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("an ordinary question, or a consent already given, shows nothing", () => {
  mount({});
  expect(document.body.textContent).toBe("");
  cleanup();
  mount({ consent: "given" });
  expect(document.body.textContent).toBe("");
});
