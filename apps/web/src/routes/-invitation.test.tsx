// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { createI18n } from "../lib/i18n.ts";

const { rpc, auth } = vi.hoisted(() => ({
  rpc: { invitation: vi.fn(), registrationPreview: vi.fn(), registerInvitation: vi.fn(), acceptInvitation: vi.fn() },
  auth: { signIn: vi.fn(), signOut: vi.fn(), authErrorMessage: () => "Sign-in failed" },
}));
vi.mock("../lib/api.ts", () => ({ api: { workspace: rpc } }));
vi.mock("../lib/auth-call.ts", () => auth);
const { Recipient } = await import("./-invitation.tsx");
const token = "q".repeat(43);
const summary = { role: "manager", inviterName: "Ada", workspaceId: "engineering", organizationId: "studio" };
afterEach(() => { cleanup(); vi.resetAllMocks(); });

async function submit(name: string) {
  const button = screen.getByRole<HTMLButtonElement>("button", { name });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

function mount(email: string | null) {
  const refresh = vi.fn();
  render(<I18nextProvider i18n={createI18n("en")}><QueryClientProvider client={new QueryClient()}>
    <Recipient email={email} token={token} refresh={refresh} />
  </QueryClientProvider></I18nextProvider>);
  return refresh;
}

test("the signed-in recipient reviews the scope and explicitly accepts", async () => {
  rpc.invitation.mockResolvedValue(summary);
  mount("pat@example.test");
  expect(await screen.findByText("engineering")).toBeTruthy();
  expect(screen.getByText("studio")).toBeTruthy();
  expect(screen.getByText("Manager")).toBeTruthy();
  expect(screen.getByText("Ada")).toBeTruthy();
  expect(rpc.acceptInvitation).not.toHaveBeenCalled();
  await submit("Accept invitation");
  expect(await screen.findByText("Invitation accepted")).toBeTruthy();
  expect(rpc.acceptInvitation).toHaveBeenCalledWith({ token });
});

test("a different signed-in account can switch accounts without seeing invitation details", async () => {
  rpc.invitation.mockRejectedValue(new Error("Invitation unavailable"));
  const refresh = mount("other@example.test");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Accept invitation")).toBeNull();
  fireEvent.click(screen.getByText("Switch account"));
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(auth.signOut).toHaveBeenCalled();
});

test("a new recipient previews the invitation before setting a password", async () => {
  rpc.registrationPreview.mockResolvedValue(summary);
  mount(null);
  fireEvent.click(screen.getByText("Create an account"));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.test" } });
  await submit("Review invitation");
  expect(await screen.findByText("engineering")).toBeTruthy();
  expect(rpc.registerInvitation).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "new-password" } });
  await submit("Create account and accept");
  expect(await screen.findByText("Invitation accepted")).toBeTruthy();
  expect(rpc.registerInvitation).toHaveBeenCalledWith({ token, name: "New", email: "new@example.test", password: "new-password" });
  expect(auth.signIn).toHaveBeenCalledWith("new@example.test", "new-password");
});

test("signing in from an invitation returns to the recipient's preview", async () => {
  const refresh = mount(null);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "pat@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
  await submit("Sign in");
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(rpc.acceptInvitation).not.toHaveBeenCalled();
});

test("registration that succeeds before sign-in fails allows signing in again without reclaiming the link", async () => {
  rpc.registrationPreview.mockResolvedValue(summary);
  auth.signIn.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  mount(null);
  fireEvent.click(screen.getByText("Create an account"));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.test" } });
  await submit("Review invitation");
  await screen.findByText("engineering");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "new-password" } });
  await submit("Create account and accept");
  expect(await screen.findByText("Invitation accepted")).toBeTruthy();
  expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("new@example.test");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "new-password" } });
  await submit("Sign in");
  expect(await screen.findByText(/open job links/)).toBeTruthy();
  expect(rpc.registerInvitation).toHaveBeenCalledTimes(1);
  expect(auth.signIn).toHaveBeenCalledTimes(2);
});
