// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../lib/api.ts", async () => (await import("../test/fake-api.ts")).apiModule());
const { fake } = await import("../test/fake-api.ts");
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options, useParams: () => ({ runId: "job" }) }),
}));
const { Route } = await import("./_app.settings.workflows.runs.$runId.tsx");

afterEach(cleanup);

test("a shared job opens read-only and a denied refetch clears the cached result", async () => {
  fake.runs.access.mockResolvedValue({ canManage: false });
  fake.runs.stream.mockImplementation(async (_input, options) =>
    (async function* () {
      const signal = options!.signal!;
      yield {
        type: "snapshot",
        steps: [],
        messages: [],
        queue: [],
        questions: [],
        run: {
          id: "job",
          source: "agent",
          workflowId: null,
          version: 1,
          agentId: "agent_1",
          deletedAgentName: null,
          triggerId: null,
          status: "running",
          error: null,
          createdAt: new Date(0),
          finishedAt: null,
          harness: null,
          trigger: { type: "manual" },
        },
      };
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    })(),
  );
  fake.jobs.def.mockResolvedValue({
    trigger: { type: "manual", field: { id: "f", key: "build", type: "button", label: "Engineering build" } },
    steps: [],
    edges: [],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Page = Route.options.component as () => React.JSX.Element;
  render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("heading", { name: "Engineering build" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(fake.agents.list).not.toHaveBeenCalled();
  fake.runs.access.mockRejectedValue(new Error("Job unavailable"));
  await act(() => client.invalidateQueries());
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Engineering build" })).toBeNull();
});
