// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceInvitations } from "./WorkspaceInvitations.tsx";

const workspace = vi.hoisted(() => ({ invite: vi.fn(), invitations: vi.fn(), revokeInvitation: vi.fn() }));
vi.mock("../../lib/api.ts", async () => ({
  api: { workspace }, orpc: (await import("@orpc/tanstack-query")).createTanstackQueryUtils({ workspace } as never),
}));
const scope = { organizationId: "org", workspaceId: "engineering" };
const token = "opaque-invitation-secret";
const pending = { id: "inv", email: "sam@example.com", role: "manager", expiresAt: new Date(Date.now() + 86_400_000) };

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><WorkspaceInvitations scope={scope} names={{ workspaceName: "Engineering", organizationName: "Northwind" }} /></QueryClientProvider>);
  return client;
}

afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("creates a scoped handoff link and discards the secret when the dialog closes", async () => {
  const user = userEvent.setup();
  workspace.invitations.mockResolvedValue([]);
  workspace.invite.mockImplementation(async () => {
    workspace.invitations.mockResolvedValue([pending]);
    return { id: pending.id, token, expiresAt: pending.expiresAt };
  });
  const client = open();
  await user.click(await screen.findByRole("button", { name: "Invite person" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/Engineering in Northwind/)).toBeTruthy();
  await user.type(within(dialog).getByLabelText("Email address"), pending.email);
  await user.selectOptions(within(dialog).getByRole("combobox", { name: "Workspace role" }), "manager");
  await user.click(within(dialog).getByRole("button", { name: "Create link" }));
  const link = await screen.findByRole<HTMLInputElement>("textbox", { name: "Invitation link" });
  expect(link.value).toBe(window.location.origin + "/invitation#" + token);
  expect(workspace.invite.mock.calls[0]?.[0]).toEqual({ ...scope, email: pending.email, role: "manager" });
  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(await navigator.clipboard.readText()).toBe(link.value);
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByDisplayValue(link.value)).toBeNull();
  expect(JSON.stringify(client.getMutationCache().getAll().map((m) => m.state))).not.toContain(token);
  expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state))).not.toContain(token);
});

test("revokes a pending invitation and refreshes the visible list", async () => {
  workspace.invitations.mockResolvedValue([pending]);
  workspace.revokeInvitation.mockImplementation(async () => {
    workspace.invitations.mockResolvedValue([]);
    return { revoked: true };
  });
  open();
  await userEvent.click(await screen.findByRole("button", { name: "Revoke invitation for sam@example.com" }));
  expect(await screen.findByText("No pending invitations.")).toBeTruthy();
  expect(workspace.revokeInvitation.mock.calls[0]?.[0]).toEqual({ ...scope, id: pending.id });
});

test("a directory access error clears the pending list and creation controls", async () => {
  workspace.invitations.mockResolvedValue([pending]);
  const client = open();
  expect(await screen.findByText(pending.email)).toBeTruthy();
  workspace.invitations.mockRejectedValue(Object.assign(new Error("Denied"), { code: "FORBIDDEN" }));
  await act(() => client.invalidateQueries());
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(pending.email)).toBeNull();
  expect(screen.queryByRole("button", { name: "Invite person" })).toBeNull();
});


test("a successful creation keeps its link when refreshing the pending list fails", async () => {
  workspace.invitations.mockResolvedValue([]);
  workspace.invite.mockImplementation(async () => {
    workspace.invitations.mockRejectedValue(new Error("Temporarily offline"));
    return { id: pending.id, token, expiresAt: pending.expiresAt };
  });
  open();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Invite person" }));
  await user.type(screen.getByLabelText("Email address"), pending.email);
  await user.click(screen.getByRole("button", { name: "Create link" }));
  expect((await screen.findByLabelText<HTMLInputElement>("Invitation link")).value).toContain("#" + token);
});

test("replacing a link immediately updates the revocation target while the list refreshes", async () => {
  workspace.invitations.mockResolvedValue([{ ...pending, id: "previous" }]);
  let finish!: (list: typeof pending[]) => void;
  workspace.invite.mockImplementation(async () => {
    workspace.invitations.mockImplementation(() => new Promise<typeof pending[]>((resolve) => { finish = resolve; }));
    return { id: pending.id, token, expiresAt: pending.expiresAt };
  });
  open();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Invite person" }));
  await user.type(screen.getByLabelText("Email address"), pending.email);
  await user.click(screen.getByRole("button", { name: "Create link" }));
  expect((await screen.findByLabelText<HTMLInputElement>("Invitation link")).value).toContain("#" + token);
  await user.click(screen.getByRole("button", { name: "Done" }));
  await user.click(screen.getByRole("button", { name: "Revoke invitation for sam@example.com" }));
  expect(workspace.revokeInvitation.mock.calls[0]?.[0]).toEqual({ ...scope, id: pending.id });
  await act(async () => finish([]));
});
