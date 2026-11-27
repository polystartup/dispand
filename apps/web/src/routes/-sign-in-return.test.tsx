import { type AnyRoute, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { expect, test, vi } from "vitest";
import { workspaceSearch } from "../lib/workspace.tsx";
import { workspaceA } from "../test/workspace-router.tsx";

vi.mock("../lib/api.ts", () => ({ api: {}, orpc: {}, setWorkspace: () => {} }));
const { Route: App } = await import("./_app.tsx");
const { Route: Login } = await import("./login.tsx");

type ServerResult = { type: "render"; status: number } | { type: "redirect"; redirect: { options: { href: string } } };

/** The app's guard and sign-in's, loaded as the server render loads them (no DOM here): where the document goes. */
async function serverLoad(url: string, signedIn: boolean) {
  const auth = { needsSetup: false, user: signedIn ? { email: "ada@example.com" } : null, workspaces: [workspaceA] };
  const root = createRootRoute({ ...workspaceSearch, beforeLoad: () => ({ auth }) });
  // Typed as the app types them, under the generated tree: only their guards are under test here.
  const app = createRoute({ getParentRoute: () => root, id: "_app", beforeLoad: App.options.beforeLoad as never }) as unknown as AnyRoute;
  const routeTree = root.addChildren([
    app.addChildren([createRoute({ getParentRoute: () => app, path: "/" }), createRoute({ getParentRoute: () => app, path: "/settings/plugins" })]),
    createRoute({
      getParentRoute: () => root,
      path: "/login",
      validateSearch: Login.options.validateSearch,
      beforeLoad: Login.options.beforeLoad,
    } as never) as unknown as AnyRoute,
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }) });
  await router.load();
  const result = (router as unknown as { _serverResult: ServerResult })._serverResult;
  return result.type === "render" ? "rendered" : result.redirect.options.href;
}

test("signed out, a page sends to sign-in with its path and search to come back to; Home with none", async () => {
  expect(await serverLoad("/settings/plugins?add=acme/skill-x", false)).toBe(`/login?redirect=${encodeURIComponent("/settings/plugins?add=acme%2Fskill-x")}`);
  expect(await serverLoad("/", false)).toBe("/login");
});

test("signed in, sign-in sends back to the page it came from", async () => {
  const back = "/settings/plugins?add=acme%2Fskill-x";
  expect(await serverLoad(`/login?redirect=${encodeURIComponent(back)}`, true)).toBe(back);
  expect(await serverLoad("/login", true)).toBe("/");
});

test("signed in, sign-in never sends to another site, whatever ?redirect says", async () => {
  for (const hostile of [
    "//evil.example/",
    "/\\evil.example/",
    "https://evil.example/",
    "javascript:alert(1)",
    "/\t/evil.example/",
    "/\n/evil.example/",
    " /evil.example",
    // Not encoded, as no guard writes it: a header can't carry it.
    "/help?topic=日本語",
    "evil.example",
    "",
  ])
    expect(await serverLoad(`/login?redirect=${encodeURIComponent(hostile)}`, true), JSON.stringify(hostile)).toBe("/");
});
