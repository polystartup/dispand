// @vitest-environment jsdom
import { type AnyRoute, createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Workspace, WorkspaceScope, workspaceSearch } from "../lib/workspace.tsx";
import { workspaceA, workspaceB } from "../test/workspace-router.tsx";

const fake = vi.hoisted(() => ({
  plugins: { discover: vi.fn(async () => []) },
  marketplaces: { list: vi.fn(async () => []), add: vi.fn(), sync: vi.fn(), remove: vi.fn() },
}));
vi.mock("../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never), setWorkspace: () => {} };
});
// Who is signed in, as the root's guard reads it on each navigation; the sign-in below signs Ada in.
const auth = vi.hoisted(() => ({ current: { needsSetup: false, user: null as { email: string } | null, workspaces: [] as Workspace[] } }));
vi.mock("../lib/auth-call.ts", () => ({
  signIn: vi.fn(async () => {
    auth.current = { ...auth.current, user: { email: "ada@example.com" } };
  }),
  authErrorMessage: () => "",
}));
const { Route: Plugins } = await import("./_app.settings.plugins.index.tsx");
const { Route: App } = await import("./_app.tsx");
const { Route: Login } = await import("./login.tsx");

beforeEach(() => {
  auth.current = { needsSetup: false, user: { email: "ada@example.com" }, workspaces: [workspaceA] };
  fake.marketplaces.add.mockReset().mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** The app's tree as it is generated, around the real guard, sign-in and Discover, opened at `url`. */
async function open(url: string, workspaces: Workspace[] = [workspaceA]) {
  auth.current = { ...auth.current, workspaces };
  const root = createRootRoute({
    ...workspaceSearch,
    beforeLoad: () => ({ auth: { ...auth.current } }),
    component: () => (
      <WorkspaceScope workspaces={root.useRouteContext({ select: (c) => c.auth.workspaces })} w={root.useSearch({ select: (s) => s.w })}>
        <Outlet />
      </WorkspaceScope>
    ),
  });
  const app = createRoute({ getParentRoute: () => root, id: "_app", beforeLoad: App.options.beforeLoad as never }) as unknown as AnyRoute;
  const discover = Plugins.update({ id: "/settings/plugins", path: "/settings/plugins", getParentRoute: () => app } as never);
  const login = Login.update({ id: "/login", path: "/login", getParentRoute: () => root } as never);
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([discover as never]), login as never]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await act(async () => {
    render(<RouterProvider router={router as never} />);
    await router.load();
  });
  return router;
}

const sourceField = () => screen.findByRole<HTMLInputElement>("textbox", { name: "Marketplace Git URL" });

test("a link opens the add form filled in, adds nothing until the owner confirms, then adds once", async () => {
  const router = await open("/settings/plugins?add=acme/skill-x");
  const field = await sourceField();
  expect(field.value).toBe("https://github.com/acme/skill-x.git");
  expect(document.activeElement).toBe(field);
  expect(screen.getByText(/^A link filled in this source\. Check its address, then add it\./).textContent).toMatch(/It is fetched from github\.com\.$/);
  await vi.waitFor(() => expect(fake.marketplaces.list).toHaveBeenCalled());
  expect(fake.marketplaces.add).not.toHaveBeenCalled();
  // Searching after the page opened keeps the focus where the person put it.
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Search plugins" }), "x");
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search plugins" }));

  await user.click(screen.getByRole("button", { name: "Add marketplace" }));
  await vi.waitFor(() => expect(fake.marketplaces.add).toHaveBeenCalledTimes(1));
  expect(fake.marketplaces.add.mock.calls[0]![0]).toEqual({ url: "https://github.com/acme/skill-x.git", kind: "git" });
  // Added: the address no longer fills the form, and the form is empty again.
  await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
  expect((await sourceField()).value).toBe("");
});

test("a link's skill site fills the form as given; a kind it doesn't know is a Git source", async () => {
  await open("/settings/plugins?add=https%3A%2F%2Fskills.example&kind=well-known");
  expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Skill site address" })).value).toBe("https://skills.example");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Kind of source" }).value).toBe("well-known");
  expect(screen.getByRole("button", { name: "Add skill site" })).toBeTruthy();
  cleanup();

  await open("/settings/plugins?add=acme/skill-x&kind=svn");
  expect((await sourceField()).value).toBe("https://github.com/acme/skill-x.git");
});

test("a link's source is only ever the field's text, and one the field couldn't hold is dropped", async () => {
  const hostile = `javascript:alert(1)//<img src=x onerror=alert(2)>`;
  await open(`/settings/plugins?add=${encodeURIComponent(hostile)}`);
  expect((await sourceField()).value).toBe(hostile);
  expect(document.querySelector("img")).toBeNull();
  expect([...document.querySelectorAll("[href], [src]")].filter((e) => /alert/.test(e.outerHTML))).toEqual([]);
  cleanup();

  // A look-alike letter in the host shows in the host it is fetched from.
  await open(`/settings/plugins?add=${encodeURIComponent("https://gіthub.com/acme/skill-x.git")}`);
  expect((await screen.findByText(/^A link filled in this source/)).textContent).toMatch(/It is fetched from xn--gthub-[a-z0-9]+\.com\.$/);
  cleanup();

  await open(`/settings/plugins?add=${"a".repeat(2001)}`);
  expect((await sourceField()).value).toBe("");
  expect(screen.queryByText(/^A link filled in this source/)).toBeNull();
  expect(fake.marketplaces.add).not.toHaveBeenCalled();
});

test("someone in two workspaces picks where the source goes, and a member sees why they can't add it", async () => {
  localStorage.setItem("dispand-workspace", "ws_b");
  const router = await open("/settings/plugins?add=acme/skill-x", [workspaceA, workspaceB]);
  // Pinned to the remembered workspace, the source kept; there Ada is a member.
  expect(await screen.findByText(/Only a manager of this workspace can add a source/)).toBeTruthy();
  expect(router.state.location.search).toEqual({ add: "acme/skill-x", w: "ws_b" });
  const where = screen.getByRole<HTMLSelectElement>("combobox", { name: "Add to" });
  expect(where.value).toBe("ws_b");

  await userEvent.setup().selectOptions(where, "ws_a");
  expect(await screen.findByText(/^A link filled in this source/)).toBeTruthy();
  expect(router.state.location.search).toEqual({ add: "acme/skill-x", w: "ws_a" });
  expect((await sourceField()).value).toBe("https://github.com/acme/skill-x.git");
  expect(fake.marketplaces.add).not.toHaveBeenCalled();
});

test("signed out, the link goes through sign-in and lands on the filled form", async () => {
  auth.current = { ...auth.current, user: null };
  const router = await open("/settings/plugins?add=acme/skill-x");
  expect(router.state.location.pathname).toBe("/login");
  expect(returnedTo(router.state.location.search)).toBe("/settings/plugins?add=acme%2Fskill-x");

  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email"), "ada@example.com");
  await user.type(screen.getByLabelText("Password"), "correct horse battery");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect((await sourceField()).value).toBe("https://github.com/acme/skill-x.git");
  expect(router.state.location).toMatchObject({ pathname: "/settings/plugins", search: { add: "acme/skill-x" } });
  expect(fake.marketplaces.add).not.toHaveBeenCalled();
});

const returnedTo = (search: unknown) => (search as { redirect?: string }).redirect;
