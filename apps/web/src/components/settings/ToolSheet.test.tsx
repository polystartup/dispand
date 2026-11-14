// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ tools: { authorize: vi.fn(), pollable: vi.fn(), setPollable: vi.fn(), setActionEnabled: vi.fn(), create: vi.fn(), update: vi.fn(), refresh: vi.fn(), delete: vi.fn(), catalog: vi.fn(), fillSettings: vi.fn() }, plugins: { resetOverride: vi.fn(), conflicts: vi.fn(), resolveConflict: vi.fn() } }));
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
  disabled: [],
  actionsError: null,
  refreshedAt: null,
  catalogId: null,
  runnerId: null,
  runnerTool: null,
  plugin: null,
  createdAt: new Date(),
} as unknown as NonNullable<Tool>;

function sheet(shown: NonNullable<Tool> = tool, onSaved: (t: NonNullable<Tool>) => void = () => {}) {
  fake.tools.pollable.mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToolSheet tool={shown} onClose={() => {}} onSaved={onSaved} />
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

test("a catalog tool added without its key asks for its entry's settings, and saves them sealed on the server", async () => {
  const firecrawl = { ...tool, name: "Firecrawl", auth: "none", oauthStatus: null, catalogId: "firecrawl", signIn: "needed" } as unknown as NonNullable<Tool>;
  fake.tools.catalog.mockResolvedValue([{ id: "firecrawl", kind: "http", name: "Firecrawl", settings: [{ key: "apiKey", label: "API key", help: "Your key." }] }]);
  fake.tools.fillSettings.mockResolvedValue({ ...firecrawl, auth: "headers", signIn: "connected", headerNames: ["authorization"] });
  const saved = vi.fn();
  sheet(firecrawl, saved);
  expect(await screen.findByText(/Needs sign-in: enter its API key/)).toBeTruthy();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("API key"), "fc-1");
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  expect(fake.tools.fillSettings.mock.calls[0]![0]).toEqual({ id: "tool_mail", settings: { apiKey: "fc-1" } });
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ signIn: "connected" }));
  expect(await screen.findByText(/Connected\. Enter new settings/)).toBeTruthy();
});


test("workspace action controls save immediately without discarding unsaved tool fields", async () => {
  const shown = { ...tool, actions: [{ name: "send", description: "Send mail", inputSchema: {} }], disabled: [] };
  fake.tools.setActionEnabled.mockResolvedValue({ ...shown, disabled: ["send"] });
  const saved = vi.fn();
  sheet(shown, saved);
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Edited mail");
  await user.click(screen.getByRole("checkbox", { name: "Enable Mail send workspace-wide" }));
  expect(fake.tools.setActionEnabled.mock.calls[0]![0]).toEqual({ toolId: tool.id, action: "send", enabled: false });
  expect((screen.getByRole("checkbox", { name: "Enable Mail send workspace-wide" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Edited mail");
  expect(saved).not.toHaveBeenCalled();
});

test("a plugin's tool has no Delete, and a field its owner changed goes back to the plugin's value", async () => {
  fake.plugins.resetOverride.mockResolvedValue({ overridden: [] });
  sheet({ ...tool, auth: "none", oauthStatus: null, plugin: { id: "plugin_1", name: "law-firm" }, overridden: ["url"] } as unknown as NonNullable<Tool>);
  expect(screen.getByText(/It is law-firm's/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Reset URL to the plugin's" }));
  expect(fake.plugins.resetOverride.mock.calls[0]![0]).toEqual({ kind: "tool", id: "tool_mail", field: "url" });
});

test("the owner's own tool keeps its Delete and says nothing of a plugin", () => {
  sheet({ ...tool, overridden: [] } as unknown as NonNullable<Tool>);
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(screen.queryByText(/An update of the plugin/)).toBeNull();
});
