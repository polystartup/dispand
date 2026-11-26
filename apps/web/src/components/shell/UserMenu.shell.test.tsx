// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { createI18n } from "../../lib/i18n.ts";
import { failing } from "../../shell/fixture.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => ({ invalidate: vi.fn() }) }));
vi.mock("../../lib/auth-call.ts", () => ({ signOut: vi.fn(async () => null), saveLanguage: vi.fn() }));
vi.mock("../../lib/push.ts", () => ({ unsubscribeDevice: vi.fn(async () => undefined) }));
vi.mock("./ProfileDialog.tsx", () => ({ ProfileDialog: () => null }));
const { UserMenu } = await import("./UserMenu.tsx");
const workspaceA = { organizationId: "org_a", workspaceId: "ws_a", name: "Alpha", role: "owner" } as const;

afterEach(() => {
  cleanup();
  failing.accountMenu = false;
});

async function open(language: "en" | "fr" = "en") {
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <QueryClientProvider client={new QueryClient()}>
        <UserMenu user={{ name: "Ada", email: "ada@example.com", language: null }} workspace={workspaceA} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  await userEvent.setup().click(screen.getByRole("button", { name: language === "fr" ? "Menu du compte" : "Account menu" }));
}

test("the shell's account menu entry is a link in the tab's organization", async () => {
  await open();
  const entry = await screen.findByRole("menuitem", { name: "Fixture entry" });
  expect(entry.tagName).toBe("A");
  expect(entry.getAttribute("href")).toBe("/fixture?organization=org_a");
});

test("the shell's account menu entry reads in French on a French page", async () => {
  await open("fr");
  expect(await screen.findByRole("menuitem", { name: "Entrée de la fixture" })).toBeTruthy();
});

test("a failing shell account menu shows no entry, and the rest of the menu", async () => {
  failing.accountMenu = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await open();
  expect(await screen.findByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Fixture entry" })).toBeNull();
});
