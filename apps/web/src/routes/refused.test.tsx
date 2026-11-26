// @vitest-environment jsdom
import "../test/jsdom-shims.ts";
import { ORPCError } from "@orpc/client";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ questions: { stream: vi.fn(), list: vi.fn(), count: vi.fn() } }));
vi.mock("../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never), setWorkspace: () => {} };
});
// The layout's own route, outside the generated route tree: its context is the signed-in person.
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options, useRouteContext: () => ({ user: { name: "Ada", email: "ada@example.com", language: null } }) }),
}));
vi.mock("../components/shell/Sidebar.tsx", () => ({ Sidebar: () => <nav>Sidebar</nav> }));
// The shell closes its mobile menu on a desktop-sized viewport; jsdom has no media queries.
window.matchMedia = (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })) as never;
const { Route } = await import("./_app.tsx");
const { forgetRefusals, noteRefusal, safeLink } = await import("../lib/organization-refusal.ts");
const { renderWorkspaceRouter, workspaceA, workspaceB } = await import("../test/workspace-router.tsx");
const AppShell = (Route as unknown as { options: { component: () => React.JSX.Element } }).options.component;

afterEach(() => {
  cleanup();
  forgetRefusals();
  vi.resetAllMocks();
  localStorage.clear();
});

const refusedError = (organizationId: string, link = "/help?about=access") =>
  new ORPCError("FORBIDDEN", { message: "This organization can't be used right now.", data: { key: "organization.refused", link, organizationId } });

/** The questions stream, open until the shell unmounts; its signals, to see it stop. */
function openStream() {
  const signals: AbortSignal[] = [];
  fake.questions.stream.mockImplementation(async (_input: unknown, { signal }: { signal: AbortSignal }) => {
    signals.push(signal);
    return (async function* () {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      yield* [];
    })();
  });
  return signals;
}

test("a refusal of the tab's organization replaces the shell with a page saying so, and the shell's stream stops", async () => {
  const signals = openStream();
  await renderWorkspaceRouter([workspaceA, workspaceB], "/?w=ws_a", AppShell);
  await waitFor(() => expect(signals).toHaveLength(1), { timeout: 4000 });

  act(() => noteRefusal(refusedError("org_a")));
  expect(await screen.findByRole("heading", { name: "Organization unavailable" })).toBeTruthy();
  expect(screen.getByText("This organization can't be used right now.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "See what to do" }).getAttribute("href")).toBe(`${window.location.origin}/help?about=access`);
  // Another workspace and sign-out stay at hand.
  expect(screen.getByRole("button", { name: "Workspace Alpha, switch workspace" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
  expect(screen.queryByText("Sidebar")).toBeNull();
  expect(signals[0]!.aborted).toBe(true);
});

test("a refusal of another organization leaves the tab's shell as it is", async () => {
  openStream();
  await renderWorkspaceRouter([workspaceA, workspaceB], "/?w=ws_a", AppShell);
  act(() => noteRefusal(refusedError("org_b")));
  expect(screen.getAllByText("Sidebar").length).toBeGreaterThan(0);
  expect(screen.queryByRole("heading", { name: "Organization unavailable" })).toBeNull();
});

test("Try again brings the shell back, which asks the server again", async () => {
  const signals = openStream();
  await renderWorkspaceRouter([workspaceA], "/", AppShell);
  act(() => noteRefusal(refusedError("org_a")));
  await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(screen.getAllByText("Sidebar").length).toBeGreaterThan(0);
  await waitFor(() => expect(signals.filter((s) => !s.aborted)).toHaveLength(1), { timeout: 4000 });
});

test("switching to another workspace and back asks again, instead of showing the old refusal", async () => {
  openStream();
  const router = await renderWorkspaceRouter([workspaceA, workspaceB], "/?w=ws_a", AppShell);
  act(() => noteRefusal(refusedError("org_a")));
  await screen.findByRole("heading", { name: "Organization unavailable" });
  await act(() => router.navigate({ to: "/", search: { w: "ws_b" } }));
  await act(() => router.navigate({ to: "/", search: { w: "ws_a" } }));
  expect(screen.getAllByText("Sidebar").length).toBeGreaterThan(0);
  expect(screen.queryByRole("heading", { name: "Organization unavailable" })).toBeNull();
});

test("a link that isn't an https address or a path of this origin shows no link", async () => {
  openStream();
  await renderWorkspaceRouter([workspaceA], "/", AppShell);
  act(() => noteRefusal(refusedError("org_a", "javascript:alert(1)")));
  await screen.findByRole("heading", { name: "Organization unavailable" });
  expect(screen.queryByRole("link")).toBeNull();
  const origin = "https://dispand.test";
  expect(["javascript:alert(1)", "//evil.example/x", "/\\evil.example/x", "\\\\evil.example/x", "data:text/html,x", "http://other.example/"].map((link) => safeLink(link, origin))).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  expect(["https://example.com/access?b=1", "/settings?x=1"].map((link) => safeLink(link, origin))).toEqual(["https://example.com/access?b=1", "https://dispand.test/settings?x=1"]);
});
