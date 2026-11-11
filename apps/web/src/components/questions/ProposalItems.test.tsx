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
    { tool: "agents_create", used: false, refs: ["harnessId", "toolIds", "skillPackageIds", "dataTables"], input: { name: "Clerk", harnessId: "harness_1", systemPrompt: long, toolIds: ["tool_1", "tool_gone"], bundles: ["data", "configure"], dataTables: "all" } },
    { tool: "agents_update", used: true, refs: ["id", "harnessId", "toolIds", "skillPackageIds", "dataTables"], input: { id: "agent_1", name: "Builder", harnessId: "harness_1", systemPrompt: "New.", dataTables: ["table_1"] } },
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

test("deletions and asking flags read as what they do, with names; a value that isn't an id is never read as one", () => {
  const more: ProposalView = {
    id: "prop_2",
    status: "asked",
    items: [
      { tool: "tables_delete", used: false, refs: ["id"], input: { id: "table_1" } },
      { tool: "fields_delete", used: false, refs: ["id"], input: { id: "field_1" } },
      { tool: "agents_set_tool_ask", used: false, refs: ["agentId", "toolId"], input: { agentId: "agent_1", toolId: "tool_x", action: "table_1", ask: false } },
    ],
    names: { table_1: { kind: "table", name: "Clients" }, field_1: { kind: "field", name: "Phone", detail: "of the table Clients" }, agent_1: { kind: "agent", name: "Builder" } },
  };
  render(<ProposalItems proposal={more} />);
  const [table, field, flag] = screen.getAllByRole("listitem");
  expect(within(table!).getByText("Delete a table, with its rows")).toBeTruthy();
  expect(table!.textContent).toContain("Clients");
  expect(field!.textContent).toContain("Phone (of the table Clients)");
  expect(within(flag!).getByText("Change whether an action asks before use")).toBeTruthy();
  expect(within(flag!).getByText(/tool_x: not one of yours/)).toBeTruthy();
  // The action happens to read like a table's id: it is shown as the text it is.
  expect(within(flag!).getByText("table_1")).toBeTruthy();
  expect(within(flag!).getByText("no")).toBeTruthy();
});

test("a trigger reads as what starts Jobs: its agent by name, its instructions and its schedule whole", () => {
  const trigger: ProposalView = {
    id: "prop_3",
    status: "asked",
    items: [
      {
        tool: "triggers_create",
        used: false,
        refs: ["agentId"],
        input: { agentId: "agent_1", name: "Every morning", instructions: "Read the mail and file it.", concurrency: "parallel", config: { kind: "schedule", cron: "0 8 * * *", timezone: "Europe/Paris" } },
      },
    ],
    names: { agent_1: { kind: "agent", name: "Clerk" } },
  };
  render(<ProposalItems proposal={trigger} />);
  const [item] = screen.getAllByRole("listitem");
  expect(within(item!).getByText("Create a trigger: what starts an agent's Jobs")).toBeTruthy();
  expect(item!.textContent).toContain("Clerk");
  expect(within(item!).getByText("What the agent is told")).toBeTruthy();
  expect(within(item!).getByText("Read the mail and file it.")).toBeTruthy();
  expect(item!.textContent).toContain("0 8 * * *");
  expect(item!.textContent).toContain("Europe/Paris");
});

test("a tool to add shows its address whole and the host calls will go to", () => {
  const tool: ProposalView = {
    id: "prop_4",
    status: "asked",
    items: [{ tool: "tools_add", used: false, refs: [], input: { name: "Mail", url: "https://mail.example.com:8443/mcp?team=a", transport: "streamable-http" } }],
    names: {},
  };
  render(<ProposalItems proposal={tool} />);
  const [item] = screen.getAllByRole("listitem");
  expect(within(item!).getByText("Add a tool: a server Dispand will call")).toBeTruthy();
  expect(within(item!).getByText("https://mail.example.com:8443/mcp?team=a")).toBeTruthy();
  expect(within(item!).getByText("mail.example.com:8443")).toBeTruthy();
});

test("a table-change trigger's config is read in words, its table and fields by name", () => {
  render(
    <ProposalItems
      proposal={{
        id: "prop_2",
        status: "asked",
        items: [
          {
            tool: "triggers_create",
            used: false,
            refs: ["agentId"],
            input: { agentId: "agent_1", name: "On change", config: { kind: "primitive", tableId: "table_1", operations: ["created", "updated"], fields: ["field_1", "field_gone"] } },
          },
        ],
        names: { agent_1: { kind: "agent", name: "Builder" }, table_1: { kind: "table", name: "Clients" }, field_1: { kind: "field", name: "City", detail: "of the table Clients" } },
      }}
    />,
  );
  const item = screen.getByRole("listitem");
  expect(item.textContent).toContain("A change to the table Clients");
  expect(item.textContent).toContain("When a row is created, or a row is changed");
  expect(item.textContent).toContain("City (of the table Clients)");
  expect(within(item).getByRole("alert").textContent).toBe("field_gone: not one of yours");
});
