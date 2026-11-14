// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  harnesses: { list: vi.fn(), models: vi.fn().mockResolvedValue([]) },
  skills: { list: vi.fn() },
  tools: { list: vi.fn() },
  tables: { list: vi.fn() },
  agents: { create: vi.fn(), update: vi.fn(), list: vi.fn(), toolAsk: vi.fn(), setToolPermission: vi.fn(), cliRules: vi.fn(), removeCliRule: vi.fn() },
  plugins: { resetOverride: vi.fn() },
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
  selfLearning: [],
  plugin: null,
} as unknown as Agent;

function mount(shown: Agent, rules: unknown[] = []) {
  fake.harnesses.list.mockResolvedValue([{ id: "harness_1", name: "Claude Code" }]);
  fake.harnesses.models.mockResolvedValue([{ id: "sonnet", label: "Sonnet" }]);
  fake.skills.list.mockResolvedValue([platform, writing]);
  fake.tools.list.mockResolvedValue([]);
  fake.tables.list.mockResolvedValue([]);
  fake.agents.list.mockResolvedValue([]);
  fake.agents.toolAsk.mockResolvedValue([]);
  fake.agents.cliRules.mockResolvedValue(rules);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentEditor agent={shown} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const refused = (code: string, message: string) => Object.assign(new Error(message), { code });

test("remembered CLI rules are removed independently from the agent form and refreshed", async () => {
  const rules = [{ cli: "claude-code", rule: "Bash(npm test:*)", decision: "allow" }, { cli: "codex", rule: "FileChange", decision: "deny" }];
  const user = mount(agent, rules);
  fake.agents.removeCliRule.mockImplementation(async () => {
    fake.agents.cliRules.mockResolvedValue([rules[1]]);
    return { ok: true };
  });
  await user.click(await screen.findByRole("button", { name: "Remove Claude Code Allow Bash(npm test:*)" }));
  expect(fake.agents.removeCliRule).toHaveBeenCalledWith({ id: agent.id, cli: "claude-code", rule: "Bash(npm test:*)" }, expect.anything());
  expect(fake.agents.update).not.toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: "Remove Codex Deny FileChange" })).toBeTruthy();
  expect(screen.queryByText("Bash(npm test:*)")).toBeNull();
  expect(screen.getByText("Removing a rule takes effect when this agent starts its next session.")).toBeTruthy();
});

test("a failed CLI removal keeps the rule visible and gives a retry message", async () => {
  fake.agents.removeCliRule.mockRejectedValue(new Error("private failure"));
  const user = mount(agent, [{ cli: "claude-code", rule: "Bash", decision: "deny" }]);
  await user.click(await screen.findByRole("button", { name: "Remove Claude Code Deny Bash" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not remove the CLI permission. Try again.");
  expect(screen.getByRole("button", { name: "Remove Claude Code Deny Bash" })).toBeTruthy();
  expect(fake.agents.update).not.toHaveBeenCalled();
});

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

test("the self-learning switches set and clear the agent's targets, and writing the workspace's memory says what it does", async () => {
  fake.agents.update.mockResolvedValue({});
  const user = mount({ ...agent, selfLearning: ["agent"] } as unknown as Agent);
  const learns = within(await screen.findByRole("group", { name: "Learns" }));
  expect((learns.getByRole("checkbox", { name: /Its own memory/ }) as HTMLInputElement).checked).toBe(true);
  // The Assistant's switch is its own, never locked.
  const workspace = learns.getByRole("checkbox", { name: /The workspace's memory/ }) as HTMLInputElement;
  expect(workspace.disabled).toBe(false);
  expect(learns.getByText("What it writes steers every agent of the workspace.")).toBeTruthy();
  await user.click(workspace);
  await user.click(learns.getByRole("checkbox", { name: /Its own memory/ }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.agents.update.mock.calls[0]![0]).toMatchObject({ id: "agent_1", selfLearning: ["workspace"] });
  await user.click(workspace);
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.agents.update.mock.calls[1]![0]).toMatchObject({ selfLearning: [] });
});


test("the shared picker saves the selected model and can restore the harness default", async () => {
  const user = mount(agent);
  fake.agents.update.mockResolvedValue(agent);
  await user.click(await screen.findByRole("button", { name: "Sonnet" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.agents.update).toHaveBeenCalledWith(expect.objectContaining({ harnessId: "harness_1", model: "sonnet" }), expect.anything());
  await user.click(screen.getByRole("button", { name: /CLI default\s*Default/ }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(fake.agents.update.mock.calls.at(-1)![0]).not.toHaveProperty("model");
});
