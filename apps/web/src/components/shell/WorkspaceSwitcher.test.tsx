// @vitest-environment jsdom
import "../../test/jsdom-shims.ts";
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { setWorkspace, workspaceHeaders } from "../../lib/api.ts";
import { renderWorkspaceRouter, workspaceA, workspaceB } from "../../test/workspace-router.tsx";
import { WorkspaceSwitcherSlot } from "./WorkspaceSwitcher.tsx";

afterEach(() => {
  cleanup();
  setWorkspace(null);
  localStorage.clear();
});

test("WorkspaceSwitcher › one workspace shows no switcher", async () => {
  await renderWorkspaceRouter([workspaceA], "/", () => (
    <>
      <p>Page</p>
      <WorkspaceSwitcherSlot />
    </>
  ));
  await screen.findByText("Page");
  expect(screen.queryByRole("button", { name: /switch workspace/ })).toBeNull();
});

test("WorkspaceSwitcher › two workspaces show it and switching sends the new headers", async () => {
  const user = userEvent.setup();
  const router = await renderWorkspaceRouter([workspaceA, workspaceB], "/help?w=ws_a", WorkspaceSwitcherSlot);
  await user.click(await screen.findByRole("button", { name: "Workspace Alpha, switch workspace" }));
  expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Alpha", "Beta"]);
  await user.click(screen.getByRole("menuitemradio", { name: "Beta" }));
  await act(() => router.load());
  expect(router.state.location).toMatchObject({ pathname: "/", search: { w: "ws_b" } });
  expect(workspaceHeaders()).toEqual({ "dispand-organization": "org_b", "dispand-workspace": "ws_b" });
  expect(await screen.findByRole("button", { name: "Workspace Beta, switch workspace" })).toBeTruthy();
});

test("WorkspaceSwitcher › no Create workspace action is rendered", async () => {
  const user = userEvent.setup();
  await renderWorkspaceRouter([workspaceA, workspaceB], "/?w=ws_a", WorkspaceSwitcherSlot);
  await user.click(await screen.findByRole("button", { name: /switch workspace/ }));
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
  expect(screen.queryByRole("menuitem")).toBeNull();
  expect(screen.queryByText(/create/i)).toBeNull();
});
