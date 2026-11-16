// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => unknown }) => ({ options }),
  redirect: vi.fn(),
  useNavigate: () => vi.fn(),
}));
vi.mock("../lib/api.ts", () => ({ api: {} }));
const { createI18n } = await import("../lib/i18n.ts");
const { Route: Login } = await import("./login.tsx");
const { Route: Setup } = await import("./setup.tsx");

afterEach(cleanup);

test("sign-in is in French", () => {
  const Page = (Login as unknown as { options: { component: () => React.JSX.Element } }).options.component;
  render(<I18nextProvider i18n={createI18n("fr")}><Page /></I18nextProvider>);
  expect(screen.getByRole("heading", { name: "Connexion" })).toBeTruthy();
  expect(screen.getByLabelText("Mot de passe")).toBeTruthy();
});

test("first setup is in French", () => {
  const Page = (Setup as unknown as { options: { component: () => React.JSX.Element } }).options.component;
  render(<I18nextProvider i18n={createI18n("fr")}><Page /></I18nextProvider>);
  expect(screen.getByRole("heading", { name: "Bienvenue sur Dispand" })).toBeTruthy();
  expect(screen.getByLabelText("Code d’installation")).toBeTruthy();
  expect(screen.getByText(/DISPAND_SETUP_CODE/)).toBeTruthy();
});
