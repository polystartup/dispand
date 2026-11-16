// @vitest-environment jsdom
import { say } from "@dispand/domain/messages/index.ts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ProposalItems, type ProposalView } from "./ProposalItems.tsx";

afterEach(cleanup);

test("an agent's tools show the actions approved to run without asking", () => {
  render(<ProposalItems proposal={{ id: "prop_mail", status: "asked", names: { tool_mail: { kind: "tool", name: "Gmail" } }, items: [{ tool: "agents_create", input: { toolIds: ["tool_mail"] }, refs: ["toolIds"], used: false, tools: [{ toolId: "tool_mail", runs: ["search_emails", "read_email", "draft_email"] }] }] }} />);
  expect(screen.getByText("Runs without asking: search_emails, read_email, and draft_email")).toBeTruthy();
  expect(screen.getByText("Other enabled actions ask")).toBeTruthy();
});

const long = `Line one.\n${"Work carefully. ".repeat(400)}THE END`;
const proposal: ProposalView = {
  id: "prop_1",
  status: "asked",
  items: [
    { tool: "agents_create", used: false, refs: ["harnessId", "toolIds", "skillPackageIds", "dataTables"], input: { name: "Clerk", harnessId: "harness_1", systemPrompt: long, toolIds: ["tool_1", "tool_gone"], bundles: ["data", "configure"], dataTables: "all" } },
    { tool: "agents_update", used: true, refs: ["id", "harnessId", "toolIds", "skillPackageIds", "dataTables"], input: { id: "agent_1", name: "Builder", harnessId: "harness_1", systemPrompt: "New.", dataTables: ["table_1"] } },
  ],
  names: {
    harness_1: { kind: "harness", name: "Claude", detail: { text: "claude-code, on Workstation, permission mode default" } },
    tool_1: { kind: "tool", name: "Mail", detail: { text: "https://mail.example.com/mcp" } },
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
  expect(first.getByText("data and configure")).toBeTruthy();
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
      { tool: "agents_set_tool_permission", used: false, refs: ["agentId", "toolId"], input: { agentId: "agent_1", toolId: "tool_x", action: "table_1", permission: "run" } },
    ],
    names: { table_1: { kind: "table", name: "Clients" }, field_1: { kind: "field", name: "Phone", detail: say("data.field.ofTable", { table: "Clients" }) }, agent_1: { kind: "agent", name: "Builder" } },
  };
  render(<ProposalItems proposal={more} />);
  const [table, field, flag] = screen.getAllByRole("listitem");
  expect(within(table!).getByText("Delete a table, with its rows")).toBeTruthy();
  expect(within(table!).getByText("This can't be undone.")).toBeTruthy();
  expect(within(flag!).queryByText("This can't be undone.")).toBeNull();
  expect(table!.textContent).toContain("Clients");
  expect(field!.textContent).toContain("Phone (of the table Clients)");
  expect(within(field!).getByText("This can't be undone.")).toBeTruthy();
  expect(within(flag!).getByText("Set an action to Run, Ask, or Off")).toBeTruthy();
  expect(within(flag!).getAllByText(/tool_x: not one of yours/).length).toBeGreaterThan(0);
  // The action happens to read like a table's id: it is shown as the text it is.
  expect(within(flag!).getByText("table_1")).toBeTruthy();
  expect(within(flag!).getByText("run")).toBeTruthy();
});

test("deleting an agent and changing a field's type say they can't be undone, with names, and no dry run row", () => {
  const items: ProposalView = {
    id: "prop_r",
    status: "asked",
    items: [
      { tool: "agents_delete", used: false, refs: ["id"], input: { id: "agent_1" } },
      { tool: "fields_retype", used: false, refs: ["id"], input: { id: "field_1", type: "number", dryRun: false } },
    ],
    names: { agent_1: { kind: "agent", name: "Clerk" }, field_1: { kind: "field", name: "Amount" } },
  };
  render(<ProposalItems proposal={items} />);
  const [agent, field] = screen.getAllByRole("listitem");
  expect(within(agent!).getByText("Delete an agent, with its triggers: its Jobs still going stop")).toBeTruthy();
  expect(within(agent!).getByText("This can't be undone.")).toBeTruthy();
  expect(agent!.textContent).toContain("Clerk");
  expect(within(field!).getByText("Change a field's type: a value the new type can't hold is cleared")).toBeTruthy();
  expect(within(field!).getByText("This can't be undone.")).toBeTruthy();
  expect(within(field!).getByText("New type")).toBeTruthy();
  expect(field!.textContent).toContain("Amount");
  // The type by its name, as the Data screens show it.
  expect(within(field!).getByText("Number")).toBeTruthy();
  expect(field!.textContent).not.toMatch(/dryRun|Dry run/);
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

test("a marketplace to add shows the address the server will read, whole, its host, and its kind in words", () => {
  const market: ProposalView = {
    id: "prop_m",
    status: "asked",
    items: [
      { tool: "marketplaces_add", used: false, refs: [], input: { url: "acme/plugins", kind: "git" }, shown: { url: "https://github.com/acme/plugins.git" } },
      { tool: "marketplaces_add", used: false, refs: [], input: { url: "https://skills.example", kind: "well-known" }, shown: { url: "https://skills.example/.well-known/skills/index.json" } },
    ],
    names: {},
  };
  render(<ProposalItems proposal={market} />);
  const [git, site] = screen.getAllByRole("listitem");
  expect(within(git!).getByText("Add a marketplace: where plugins and skills are read from")).toBeTruthy();
  expect(within(git!).getByText("https://github.com/acme/plugins.git")).toBeTruthy();
  expect(within(git!).getByText("github.com")).toBeTruthy();
  expect(within(git!).getByText("Git repository")).toBeTruthy();
  expect(within(site!).getByText("https://skills.example/.well-known/skills/index.json")).toBeTruthy();
  expect(within(site!).getByText("Skill site")).toBeTruthy();
});

test("a plugin's server to add names its plugin and shows the address calls will go to", () => {
  const tool: ProposalView = {
    id: "prop_5",
    status: "asked",
    items: [{ tool: "plugins_add_server", used: false, refs: ["pluginId"], creates: "tool", input: { pluginId: "plugin_1", server: "case-law", url: "https://case-law.example.com/mcp", transport: "streamable-http" } }],
    names: { plugin_1: { kind: "plugin", name: "law-firm" } },
  };
  render(<ProposalItems proposal={tool} />);
  const [item] = screen.getAllByRole("listitem");
  expect(within(item!).getByText("Add a plugin's server as a tool: a server Dispand will call")).toBeTruthy();
  expect(within(item!).getAllByText("law-firm").length).toBeGreaterThan(0);
  expect(within(item!).getByText("case-law.example.com")).toBeTruthy();
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
        names: { agent_1: { kind: "agent", name: "Builder" }, table_1: { kind: "table", name: "Clients" }, field_1: { kind: "field", name: "City", detail: say("data.field.ofTable", { table: "Clients" }) } },
      }}
    />,
  );
  const item = screen.getByRole("listitem");
  expect(item.textContent).toContain("A change to the table Clients");
  expect(item.textContent).toContain("When a row is created or a row is changed");
  expect(item.textContent).toContain("A changed row only when one of these changed:City (of the table Clients)");
  expect(within(item).getByRole("alert").textContent).toBe("field_gone: not one of yours");
});

test("a trigger on Jobs reads as another agent's Job and its operations in words", () => {
  render(
    <ProposalItems
      proposal={{
        id: "prop_3",
        status: "asked",
        items: [{ tool: "triggers_create", used: false, refs: ["agentId"], input: { agentId: "agent_1", name: "On failures", config: { kind: "primitive", tableId: "job", operations: ["finished", "failed"] } } }],
        names: { agent_1: { kind: "agent", name: "Watcher" } },
      }}
    />,
  );
  const item = screen.getByRole("listitem");
  expect(item.textContent).toContain("A Job of another agent");
  expect(item.textContent).toContain("When one finishes or one fails or is stopped");
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

test("a poll trigger's tool reads by name, or as the item that adds it, never as JSON", () => {
  const setup: ProposalView = {
    id: "prop_poll",
    status: "asked",
    items: [
      { tool: "tools_add_from_catalog", used: false, refs: ["catalogId"], creates: "tool", createdId: null, input: { catalogId: "github" } },
      { tool: "triggers_create", used: false, refs: ["agentId"], creates: "trigger", createdId: null, input: { agentId: "agent_1", name: "New issue", config: { kind: "poll", toolId: { $item: 0 }, action: "list_issues", idPath: "id" } } },
      { tool: "triggers_create", used: false, refs: ["agentId"], creates: "trigger", createdId: null, input: { agentId: "agent_1", name: "New mail", config: { kind: "poll", toolId: "tool_mail", action: "search", idPath: "id" } } },
    ],
    names: { agent_1: { kind: "agent", name: "Builder" }, github: { kind: "catalog", name: "GitHub" }, tool_mail: { kind: "tool", name: "Gmail" } },
  };
  render(<ProposalItems proposal={setup} />);
  const [, byRef, byId] = screen.getAllByRole("listitem");
  expect(byRef!.textContent).toContain("Polls the tool item 1 creates");
  expect(byRef!.textContent).not.toContain("$item");
  expect(byId!.textContent).toContain("Polls Gmail");
  expect(byId!.textContent).toContain("search");
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
  expect(field!.textContent).toContain("ChoicesNew and Won");
  expect(field!.textContent).toContain("TypeSingle select");
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

const named: ProposalView["names"] = {
  t1: { kind: "table", name: "Clients" },
  t2: { kind: "table", name: "Orders" },
  f1: { kind: "field", name: "Phone" },
  a1: { kind: "agent", name: "Builder" },
  tool1: { kind: "tool", name: "Mail" },
  trg1: { kind: "trigger", name: "Daily" },
  h1: { kind: "harness", name: "Claude" },
  p1: { kind: "plugin", name: "Pack" },
  cat1: { kind: "catalog", name: "Gmail" },
};
const sentences: [string, Record<string, unknown>, string[], string][] = [
  ["tables_create", { name: "Matters" }, [], "Create a table named Matters."],
  ["tables_rename", { id: "t1", name: "People" }, ["id"], "Rename Clients t1 to People."],
  ["tables_set_primitive", { id: "t1", primitive: true }, ["id"], "Make Clients t1 a primitive table."],
  ["tables_set_primitive", { id: "t1", primitive: false }, ["id"], "Stop Clients t1 being a primitive table."],
  ["tables_delete", { id: "t1" }, ["id"], "Delete the table Clients t1 and its rows."],
  ["fields_update", { id: "f1", name: "Mobile" }, ["id"], "Change the field Phone f1."],
  ["fields_reorder", { tableId: "t1", fieldIds: ["f1"] }, ["tableId", "fieldIds"], "Reorder the fields of Clients t1."],
  ["fields_delete", { id: "f1" }, ["id"], "Delete the field Phone f1 and its values."],
  ["agents_update", { id: "a1", name: "Builder 2" }, ["id"], "Change the agent Builder a1."],
  ["agents_delete", { id: "a1" }, ["id"], "Delete the agent Builder a1 and its triggers."],
  ["agents_create", { name: "Clerk" }, [], "Create an agent named Clerk."],
  ["agents_set_tool_permission", { agentId: "a1", toolId: "tool1", action: "send", permission: "run" }, ["agentId", "toolId"], "Let Builder a1 run the action send of Mail tool1 without asking."],
  ["agents_set_tool_permission", { agentId: "a1", toolId: "tool1", action: "send", permission: "ask" }, ["agentId", "toolId"], "Make Builder a1 ask before it runs the action send of Mail tool1."],
  ["agents_set_tool_permission", { agentId: "a1", toolId: "tool1", action: "send", permission: "off" }, ["agentId", "toolId"], "Turn off the action send of Mail tool1 for Builder a1."],
  ["harnesses_set_limit", { id: "h1", maxWorking: 3 }, ["id"], "Let Claude h1 work on 3 sessions at once."],
  ["harnesses_set_limit", { id: "h1", maxWorking: 1 }, ["id"], "Let Claude h1 work on 1 session at once."],
  ["tools_add", { name: "Mail", url: "https://mail.example.com/mcp", transport: "http" }, [], "Add the tool Mail, a server Dispand will call at https://mail.example.com/mcp."],
  ["tools_add_from_catalog", { catalogId: "cat1" }, ["catalogId"], "Add a tool from the catalog entry Gmail cat1."],
  ["tools_delete", { id: "tool1" }, ["id"], "Delete the tool Mail tool1 and its saved headers."],
  ["plugins_add_server", { pluginId: "p1", server: "api", url: "https://x.example.com/mcp" }, ["pluginId"], "Add the server api of Pack p1 as a tool, called at https://x.example.com/mcp."],
  ["triggers_create", { agentId: "a1" }, ["agentId"], "Create a trigger that starts Jobs of Builder a1."],
  ["triggers_update", { id: "trg1" }, ["id"], "Change the trigger Daily trg1."],
  ["triggers_delete", { id: "trg1" }, ["id"], "Delete the trigger Daily trg1."],
  ["marketplaces_add", { url: "https://git.example.com/x.git", kind: "git" }, [], "Add the marketplace at https://git.example.com/x.git, where plugins and skills are read from."],
  ["plugins_add_server", { pluginId: "p1", server: "api", runnerId: "r1", digest: "d" }, ["pluginId"], "Add the server api of Pack p1 as a tool that runs on a runner."],
  ["memory_add", { scope: "workspace", path: "rules.md" }, [], "Add the memory entry rules.md."],
  ["memory_add", { scope: "data", tableId: "t1", path: "rules.md" }, ["tableId"], "Add the memory entry rules.md of Clients t1."],
  ["memory_update", { scope: "workspace", path: "rules.md" }, [], "Rewrite the memory entry rules.md."],
  ["memory_update", { scope: "data", tableId: "t1", path: "rules.md" }, ["tableId"], "Rewrite the memory entry rules.md of Clients t1."],
];

test("every kind of item reads as one whole sentence, its references by name", () => {
  for (const [tool, input, refs, text] of sentences) {
    const { container, unmount } = render(<ProposalItems proposal={{ id: "p", status: "asked", names: named, items: [{ tool, input, refs, used: false }] }} />);
    expect(container.querySelectorAll("li > p")[1]?.textContent, `${tool} ${JSON.stringify(input)}`).toBe(text);
    unmount();
  }
});

test("a field's sentences carry its type in words", () => {
  const { container } = render(<ProposalItems proposal={{ id: "p", status: "asked", names: named, items: [{ tool: "fields_create", input: { tableId: "t1", name: "Owner", type: "rowId", referencesTableId: "t2" }, refs: ["tableId", "referencesTableId"], used: false }, { tool: "fields_retype", input: { id: "f1", type: "number" }, refs: ["id"], used: false }] }} />);
  const [create, retype] = [...container.querySelectorAll("li")].map((li) => li.querySelectorAll(":scope > p")[1]?.textContent);
  expect(create).toMatch(/^Add the field Owner, of type .+, to Clients t1, naming rows of Orders t2\.$/);
  expect(retype).toMatch(/^Change the type of the field Phone f1 to .+; a value the new type can't hold is cleared\.$/);
});

test("an agent's instruction change marks only its changed lines, other changed fields read was and becomes", () => {
  const before = { name: "Builder", systemPrompt: "Be kind.\nAnswer fast.\nSign off.", harnessId: "h1", description: "" };
  const input = { id: "a1", name: "Builder", systemPrompt: "Be kind.\nAnswer carefully.\nSign off.", harnessId: "h1", description: "Builds" };
  const { container } = render(<ProposalItems proposal={{ id: "p", status: "asked", names: named, items: [{ tool: "agents_update", input, before, refs: ["id", "harnessId"], used: false }] }} />);
  const marked = [...container.querySelectorAll("[data-change]")].map((e) => [e.getAttribute("data-change"), e.textContent?.replace(/^(Added:|Removed:)/, "")]);
  expect(marked).toEqual([["same", "Be kind."], ["del", "Answer fast."], ["add", "Answer carefully."], ["same", "Sign off."]]);
  expect(container.querySelectorAll('[data-change="del"]')).toHaveLength(1);
  expect(container.textContent).toContain("Was: empty");
  expect(container.textContent).toContain("Becomes: Builds");
  // Nothing is hidden by comparing with the live row: an unchanged field still shows.
  expect(container.textContent).toContain("Claude");
});

test("agent-authored instructions render as text, never HTML", () => {
  const input = { id: "a1", systemPrompt: "<img src=x onerror=alert(1)>\nNew" };
  const { container } = render(<ProposalItems proposal={{ id: "p", status: "asked", names: named, items: [{ tool: "agents_update", input, before: { systemPrompt: "Old\nNew" }, refs: ["id"], used: false }] }} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
});

test("a self-learning change keeps the words and the workspace warning", () => {
  const { container } = render(<ProposalItems proposal={{ id: "p", status: "asked", names: named, items: [{ tool: "agents_update", input: { id: "a1", selfLearning: ["workspace"] }, before: { selfLearning: [] }, refs: ["id"], used: false }] }} />);
  expect(container.textContent).toContain("The workspace's memory");
  expect(container.textContent).toContain("What it writes steers every agent of the workspace.");
});
