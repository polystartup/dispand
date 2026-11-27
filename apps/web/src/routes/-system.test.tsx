// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { createI18n } from "../lib/i18n.ts";
import { createQueryClient } from "../lib/query-client.ts";

const system = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../lib/api.ts", async () => ({
  orpc: (await import("@orpc/tanstack-query")).createTanstackQueryUtils({ system } as never),
  setWorkspace: () => {},
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  retainSearchParams: () => () => ({}),
  useNavigate: () => vi.fn(),
  Link: ({ children, params }: { children: React.ReactNode; params: { id: string } }) => <a href={`/settings/agents/${params.id}`}>{children}</a>,
}));
const { WorkspaceScope } = await import("../lib/workspace.tsx");
const { Route } = await import("./_app.settings.system.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const failed = JSON.stringify({ key: "tools.poll.notJson" });
const state = {
  protocolVersion: 41,
  scheduler: { sinceTickMs: 12_000, stale: false },
  runners: [
    { id: "r1", name: "Workstation", status: "online", protocolVersion: 41, lastSeenAt: new Date() },
    { id: "r2", name: "Old box", status: "outdated", protocolVersion: 40, lastSeenAt: new Date() },
    { id: "r3", name: "New box", status: "offline", protocolVersion: null, lastSeenAt: null },
  ],
  failingPolls: [{ triggerId: "t1", triggerName: "New mail", agentId: "a1", agentName: "Mailroom", at: new Date("2026-11-27T09:30:00Z"), message: failed }],
};

function open(role: "owner" | "manager" | "member", language: "en" | "fr" = "en") {
  const client = createQueryClient({ defaultOptions: { queries: { retry: false } } });
  const Page = Route.options.component as () => React.JSX.Element;
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <WorkspaceScope workspaces={[{ workspaceId: "w", organizationId: "o", name: "Engineering", role }]} w="w">
        <QueryClientProvider client={client}>
          <Page />
        </QueryClientProvider>
      </WorkspaceScope>
    </I18nextProvider>,
  );
  return client;
}

test("a manager sees the scheduler's last tick, the runners against the server's protocol, and the failing polls", async () => {
  system.status.mockResolvedValue(state);
  open("manager");
  expect(await screen.findByText("Last tick 12 s ago.")).toBeTruthy();
  expect(screen.getByText("This server speaks runner protocol 41.")).toBeTruthy();
  expect(screen.getByText("Last reported protocol 40")).toBeTruthy();
  expect(screen.getByText("Never connected")).toBeTruthy();
  expect(screen.getByText("Needs an update")).toBeTruthy();
  expect(screen.getByText("The latest poll of 1 poll trigger failed.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "New mail · Mailroom" }).getAttribute("href")).toBe("/settings/agents/a1");
  expect(screen.getByText("Failed: The action's result isn't JSON.")).toBeTruthy();
});

test("a stale scheduler is an alert; none in this process, or nothing failing, says so", async () => {
  system.status.mockResolvedValue({ ...state, scheduler: { sinceTickMs: 7 * 60_000 + 3_000, stale: true } });
  open("owner");
  expect((await screen.findByRole("alert")).textContent).toMatch(/^Last tick 7 min 3 s ago: schedules and polls aren’t running/);
  cleanup();
  system.status.mockResolvedValue({ ...state, scheduler: null, runners: [], failingPolls: [] });
  open("owner");
  expect(await screen.findByText("The scheduler doesn’t run in the server process that answered.")).toBeTruthy();
  expect(screen.getByText("This workspace has no runner.")).toBeTruthy();
  expect(screen.getByText("No poll trigger’s latest poll failed.")).toBeTruthy();
});

test("a refresh that fails says the page shows the server's last answer, and when it came", async () => {
  system.status.mockResolvedValue(state);
  const client = open("manager");
  await screen.findByText("Last tick 12 s ago.");
  system.status.mockRejectedValue(new Error("down"));
  await act(() => client.refetchQueries());
  expect((await screen.findByRole("alert")).textContent).toMatch(/^Could not refresh: this is what the server answered at /);
  expect(screen.getByText("Last tick 12 s ago.")).toBeTruthy();
});

test("a member is told the page is the managers', and asks nothing", async () => {
  open("member");
  expect(screen.getByText("Only the workspace’s managers see this page.")).toBeTruthy();
  expect(system.status).not.toHaveBeenCalled();
});

test("in French", async () => {
  system.status.mockResolvedValue(state);
  open("manager", "fr");
  expect(await screen.findByText("Dernier passage il y a 12 s.")).toBeTruthy();
  expect(screen.getByText("La dernière interrogation de 1 déclencheur a échoué.")).toBeTruthy();
});
