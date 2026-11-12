// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  harnesses: { list: vi.fn() },
  skills: { list: vi.fn() },
  tools: { list: vi.fn() },
  tables: { list: vi.fn() },
  agents: { create: vi.fn(), update: vi.fn(), list: vi.fn(), toolAsk: vi.fn(), setToolAsk: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children, useNavigate: () => vi.fn() }));
const { AgentEditor } = await import("./AgentEditor.tsx");
type Agent = NonNullable<Parameters<typeof AgentEditor>[0]["agent"]>;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const platform = { packageId: "pkg_platform", name: "dispand-platform", description: "How Dispand works.", builtIn: true, plugin: null, skills: [], requiredTools: [] };
const writing = { packageId: "pkg_writing", name: "writing", description: "House style.", builtIn: false, plugin: null, skills: [], requiredTools: [] };
const agent = {
  id: "agent_1",
  name: "Assistant",
  description: "",
  harnessId: "harness_1",
  systemPrompt: "",
  bundles: ["data", "configure"],
  dataTables: "all",
  builtIn: "assistant",
  skills: [{ packageId: "pkg_platform", name: "dispand-platform" }],
  tools: [],
  consults: [],
  plugin: null,
} as unknown as Agent;

function mount(shown: Agent) {
  fake.harnesses.list.mockResolvedValue([{ id: "harness_1", name: "Claude Code" }]);
  fake.skills.list.mockResolvedValue([platform, writing]);
  fake.tools.list.mockResolvedValue([]);
  fake.tables.list.mockResolvedValue([]);
  fake.agents.list.mockResolvedValue([]);
  fake.agents.toolAsk.mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentEditor agent={shown} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const refused = (code: string, message: string) => Object.assign(new Error(message), { code });

test("the Assistant's page locks its platform skill, with the reason", async () => {
  mount(agent);
  const box = (await screen.findByRole("checkbox", { name: /dispand-platform/ })) as HTMLInputElement;
  expect(box.checked).toBe(true);
  expect(box.disabled).toBe(true);
  expect(screen.getByText("The Assistant keeps its platform skill.")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: /writing/ }) as HTMLInputElement).disabled).toBe(false);
});

test("another agent's page leaves the platform skill's box free", async () => {
  mount({ ...agent, builtIn: undefined } as unknown as Agent);
  const box = (await screen.findByRole("checkbox", { name: /dispand-platform/ })) as HTMLInputElement;
  expect(box.disabled).toBe(false);
  expect(screen.queryByText("The Assistant keeps its platform skill.")).toBeNull();
});

test.each(["FORBIDDEN", "BAD_REQUEST"])("a %s refusal shows the server's reason", async (code) => {
  fake.agents.update.mockRejectedValue(refused(code, "The Assistant keeps its platform skill"));
  const user = mount(agent);
  await user.click(await screen.findByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("The Assistant keeps its platform skill");
});

test.each([
  ["a failure the server didn't explain", refused("INTERNAL_SERVER_ERROR", "Internal server error")],
  ["a rejected input", refused("BAD_REQUEST", "Input validation failed")],
  ["a network failure", new TypeError("Failed to fetch")],
])("%s keeps the generic text", async (_, error) => {
  fake.agents.update.mockRejectedValue(error);
  const user = mount(agent);
  await user.click(await screen.findByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not save the agent. Check the details and try again.");
});
