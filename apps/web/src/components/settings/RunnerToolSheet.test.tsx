// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ runners: { list: vi.fn() }, agents: {}, tools: { pollable: vi.fn(), setPollable: vi.fn(), setActionEnabled: vi.fn(), create: vi.fn(), update: vi.fn(), refresh: vi.fn(), delete: vi.fn() } }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { RunnerToolSheet } = await import("./RunnerToolSheet.tsx");
type Tool = NonNullable<Parameters<typeof RunnerToolSheet>[0]["tool"]>;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const digest = `sha256:${"a".repeat(64)}`;
const tool = {
  id: "tool_notes",
  name: "notes",
  kind: "runner",
  actions: [],
  disabled: [],
  actionsError: "The files of the plugin law-firm have the digest sha256:b, not sha256:a that this runner allowed.",
  runnerId: "runner_1",
  runnerTool: null,
  plugin: { id: "plugin_1", name: "law-firm" },
  pluginServer: { plugin: "law-firm", entry: { command: "npx", args: ["-y", "notes-mcp"] }, digest, commandIsFile: false },
} as unknown as Tool;

function sheet(shown: Tool) {
  fake.runners.list.mockResolvedValue([{ id: "runner_1", name: "Workstation", tools: [] }]);
  fake.tools.pollable.mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RunnerToolSheet tool={shown} onClose={() => {}} onSaved={() => {}} />
    </QueryClientProvider>,
  );
}

test("a plugin's stdio server shows its command, its digest, the allow-plugin line to copy and the runner's last refusal", () => {
  sheet(tool);
  expect(screen.getByText("npx -y notes-mcp")).toBeTruthy();
  expect(screen.getByText(digest)).toBeTruthy();
  expect(screen.getByText(`dispand-runner allow-plugin tool_notes law-firm@${digest}`)).toBeTruthy();
  expect(screen.getByRole("note").textContent).toBe("Its command isn't one of the plugin's files: allowing it covers the command line, not what that command runs or downloads.");
  expect(screen.getByRole("status").textContent).toContain("that this runner allowed");
  // No server of the runner's own to pick.
  expect(screen.queryByLabelText("MCP server")).toBeNull();
});

test("a command that is a file of the plugin carries no warning", () => {
  sheet({ ...tool, pluginServer: { ...tool.pluginServer!, entry: { command: "./server.mjs" }, commandIsFile: true } } as Tool);
  expect(screen.getByText("./server.mjs")).toBeTruthy();
  expect(screen.queryByRole("note")).toBeNull();
});

test("a tool whose plugin no longer offers its server says so, and can be pointed at one of the runner's own servers", () => {
  sheet({ ...tool, pluginServer: null, actionsError: null } as Tool);
  expect(screen.getByText("A stdio server its plugin no longer offers, or keeps no files for: update the plugin, or point this tool at one of the runner's own MCP servers.")).toBeTruthy();
  expect(screen.getByLabelText("MCP server")).toBeTruthy();
  expect(screen.queryByText(/dispand-runner allow-plugin/)).toBeNull();
});
