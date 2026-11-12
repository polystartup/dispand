// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ tools: { authorize: vi.fn(), pollable: vi.fn(), setPollable: vi.fn(), create: vi.fn(), update: vi.fn(), refresh: vi.fn(), delete: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { ToolSheet } = await import("./ToolSheet.tsx");
type Tool = Parameters<typeof ToolSheet>[0]["tool"];

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const tool = {
  id: "tool_mail",
  name: "Mail",
  kind: "http",
  url: "https://mail.example.com/mcp",
  urlSet: false,
  transport: "streamable-http",
  headerNames: [],
  auth: "oauth",
  oauthStatus: "authorize",
  enteredClientId: null,
  actions: [],
  actionsError: null,
  refreshedAt: null,
  catalogId: null,
  runnerId: null,
  runnerTool: null,
  plugin: null,
  createdAt: new Date(),
} as unknown as NonNullable<Tool>;

function sheet() {
  fake.tools.pollable.mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToolSheet tool={tool} onClose={() => {}} onSaved={() => {}} />
    </QueryClientProvider>,
  );
}

test("an OAuth tool's sheet offers Connect for the saved server", () => {
  sheet();
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
});

test("an address not saved yet takes Connect away: a sign-in and its client are for the saved server only", async () => {
  sheet();
  const user = userEvent.setup();
  const url = screen.getByLabelText("URL");
  await user.clear(url);
  await user.type(url, "https://other.example.com/mcp");
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  expect(screen.getByText(/Save the new address before connecting/)).toBeTruthy();
  expect(fake.tools.authorize).not.toHaveBeenCalled();
});

test("a server that needs a client id it gave opens the client fields when Connect fails for want of one", async () => {
  fake.tools.authorize.mockRejectedValue(
    Object.assign(new Error("mail.example.com's authorization server supports neither client metadata documents nor registration: enter the client id it gave you"), { code: "BAD_REQUEST" }),
  );
  sheet();
  expect(screen.queryByLabelText("Client id")).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/enter the client id it gave you/);
  expect(screen.getByLabelText("Client id")).toBeTruthy();
  expect(screen.getByLabelText("Client secret")).toBeTruthy();
});
