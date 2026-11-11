// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ navigate: vi.fn(), questions: { stream: vi.fn(), list: vi.fn(), count: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fake.navigate }));
const { NotificationsBell, usePendingQuestionsStream } = await import("./NotificationsBell.tsx");
const { orpc } = await import("../../lib/api.ts");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

function Count() {
  usePendingQuestionsStream();
  const { data } = useQuery(orpc.questions.count.queryOptions());
  return <p data-testid="count">{data?.count ?? "-"}</p>;
}

test("a count request still in flight can't overwrite the newer streamed count", async () => {
  // The first count read the database before the question came, and answers only late.
  let late!: (v: { count: number }) => void;
  fake.questions.count.mockImplementation(() => new Promise((resolve) => (late = resolve)));
  fake.questions.list.mockResolvedValue([{ id: "q1" }]);
  fake.questions.stream.mockImplementation(async (_i: unknown, { signal }: { signal: AbortSignal }) =>
    (async function* () {
      yield { count: 1 };
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    })(),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Count />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"), { timeout: 5000 });
  late({ count: 0 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByTestId("count").textContent).toBe("1");
});

/** A stream the test feeds: what the server pushes when an item is asked, answered or expires. */
function streamed() {
  const buffer: number[] = [];
  let wake: (() => void) | undefined;
  fake.questions.stream.mockImplementation(async (_i: unknown, { signal }: { signal: AbortSignal }) =>
    (async function* () {
      while (!signal.aborted) {
        while (buffer.length > 0) yield { count: buffer.shift()! };
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", () => resolve());
        });
      }
    })(),
  );
  return (count: number) => {
    buffer.push(count);
    wake?.();
  };
}

function Bell({ onNavigate = () => {} }: { onNavigate?: () => void }) {
  usePendingQuestionsStream();
  return <NotificationsBell onNavigate={onNavigate} />;
}

function renderBell(onNavigate?: () => void) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Bell onNavigate={onNavigate} />
    </QueryClientProvider>,
  );
}

const badge = () => screen.queryByTestId("pending-badge")?.textContent;
const WAIT = { timeout: 5000 };

test("the count follows an item asked, answered and expired, and says so in the bell's name", async () => {
  fake.questions.count.mockResolvedValue({ count: 0 });
  fake.questions.list.mockResolvedValue([]);
  const push = streamed();
  renderBell();
  const bell = () => screen.getByRole("button", { name: /^Inbox/ });
  expect(bell().getAttribute("aria-label")).toBe("Inbox");
  push(1);
  await waitFor(() => expect(badge()).toBe("1"), WAIT);
  expect(bell().getAttribute("aria-label")).toBe("Inbox, 1 waiting");
  push(3); // two more asked
  await waitFor(() => expect(badge()).toBe("3"), WAIT);
  expect(bell().getAttribute("aria-label")).toBe("Inbox, 3 waiting");
  push(2); // one answered
  await waitFor(() => expect(badge()).toBe("2"), WAIT);
  push(0); // the others expired
  await waitFor(() => expect(badge()).toBeUndefined(), WAIT);
  expect(bell().getAttribute("aria-label")).toBe("Inbox");
});

test("zero hides the badge", async () => {
  fake.questions.count.mockResolvedValue({ count: 0 });
  fake.questions.list.mockResolvedValue([]);
  streamed();
  renderBell();
  await waitFor(() => expect(fake.questions.count).toHaveBeenCalled());
  expect(badge()).toBeUndefined();
});

test("a long count reads 99+", async () => {
  fake.questions.count.mockResolvedValue({ count: 120 });
  fake.questions.list.mockResolvedValue([]);
  streamed();
  renderBell();
  await waitFor(() => expect(badge()).toBe("99+"));
});

test("the bell opens the Inbox and closes the sheet it is in", async () => {
  fake.questions.count.mockResolvedValue({ count: 2 });
  fake.questions.list.mockResolvedValue([]);
  streamed();
  const onNavigate = vi.fn();
  renderBell(onNavigate);
  fireEvent.click(await screen.findByRole("button", { name: "Inbox, 2 waiting" }));
  expect(fake.navigate).toHaveBeenCalledWith({ to: "/inbox" });
  expect(onNavigate).toHaveBeenCalledOnce();
});
