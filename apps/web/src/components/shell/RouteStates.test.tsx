// @vitest-environment jsdom
import { type AnyRoute, createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { routeStates } from "./RouteStates.tsx";

afterEach(cleanup);

async function renderAt(url: string, children: (root: AnyRoute) => AnyRoute[]) {
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren(children(root)),
    history: createMemoryHistory({ initialEntries: [url] }),
    defaultPendingMs: 0,
    ...routeStates,
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
}

test("a route that throws while rendering shows a generic error, and its retry renders it again", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  let broken = true;
  await renderAt("/", (root) => [
    createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => {
        if (broken) throw new Error("secret detail");
        return <p>All good</p>;
      },
    }),
  ]);
  expect((await screen.findByRole("alert")).textContent).toContain("This page failed to load");
  expect(screen.queryByText(/secret detail/)).toBeNull();
  broken = false;
  await act(() => userEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(await screen.findByText("All good")).toBeTruthy();
});

test("a route whose loading throws shows the same error, and its retry loads it again", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const beforeLoad = vi.fn().mockRejectedValueOnce(new Error("secret detail")).mockResolvedValue({});
  await renderAt("/", (root) => [createRoute({ getParentRoute: () => root, path: "/", beforeLoad, component: () => <p>Loaded</p> })]);
  expect((await screen.findByRole("alert")).textContent).toContain("This page failed to load");
  expect(screen.queryByText(/secret detail/)).toBeNull();
  await act(() => userEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(await screen.findByText("Loaded")).toBeTruthy();
  expect(beforeLoad).toHaveBeenCalledTimes(2);
});

test("a route that waits shows a loading state", async () => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => (release = resolve));
  await renderAt("/", (root) => [createRoute({ getParentRoute: () => root, path: "/", beforeLoad: () => waiting, component: () => <p>Loaded</p> })]);
  expect((await screen.findByRole("status")).textContent).toBe("Loading…");
  await act(async () => release());
  expect(await screen.findByText("Loaded")).toBeTruthy();
});

test("an unknown path shows a page not found with a way back", async () => {
  await renderAt("/nowhere", (root) => [createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> })]);
  expect(await screen.findByText("Page not found")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to Home" }).getAttribute("href")).toBe("/");
});
