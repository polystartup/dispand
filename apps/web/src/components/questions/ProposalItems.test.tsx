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
  expect(item.textContent).toContain("A changed row only when one of these changed:City (of the table Clients)");
  expect(within(item).getByRole("alert").textContent).toBe("field_gone: not one of yours");
});

test("an agent's consult entries read by name, with their flag and what a consult can do", () => {
  const consults: ProposalView = {
    id: "prop_3",
    status: "asked",
    items: [
      {
        tool: "agents_update",
        used: false,
        refs: ["id", "harnessId", "toolIds", "skillPackageIds", "dataTables"],
        input: { id: "agent_1", description: "Decides what we build.", consults: [{ agentId: "agent_2", ask: true }, { agentId: "agent_gone", ask: false }] },
      },
    ],
    names: { agent_1: { kind: "agent", name: "Builder" }, agent_2: { kind: "agent", name: "Architect" } },
  };
  render(<ProposalItems proposal={consults} />);
  const item = screen.getByRole("listitem");
  expect(within(item).getByText("Description")).toBeTruthy();
  expect(within(item).getByText("Decides what we build.")).toBeTruthy();
  expect(within(item).getByText("May consult")).toBeTruthy();
  expect(item.textContent).toContain("Architect agent_2 (asks before use)");
  expect(within(item).getByText(/agent_gone: not one of yours/)).toBeTruthy();
  expect(within(item).getByText("It can steer this agent with its questions, and its answers may quote what it reads in tables this agent can't.")).toBeTruthy();
});

test("a reference to an earlier item reads as what that item creates, by name once made; a refused item says so", () => {
  const setup: ProposalView = {
    id: "prop_3",
    status: "approved",
    items: [
      { tool: "tables_create", used: true, failed: false, refs: [], creates: "table", createdId: "table_1", input: { name: "Matters" } },
      { tool: "agents_create", used: true, failed: true, refs: ["dataTables"], creates: "agent", createdId: null, input: { name: "Clerk", dataTables: [{ $item: 0 }] } },
      {
        tool: "triggers_create",
        used: false,
        refs: ["agentId"],
        creates: "trigger",
        createdId: null,
        input: { agentId: { $item: 1 }, name: "New matter", config: { kind: "primitive", tableId: { $item: 0 }, operations: ["created"] } },
      },
      { tool: "tables_set_primitive", used: false, refs: ["id"], creates: null, createdId: null, input: { id: { $item: 0 }, primitive: true, parent: { tableId: "table_2", required: true } } },
    ],
    names: { table_1: { kind: "table", name: "Matters" }, table_2: { kind: "table", name: "Clients" } },
  };
  render(<ProposalItems proposal={setup} />);
  const [table, agent, trigger, primitive] = screen.getAllByRole("listitem");
  expect(table!.textContent).toContain("1.Create a table");
  expect(agent!.textContent).toContain("the table item 1 creates: Matters");
  expect(within(agent!).getByText("refused")).toBeTruthy();
  expect(trigger!.textContent).toContain("the agent item 2 creates");
  expect(trigger!.textContent).toContain("A change to the table item 1 creates: Matters");
  expect(primitive!.textContent).toContain("Clients");
  expect(primitive!.textContent).toContain("which every row must name");
  expect(screen.queryByText(/not one of yours/)).toBeNull();
  expect(document.body.textContent).not.toContain("[object Object]");
});

test("a reference in a sentence never repeats what it says: the table is named once", () => {
  const setup: ProposalView = {
    id: "prop_5",
    status: "asked",
    items: [
      { tool: "tables_create", used: false, refs: [], creates: "table", createdId: null, input: { name: "Matters" } },
      { tool: "triggers_create", used: false, refs: ["agentId"], creates: "trigger", createdId: null, input: { agentId: "agent_1", name: "New matter", config: { kind: "primitive", tableId: { $item: 0 }, operations: ["created"] } } },
      { tool: "triggers_create", used: false, refs: ["agentId"], creates: "trigger", createdId: null, input: { agentId: "agent_1", name: "Other", config: { kind: "primitive", tableId: "table_1", operations: ["created"] } } },
    ],
    names: { agent_1: { kind: "agent", name: "Builder" }, table_1: { kind: "table", name: "Clients" } },
  };
  render(<ProposalItems proposal={setup} />);
  const [, byRef, byId] = screen.getAllByRole("listitem");
  expect(byRef!.textContent).toContain("A change to the table item 1 creates");
  expect(byRef!.textContent).not.toMatch(/the table the table/);
  expect(byId!.textContent).toContain("A change to the table Clients");
});

test("a trigger's rate cap and concurrency read in words, and a field's choices by their labels", () => {
  const setup: ProposalView = {
    id: "prop_6",
    status: "asked",
    items: [
      { tool: "fields_create", used: false, refs: ["tableId"], creates: "field", createdId: null, input: { tableId: "table_1", name: "Status", type: "single-select", choices: [{ id: "c_new", label: "New" }, { id: "c_won", label: "Won" }] } },
      { tool: "triggers_create", used: false, refs: ["agentId"], creates: "trigger", createdId: null, input: { agentId: "agent_1", name: "Poll", concurrency: "one-at-a-time", rateCap: 30, config: { kind: "primitive", tableId: "table_1", operations: ["created"] } } },
    ],
    names: { agent_1: { kind: "agent", name: "Builder" }, table_1: { kind: "table", name: "Clients" } },
  };
  render(<ProposalItems proposal={setup} />);
  const [field, trigger] = screen.getAllByRole("listitem");
  expect(field!.textContent).toContain("ChoicesNew, Won");
  expect(field!.textContent).not.toMatch(/c_new|"label"/);
  expect(trigger!.textContent).toContain("Jobs an hourAt most 30 an hour");
  expect(trigger!.textContent).toContain("Jobs at onceOne at a time");
  expect(trigger!.textContent).not.toContain("rateCap");
  expect(trigger!.textContent).not.toContain("one-at-a-time");
});

test("a proposal names the generated plugin that will record what it creates; one without says nothing of it", () => {
  const { unmount } = render(<ProposalItems proposal={{ ...proposal, plugin: "Generated: Acme Law" }} />);
  expect(screen.getByText("Generated: Acme Law")).toBeTruthy();
  unmount();
  render(<ProposalItems proposal={proposal} />);
  expect(screen.queryByText(/recorded in the plugin/)).toBeNull();
});

test("an agent's self-learning targets read as words, and the workspace's memory with what writing it does", () => {
  const learning: ProposalView = {
    id: "prop_9",
    status: "asked",
    items: [
      { tool: "agents_create", used: false, refs: ["harnessId"], input: { name: "Clerk", harnessId: "harness_1", systemPrompt: "", selfLearning: ["agent", "workspace"] } },
      { tool: "agents_update", used: false, refs: ["id", "harnessId"], input: { id: "agent_1", name: "Builder", harnessId: "harness_1", systemPrompt: "", selfLearning: ["data"] } },
      { tool: "agents_update", used: false, refs: ["id", "harnessId"], input: { id: "agent_1", name: "Builder", harnessId: "harness_1", systemPrompt: "", selfLearning: [] } },
    ],
    names: proposal.names,
  };
  render(<ProposalItems proposal={learning} />);
  const [create, update, off] = screen.getAllByRole("listitem");
  expect(within(create!).getByText("Learns")).toBeTruthy();
  expect(within(create!).getByText("Its own memory")).toBeTruthy();
  expect(within(create!).getByText("The workspace's memory")).toBeTruthy();
  expect(within(create!).getByText("What it writes steers every agent of the workspace.")).toBeTruthy();
  expect(within(update!).getByText("Its tables' memory")).toBeTruthy();
  expect(within(update!).queryByText(/steers every agent/)).toBeNull();
  expect(within(off!).getByText("nothing")).toBeTruthy();
});
