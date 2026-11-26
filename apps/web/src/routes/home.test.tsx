import { ORPCError } from "@orpc/client";
import { type AnyRoute, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { type Workspace, workspaceSearch } from "../lib/workspace.tsx";
import { workspaceA, workspaceB } from "../test/workspace-router.tsx";

const getFirstLaunch = vi.hoisted(() => vi.fn());
vi.mock("../server/session.ts", () => ({ getFirstLaunch }));
vi.mock("../lib/api.ts", () => ({ orpc: {} }));
const { Route: Home } = await import("./_app.index.tsx");

type ServerResult = { type: "render"; status: number } | { type: "redirect"; redirect: { options: { href: string; statusCode: number } } };

/**
 * Home's guard under the app's root (its `?w`), with `/assistant` beside it, loaded as the server
 * render loads it (no DOM here): what the document would answer.
 */
async function serverLoad(workspaces: Workspace[], url: string) {
  const root = createRootRoute({ ...workspaceSearch, beforeLoad: () => ({ auth: { workspaces } }) });
  const routeTree = root.addChildren([
    // Typed as the app types it, under the generated tree: only its guard is under test here.
    createRoute({ getParentRoute: () => root, path: "/", beforeLoad: Home.options.beforeLoad as never }) as unknown as AnyRoute,
    createRoute({ getParentRoute: () => root, path: "/assistant" }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }) });
  await router.load();
  const result = (router as unknown as { _serverResult: ServerResult })._serverResult;
  return result.type === "render" ? { status: result.status } : { status: result.redirect.options.statusCode, location: result.redirect.options.href };
}

beforeEach(() => {
  getFirstLaunch.mockReset();
  // As the server answers: with no workspace named, someone in two has no membership to place the call in.
  getFirstLaunch.mockImplementation(async ({ data }: { data: unknown }) => {
    if (!data) throw new ORPCError("NOT_FOUND", { message: "Workspace or membership not found.", data: { key: "workspace.membershipNotFound" } });
    return false;
  });
});

test("Home's guard asks nothing while a tab with two workspaces names none of them, so Home renders instead of a 500", async () => {
  expect(await serverLoad([workspaceA, workspaceB], "/")).toEqual({ status: 200 });
  expect(await serverLoad([workspaceA, workspaceB], "/?w=ws_gone")).toEqual({ status: 200 });
  expect(getFirstLaunch).not.toHaveBeenCalled();
});

test("Home's guard asks in the workspace ?w names, and its first launch lands on the Assistant with ?w kept", async () => {
  getFirstLaunch.mockResolvedValue(true);
  expect(await serverLoad([workspaceA, workspaceB], "/?w=ws_b")).toEqual({ status: 307, location: "/assistant?w=ws_b" });
  expect(getFirstLaunch).toHaveBeenCalledWith({ data: { organizationId: "org_b", workspaceId: "ws_b" } });
});

test("Home's guard renders Home when ?w's workspace is past its first launch", async () => {
  expect(await serverLoad([workspaceA, workspaceB], "/?w=ws_a")).toEqual({ status: 200 });
  expect(getFirstLaunch).toHaveBeenCalledWith({ data: { organizationId: "org_a", workspaceId: "ws_a" } });
});

test("Home's guard still asks in the only workspace of a tab without ?w", async () => {
  expect(await serverLoad([workspaceA], "/")).toEqual({ status: 200 });
  expect(getFirstLaunch).toHaveBeenCalledWith({ data: { organizationId: "org_a", workspaceId: "ws_a" } });
});
