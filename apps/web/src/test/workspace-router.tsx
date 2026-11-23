import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import type { RouteComponent } from "@tanstack/react-router";
import { type Workspace, WorkspaceScope, workspaceSearch } from "../lib/workspace.tsx";

export const workspaceA: Workspace = { organizationId: "org_a", workspaceId: "ws_a", name: "Alpha", role: "owner" };
export const workspaceB: Workspace = { organizationId: "org_b", workspaceId: "ws_b", name: "Beta", role: "member" };

/** The app's root (its `?w` search and workspace scope) over `/` and `/help`, each rendering `Page`. */
export async function renderWorkspaceRouter(workspaces: Workspace[], url: string, Page: RouteComponent) {
  const root = createRootRoute({
    ...workspaceSearch,
    component: () => (
      <WorkspaceScope workspaces={workspaces} w={root.useSearch({ select: (search) => search.w })}>
        <Outlet />
      </WorkspaceScope>
    ),
  });
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/", component: Page }),
    createRoute({ getParentRoute: () => root, path: "/help", component: Page }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }) });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  return router;
}
