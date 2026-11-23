// @vitest-environment jsdom
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { setWorkspace, workspaceHeaders } from "../lib/api.ts";
import { renderWorkspaceRouter, workspaceA, workspaceB } from "../test/workspace-router.tsx";

afterEach(() => {
  cleanup();
  setWorkspace(null);
  localStorage.clear();
});

const both = [workspaceA, workspaceB];

test("workspace URL › ?w survives navigation", async () => {
  const router = await renderWorkspaceRouter(both, "/?w=ws_b", () => <Link to="/help">Help</Link>);
  await userEvent.setup().click(screen.getByRole("link", { name: "Help" }));
  await act(() => router.load());
  expect(router.state.location.pathname).toBe("/help");
  expect(router.state.location.search).toEqual({ w: "ws_b" });
  expect(workspaceHeaders()).toEqual({ "dispand-organization": "org_b", "dispand-workspace": "ws_b" });
});

test("workspace URL › a tab without ?w is pinned to the remembered workspace, and one with a stale ?w too", async () => {
  localStorage.setItem("dispand-workspace", "ws_b");
  const router = await renderWorkspaceRouter(both, "/help", () => <p>Page</p>);
  await screen.findByText("Page");
  expect(router.state.location).toMatchObject({ pathname: "/help", search: { w: "ws_b" } });
  await act(() => router.navigate({ to: "/", search: { w: "ws_gone" } }));
  await screen.findByText("Page");
  expect(router.state.location.search).toEqual({ w: "ws_b" });
});

test("workspace URL › one workspace sends its headers and leaves the URL as it is", async () => {
  const router = await renderWorkspaceRouter([workspaceA], "/", () => <p>Page</p>);
  await screen.findByText("Page");
  expect(router.state.location.search).toEqual({});
  expect(workspaceHeaders()).toEqual({ "dispand-organization": "org_a", "dispand-workspace": "ws_a" });
});

test("workspace URL › switching with A's queries cached shows none of A's data under B, and Back to A shows none of B's", async () => {
  // Each answer waits until the test lets it through, and says which workspace's headers it was asked with.
  const asked: { workspace: string | undefined; answer: () => void }[] = [];
  function Page() {
    const data = useQuery({
      queryKey: ["data"],
      queryFn: () => {
        const workspace = workspaceHeaders()["dispand-workspace"];
        return new Promise<string>((resolve) => asked.push({ workspace, answer: () => resolve(`Data of ${workspace}`) }));
      },
    });
    return <p>{data.data ?? "Loading"}</p>;
  }
  const answerLast = () => act(async () => asked.at(-1)!.answer());

  const router = await renderWorkspaceRouter(both, "/?w=ws_a", Page);
  await answerLast();
  expect(await screen.findByText("Data of ws_a")).toBeTruthy();

  await act(() => router.navigate({ to: "/", search: { w: "ws_b" } }));
  expect(screen.queryByText("Data of ws_a")).toBeNull();
  expect(screen.getByText("Loading")).toBeTruthy();
  expect(asked.at(-1)!.workspace).toBe("ws_b");
  await answerLast();
  expect(await screen.findByText("Data of ws_b")).toBeTruthy();

  await act(async () => router.history.back());
  await screen.findByText("Loading");
  expect(router.state.location.search).toEqual({ w: "ws_a" });
  expect(screen.queryByText("Data of ws_b")).toBeNull();
  expect(asked.at(-1)!.workspace).toBe("ws_a");
  await answerLast();
  expect(await screen.findByText("Data of ws_a")).toBeTruthy();
  expect(asked.map((x) => x.workspace)).toEqual(["ws_a", "ws_b", "ws_a"]);
});
