// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { createI18n } from "../../lib/i18n.ts";
import { failing } from "../../shell/fixture.tsx";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  redirect: vi.fn(),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../lib/api.ts", () => ({ api: {} }));
vi.mock("../../lib/auth-call.ts", () => ({ signIn: vi.fn(), signOut: vi.fn(), authErrorMessage: () => "" }));
const { Route: Login } = await import("../../routes/login.tsx");
const { Recipient } = await import("../../routes/-invitation.tsx");
const { SignInForm } = await import("./SignInForm.tsx");

const token = "q".repeat(43);
const LoginPage = (Login as unknown as { options: { component: () => React.JSX.Element } }).options.component;
const page = (children: React.ReactNode, language: "en" | "fr" = "en") => (
  <I18nextProvider i18n={createI18n(language)}>
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  </I18nextProvider>
);

afterEach(() => {
  cleanup();
  failing.signIn = false;
});

const noForm = () => {
  expect(screen.queryByLabelText("Email")).toBeNull();
  expect(screen.queryByLabelText("Password")).toBeNull();
};

test("the sign-in page shows the shell's sign-in, with no invitation, in place of the form", () => {
  render(page(<LoginPage />));
  expect(screen.getByText("Fixture sign-in, invitation null")).toBeTruthy();
  noForm();
});

test("the invitation page's signed-out sign-in is the shell's, with the invitation's token", () => {
  render(page(<Recipient token={token} email={null} enrollsAccounts={false} refresh={vi.fn()} />));
  expect(screen.getByText(`Fixture sign-in, invitation ${token}`)).toBeTruthy();
  noForm();
});

test("the shell's sign-in reads its own text in the page's language", () => {
  render(page(<LoginPage />, "fr"));
  expect(screen.getByText("Connexion de la fixture, invitation null")).toBeTruthy();
});

test("a failing shell sign-in shows a retryable error and no form, and Try again renders it again", () => {
  failing.signIn = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(page(<LoginPage />));
  expect(screen.getByRole("alert").textContent).toContain("Sign-in couldn't load.");
  noForm();
  failing.signIn = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Fixture sign-in, invitation null")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a shell sign-in that fails in a server render renders the error instead of failing the page", async () => {
  failing.signIn = true;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const stream = await renderToReadableStream(page(createElement(SignInForm, { onSuccess: vi.fn() })), { onError: () => {} });
  await stream.allReady;
  const html = await new Response(stream).text();
  expect(html).toContain("Sign-in couldn");
  expect(html).toContain("Try again");
  expect(html).not.toContain('type="password"');
  errors.mockRestore();
});
