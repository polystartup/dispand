// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const workspace = vi.hoisted(() => ({ managed: vi.fn(), people: vi.fn(), removePerson: vi.fn() }));
vi.mock("../lib/api.ts", async () => ({
  orpc: (await import("@orpc/tanstack-query")).createTanstackQueryUtils({ workspace } as never),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
const { Route } = await import("./_app.settings.people.tsx");
const scope = { workspaceId: "w", organizationId: "o" };
const owner = { userId: "owner", name: "Ada", email: "ada@example.com", role: "owner" };
const member = { userId: "member", name: "Sam", email: "sam@example.com", role: "member" };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Page = Route.options.component as () => React.JSX.Element;
  render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  return client;
}

test("removing a member confirms the identity and refreshes access; ownership is inherited", async () => {
  const user = userEvent.setup();
  workspace.managed.mockResolvedValue([scope]);
  workspace.people.mockResolvedValue([owner, member]);
  let finish!: () => void;
  workspace.removePerson.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  open();
  await user.click(await screen.findByRole("button", { name: "Remove access for Sam" }));
  const dialog = screen.getByRole("dialog", { name: "Remove Sam’s workspace access?" });
  expect(within(dialog).getByText(/sam@example.com/)).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(workspace.removePerson).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Remove access for Sam" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove access" }));
  const progress = await screen.findByText("Removing access for Sam…");
  await vi.waitFor(() => expect(document.activeElement).toBe(progress));
  workspace.people.mockResolvedValue([owner]);
  finish();
  expect(await screen.findByText("Access removed for Sam.")).toBe(document.activeElement);
  expect(workspace.removePerson.mock.calls[0]?.[0]).toEqual({ ...scope, userId: member.userId });
  expect(screen.queryByText(member.email)).toBeNull();
  expect(screen.queryByRole("button", { name: /Ada/ })).toBeNull();
});

test.each([{ scopes: [] }, { scopes: [scope, { workspaceId: "other", organizationId: "o" }] }])("requires a single manageable workspace", async ({ scopes }) => {
  workspace.managed.mockResolvedValue(scopes);
  open();
  expect(await screen.findByText("People is unavailable in this workspace.")).toBeTruthy();
  expect(workspace.people).not.toHaveBeenCalled();
});

test("a denied refresh clears the directory, including an open confirmation", async () => {
  workspace.managed.mockResolvedValue([scope]);
  workspace.people.mockResolvedValue([owner, member]);
  const client = open();
  await userEvent.click(await screen.findByRole("button", { name: "Remove access for Sam" }));
  workspace.people.mockRejectedValue(new Error("Access denied"));
  await act(() => client.invalidateQueries());
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(member.email)).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  workspace.people.mockResolvedValue([owner, member]);
  await act(() => client.invalidateQueries());
  expect(await screen.findByText(member.email)).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("submitting closes the dialog and a later failure is announced in the directory", async () => {
  workspace.managed.mockResolvedValue([scope]);
  workspace.people.mockResolvedValue([owner, member]);
  let fail!: () => void;
  workspace.removePerson.mockImplementation(() => new Promise<void>((_, reject) => { fail = () => reject(new Error("Offline")); }));
  open();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Remove access for Sam" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove access" }));
  expect(await screen.findByText("Removing access for Sam…")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  fail();
  expect((await screen.findByRole("alert")).textContent).toContain("Could not remove access.");
});
