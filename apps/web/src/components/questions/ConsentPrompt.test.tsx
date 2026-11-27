// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../../lib/query-client.ts";

const fake = vi.hoisted(() => ({ questions: { consent: vi.fn(), list: vi.fn() }, runs: { get: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { ConsentPrompt } = await import("./ConsentPrompt.tsx");
const { orpc } = await import("../../lib/api.ts");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const mount = (question: object, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(
    <QueryClientProvider client={client}>
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

test.each(["succeeds", "fails"])("a consent that %s reads the questions once", async (outcome) => {
  fake.questions.list.mockResolvedValue([]);
  if (outcome === "fails") fake.questions.consent.mockRejectedValue(new Error("not found"));
  else fake.questions.consent.mockResolvedValue(undefined);
  const client = createQueryClient();
  const unsubscribe = new QueryObserver(client, orpc.questions.list.queryOptions({ input: {} })).subscribe(() => {});
  mount({ consent: "awaiting", yoursToConsent: true }, client);
  await vi.waitFor(() => expect(fake.questions.list).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "Continue with this answer" }));
  await vi.waitFor(() => expect(fake.questions.list).toHaveBeenCalledTimes(2));
  // A second read would follow at once.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(fake.questions.list).toHaveBeenCalledTimes(2);
  unsubscribe();
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
