// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => ({ invalidate: vi.fn() }) }));
vi.mock("../../lib/auth-call.ts", () => ({ signOut: vi.fn(async () => null), saveLanguage: vi.fn() }));
vi.mock("../../lib/push.ts", () => ({ unsubscribeDevice: vi.fn(async () => undefined) }));
vi.mock("./ProfileDialog.tsx", () => ({ ProfileDialog: () => null }));
const { UserMenu } = await import("./UserMenu.tsx");

afterEach(cleanup);

test("UserMenu › signing out forgets every cached answer, so the next person on this page reads none", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["profile", "get"], { description: "Billing" });
  render(
    <QueryClientProvider client={queryClient}>
      <UserMenu user={{ name: "Ada", email: "ada@example.com", language: null }} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Account menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
  await vi.waitFor(() => expect(queryClient.getQueryCache().getAll()).toEqual([]));
});
