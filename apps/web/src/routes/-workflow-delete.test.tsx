// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../lib/query-client.ts";

vi.mock("../lib/api.ts", async () => (await import("../test/fake-api.ts")).apiModule());
const { fake } = await import("../test/fake-api.ts");
// The graph and its side panel aren't what's under test.
vi.mock("../components/workflow/Canvas.tsx", () => ({ Canvas: () => null }));
vi.mock("../components/workflow/StepPanel.tsx", () => ({ StepPanel: () => null }));
const { Route } = await import("./_app.settings.workflows.$id.tsx");

beforeEach(() => {
  fake.agents.list.mockResolvedValue([]);
  fake.tables.list.mockResolvedValue([]);
  const { home } = fake.pages;
  home.mockResolvedValue({ id: "home", ownerId: "user_1", kind: "home", title: "Home", widgets: [] });
});
afterEach(cleanup);

test("Back after deleting a workflow doesn't reopen it from the cache", async () => {
  const user = userEvent.setup();
  const def = { trigger: { type: "manual" as const, field: { id: "start", key: "start", type: "button" as const, label: "Run" } }, steps: [], edges: [] };
  fake.workflows.get.mockResolvedValue({ id: "wf_1", name: "Invoices", version: 1, def, updatedAt: new Date(), archived: false, schedule: null, fires: [] });
  fake.workflows.delete.mockResolvedValue(undefined);

  const root = createRootRoute();
  // The tree as the app generates it: the editor reads its id from under `/_app`.
  const app = createRoute({ getParentRoute: () => root, id: "_app" });
  const editor = Route.update({ id: "/settings/workflows/$id", path: "/settings/workflows/$id", getParentRoute: () => app } as never);
  const list = createRoute({ getParentRoute: () => app, path: "/settings/workflows", component: () => <h1>The list</h1> });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([list, editor as never])]),
    history: createMemoryHistory({ initialEntries: ["/settings/workflows/wf_1"] }),
  });
  render(
    <QueryClientProvider client={createQueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Workflow menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete workflow" }));
  // The server's answer to the deleted one's id, held until the page has shown what it has meanwhile.
  let refuse!: (error: Error) => void;
  fake.workflows.get.mockClear().mockImplementation(() => new Promise((_resolve, reject) => (refuse = reject)));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete workflow" }));
  expect(await screen.findByRole("heading", { name: "The list" })).toBeTruthy();

  act(() => router.history.back());
  await vi.waitFor(() => expect(fake.workflows.get).toHaveBeenCalled());
  expect(screen.queryByRole("textbox", { name: "Workflow name" })).toBeNull();
  await act(async () => refuse(new Error("Not found")));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not load the workflow.");
  expect(screen.queryByRole("textbox", { name: "Workflow name" })).toBeNull();
});
