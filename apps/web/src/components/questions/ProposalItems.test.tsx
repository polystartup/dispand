// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ProposalItems, type ProposalView } from "./ProposalItems.tsx";

afterEach(cleanup);

const long = `Line one.\n${"Work carefully. ".repeat(400)}THE END`;
const proposal: ProposalView = {
  id: "prop_1",
  status: "asked",
  items: [
    { tool: "agents_create", used: false, input: { name: "Clerk", harnessId: "harness_1", systemPrompt: long, toolIds: ["tool_1", "tool_gone"], bundles: ["data", "configure"], dataTables: "all" } },
    { tool: "agents_update", used: true, input: { id: "agent_1", name: "Builder", harnessId: "harness_1", systemPrompt: "New.", dataTables: ["table_1"] } },
  ],
  names: {
    harness_1: { kind: "harness", name: "Claude", detail: "claude-code, on Workstation, permission mode default" },
    tool_1: { kind: "tool", name: "Mail", detail: "https://mail.example.com/mcp" },
    agent_1: { kind: "agent", name: "Builder" },
    table_1: { kind: "table", name: "Clients" },
  },
};

test("a proposal shows every write whole: the tool, each value, and long instructions uncut", () => {
  render(<ProposalItems proposal={proposal} />);
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(2);
  const first = within(items[0]!);
  expect(first.getByText("Create an agent")).toBeTruthy();
  expect(first.getByText("Clerk")).toBeTruthy();
  expect(first.getByText("data, configure")).toBeTruthy();
  expect(first.getByText("all")).toBeTruthy();
  expect(items[0]!.textContent).toContain(long);
  expect(within(items[1]!).getByText("Change an agent")).toBeTruthy();
  expect(within(items[1]!).getByText("New.")).toBeTruthy();
});

test("each id is read with its name and what it is, and an id that names nothing is flagged", () => {
  render(<ProposalItems proposal={proposal} />);
  const [first, second] = screen.getAllByRole("listitem");
  expect(first!.textContent).toContain("Claude (claude-code, on Workstation, permission mode default)");
  expect(first!.textContent).toContain("Mail (https://mail.example.com/mcp)");
  expect(within(first!).getByText(/tool_gone: not one of yours/)).toBeTruthy();
  // The agent an update changes is named too.
  expect(second!.textContent).toContain("Builder");
  expect(second!.textContent).toContain("Clients");
  expect(within(second!).queryByText(/not one of yours/)).toBeNull();
});
