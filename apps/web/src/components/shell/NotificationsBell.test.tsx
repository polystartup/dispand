// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ questions: { stream: vi.fn(), list: vi.fn(), count: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
const { usePendingQuestionsStream } = await import("./NotificationsBell.tsx");
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
