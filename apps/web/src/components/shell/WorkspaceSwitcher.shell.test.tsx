// @vitest-environment jsdom
import "../../test/jsdom-shims.ts";
import { ORPCError } from "@orpc/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { workspaceHeaders, setWorkspace } from "../../lib/api.ts";
import { type Workspace, WorkspaceScope, workspaceSearch } from "../../lib/workspace.tsx";
import { failing } from "../../shell/fixture.tsx";
import { renderWorkspaceRouter, workspaceA, workspaceB } from "../../test/workspace-router.tsx";

const create = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api.ts", async (original) => ({ ...(await original<typeof import("../../lib/api.ts")>()), api: { workspace: { create } } }));
const { WorkspaceSwitcherSlot } = await import("./WorkspaceSwitcher.tsx");

afterEach(() => {
  cleanup();
  setWorkspace(null);
  localStorage.clear();
  create.mockReset();
  failing.workspaceSwitcher = false;
});

const gamma: Workspace = { organizationId: "org_a", workspaceId: "ws_g", name: "Gamma", role: "owner" };

test("the shell's switcher shows with a single workspace", async () => {
  await renderWorkspaceRouter([workspaceA], "/", WorkspaceSwitcherSlot);
  expect(await screen.findByText("Fixture switcher in Alpha")).toBeTruthy();
});

test("the shell's create action makes the workspace in the current organization, then opens Home in it", async () => {
  let headers: Record<string, string> = {};
  create.mockImplementation(async () => {
    headers = workspaceHeaders();
    return { organizationId: "org_a", workspaceId: "ws_g" };
  });
  const router = await renderWorkspaceRouter([workspaceA, gamma], "/help?w=ws_a", WorkspaceSwitcherSlot);
  await userEvent.setup().click(await screen.findByRole("button", { name: "Create Gamma" }));
  await act(() => router.load());
  expect(create).toHaveBeenCalledWith({ name: "Gamma" });
  expect(headers).toEqual({ "dispand-organization": "org_a", "dispand-workspace": "ws_a" });
  expect(router.state.location).toMatchObject({ pathname: "/", search: { w: "ws_g" } });
});

test("the shell's create action rejects with the API's refusal and its key", async () => {
  create.mockRejectedValue(new ORPCError("FORBIDDEN", { message: "Limit reached.", data: { key: "workspace.selfHostedLimit" } }));
  await renderWorkspaceRouter([workspaceA], "/", WorkspaceSwitcherSlot);
  await userEvent.setup().click(await screen.findByRole("button", { name: "Create Gamma" }));
  expect((await screen.findByRole("alert")).textContent).toBe("workspace.selfHostedLimit");
});

test("a failing shell switcher shows the public one", async () => {
  failing.workspaceSwitcher = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await renderWorkspaceRouter([workspaceA, workspaceB], "/?w=ws_a", WorkspaceSwitcherSlot);
  expect(await screen.findByRole("button", { name: "Workspace Alpha, switch workspace" })).toBeTruthy();
  expect(screen.queryByText("Fixture switcher in Alpha")).toBeNull();
});

test("a shell switcher that fails in a server render renders the public one instead of failing the page", async () => {
  failing.workspaceSwitcher = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  const workspaces = [workspaceA, workspaceB];
  const root = createRootRoute({
    ...workspaceSearch,
    component: () => (
      <WorkspaceScope workspaces={workspaces} w={root.useSearch({ select: (search) => search.w })}>
        <Outlet />
      </WorkspaceScope>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/", component: WorkspaceSwitcherSlot })]),
    history: createMemoryHistory({ initialEntries: ["/?w=ws_a"] }),
    isServer: true,
  });
  await router.load();
  const stream = await renderToReadableStream(<RouterProvider router={router} />, { onError: () => {} });
  await stream.allReady;
  const html = await new Response(stream).text();
  expect(html).toContain("Workspace Alpha, switch workspace");
  expect(html).not.toContain("Fixture switcher");
});
