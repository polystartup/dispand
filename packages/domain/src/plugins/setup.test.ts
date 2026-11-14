import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents as agentsTable, fields as fieldsTable, plugins as pluginsTable, tables as tablesTable, tools as toolsTable, triggers as triggersTable } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import type { SetupPick } from "./setup.ts";
import { fixtureRepo, lawFirmMarket, removePlugin } from "./test-support.ts";
import { catalogEntry } from "../tools/catalog.ts";
import { type FakeAction, startFakeMcp } from "../tools/test-server.ts";

const lookup: FakeAction = { name: "lookup", description: "Finds case law", inputSchema: { type: "object" }, call: () => ({ content: [] }) };

const ALL = { primitives: ["Clients", "Matters", "Research"] };

/** The owner's context with the law-firm plugin installed (definitions, and the skills given). */
async function installed(skills: string[] = [], caseLaw: { apiKey?: string } = {}) {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  // The fixture's case-law server, which a setup adds as a tool when an agent names it.
  const server = await startFakeMcp([lookup], "streamable-http", caseLaw);
  const fx = lawFirmMarket(server.url);
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { marketplaceId: market.id, entryName: "law-firm", skills }, { context: ctx });
  return {
    ctx,
    pluginId,
    server,
    remove: () => {
      fx.remove();
      void server.close();
    },
  };
}

type Ctx = Awaited<ReturnType<typeof installed>>["ctx"];

const setUp = async (ctx: Ctx, id: string, pick: SetupPick = ALL) => {
  const { reviewed } = await call(router.plugins.setupPreview, { id, pick }, { context: ctx });
  return call(router.plugins.setUp, { id, pick, reviewed }, { context: ctx });
};
const tableNamed = async (ctx: Ctx, name: string) => (await call(router.tables.list, undefined, { context: ctx })).find((t) => t.name === name);
const createdOf = async (ctx: Ctx, id: string) => (await ctx.db.select({ created: pluginsTable.created }).from(pluginsTable).where(eq(pluginsTable.id, id)))[0]!.created;

test("the fixture's primitives set up from the plugin make its tables, fields and parents, all recorded; a second run makes nothing", async () => {
  const { ctx, pluginId, remove } = await installed();
  const preview = await call(router.plugins.setupPreview, { id: pluginId, pick: ALL }, { context: ctx });
  expect(preview.items.map((i) => i.tool)).toEqual(["tables_create", "tables_create", "tables_create", "fields_create", "fields_create", "fields_create", "fields_create", "tables_set_primitive", "tables_set_primitive", "tables_set_primitive"]);
  // Items name the tables earlier items make, as a proposal's do.
  expect(preview.items[4]).toMatchObject({ input: { tableId: { $item: 1 }, name: "Clients", type: "reference", referencesTableId: { $item: 0 } }, creates: "field" });
  expect(preview.items[8]).toMatchObject({ input: { id: { $item: 1 }, primitive: true, parent: { tableId: { $item: 0 }, required: false } } });
  expect(preview.waiting).toEqual([]);

  const { outcomes, waiting } = await setUp(ctx, pluginId);
  expect(waiting).toEqual([]);
  expect(outcomes.every((o) => o.outcome === "made")).toBe(true);
  const clients = (await tableNamed(ctx, "Clients"))!;
  const matters = await call(router.tables.get, { id: (await tableNamed(ctx, "Matters"))!.id }, { context: ctx });
  const research = (await tableNamed(ctx, "Research"))!;
  expect([clients.primitive, matters.primitive, research.primitive]).toEqual([true, true, true]);
  const parentField = matters.fields.find((f) => f.name === "Clients")!;
  expect(parentField).toMatchObject({ type: "reference", referencesTableId: clients.id });
  expect(matters.parent).toEqual({ fieldId: parentField.id, tableId: clients.id, required: false });
  // One reference field to the parent: the definition's, not one more made for the parent.
  expect(matters.fields.map((f) => f.name)).toEqual(["Name", "Clients", "Conclusions"]);

  const created = await createdOf(ctx, pluginId);
  expect(created.table?.sort()).toEqual([clients.id, matters.id, research.id].sort());
  expect(created.field).toHaveLength(4);
  expect(created.from).toMatchObject({ "primitive:Clients": clients.id, "primitive:Matters": matters.id, "primitive:Research": research.id, "field:Matters.Clients": parentField.id });
  const [listed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(listed!.definitions.primitives.every((d) => d.setUp)).toBe(true);

  // Run again: everything is there, nothing is made twice.
  expect((await call(router.plugins.setupPreview, { id: pluginId, pick: ALL }, { context: ctx })).items).toEqual([]);
  expect((await setUp(ctx, pluginId)).outcomes).toEqual([]);
  expect((await call(router.tables.list, undefined, { context: ctx })).map((t) => t.name)).toEqual(["Clients", "Matters", "Research"]);
  remove();
});

test("what a setup makes is the plugin's: named inside it, beside the owner's own of the same name, with the plugin's values kept", async () => {
  const { ctx, pluginId, remove } = await installed();
  const harnessId = await cloudHarness(ctx);
  // The owner's own Research: no clash, and never taken for the plugin's.
  const own = await call(router.tables.create, { name: "research" }, { context: ctx });
  const { outcomes } = await setUp(ctx, pluginId, { ...ALL, agents: [{ name: "Matter upkeep", harnessId }] });
  expect(outcomes.every((o) => o.outcome === "made")).toBe(true);

  const rows = await ctx.db.select().from(tablesTable).orderBy(tablesTable.name);
  expect(rows.map((t) => [t.name, t.pluginId, t.pluginComponent])).toEqual([
    ["Clients", pluginId, "Clients"],
    ["Matters", pluginId, "Matters"],
    ["Research", pluginId, "Research"],
    ["research", null, null],
  ]);
  // Each keeps the definition it was made from: what a later update is compared with.
  const matters = rows.find((t) => t.name === "Matters")!;
  expect(matters.definition).toMatchObject({ name: "Matters", primitive: true });
  const fields = await ctx.db.select().from(fieldsTable).where(eq(fieldsTable.tableId, matters.id));
  expect(Object.fromEntries(fields.map((f) => [f.name, f.pluginField]))).toMatchObject({ Name: null, Clients: "Clients" });
  expect((await call(router.tables.list, undefined, { context: ctx })).find((t) => t.id === matters.id)).toMatchObject({ plugin: { id: pluginId, name: "law-firm" } });

  // Its agent is the plugin's too: its rights name the plugin's table by id, and a change of it is an override.
  const upkeep = await agentNamed(ctx, "Matter upkeep");
  expect(upkeep).toMatchObject({ plugin: { id: pluginId, name: "law-firm" }, dataTables: [matters.id], overridden: [] });
  const [agentRow] = await ctx.db.select().from(agentsTable).where(eq(agentsTable.id, upkeep.id));
  expect(agentRow).toMatchObject({ pluginComponent: "Matter upkeep", upstream: { name: "Matter upkeep", dataTables: [matters.id], toolIds: [], consults: [] } });
  const edited = await call(router.agents.update, { id: upkeep.id, name: upkeep.name, harnessId, systemPrompt: "Mine.", skillPackageIds: [], toolIds: [] }, { context: ctx });
  expect(edited.overridden).toEqual(["systemPrompt"]);

  // Neither goes on its own.
  const refusal = { code: "FORBIDDEN", message: "It is law-firm's: uninstall the plugin to remove it" };
  await expect(call(router.tables.delete, { id: matters.id }, { context: ctx })).rejects.toMatchObject(refusal);
  await call(router.tables.delete, { id: own.id }, { context: ctx });
  remove();
});

test("a plugin's table kept at uninstall is its owner's own, under a free name", async () => {
  const { ctx, pluginId, remove } = await installed();
  await call(router.tables.create, { name: "Clients" }, { context: ctx });
  await setUp(ctx, pluginId);
  await removePlugin(ctx, pluginId);
  const rows = await ctx.db.select().from(tablesTable).orderBy(tablesTable.name);
  expect(rows.map((t) => t.name)).toEqual(["Clients", "Clients (law-firm)", "Matters", "Research"]);
  expect(rows.every((t) => t.pluginId === null && t.pluginComponent === null && t.definition === null)).toBe(true);
  expect((await ctx.db.select().from(fieldsTable)).every((f) => f.pluginField === null)).toBe(true);
  remove();
});

test("a resumed run binds to recorded rows by id, makes again what is gone, and never binds a table by its name", async () => {
  const { ctx, pluginId, remove } = await installed();
  await setUp(ctx, pluginId);
  const clients = (await tableNamed(ctx, "Clients"))!;
  const matters = await call(router.tables.get, { id: (await tableNamed(ctx, "Matters"))!.id }, { context: ctx });
  // The owner renames a table the setup made and makes an unrelated one with its old name.
  await call(router.tables.rename, { id: clients.id, name: "Customers" }, { context: ctx });
  const unrelated = await call(router.tables.create, { name: "Clients" }, { context: ctx });
  // They delete a field the setup made.
  await call(router.fields.delete, { id: matters.fields.find((f) => f.name === "Conclusions")!.id }, { context: ctx });

  const preview = await call(router.plugins.setupPreview, { id: pluginId, pick: ALL }, { context: ctx });
  expect(preview.items).toMatchObject([{ tool: "fields_create", input: { tableId: matters.id, name: "Conclusions", type: "long-text" } }]);
  const again = await setUp(ctx, pluginId);
  expect(again.outcomes).toMatchObject([{ outcome: "made", from: "field:Matters.Conclusions" }]);
  expect((await createdOf(ctx, pluginId)).from?.["primitive:Clients"]).toBe(clients.id);

  // A recorded table that is gone is made again, as the plugin's; the owner's unrelated table bearing its name is never bound.
  // Gone without its plugin (its own delete is refused): as when an update or an uninstall removed it.
  await ctx.db.delete(tablesTable).where(eq(tablesTable.id, (await tableNamed(ctx, "Research"))!.id));
  await call(router.tables.rename, { id: unrelated.id, name: "Research" }, { context: ctx });
  const remade = await setUp(ctx, pluginId);
  expect(remade.outcomes[0]).toEqual({ $item: 0, tool: "tables_create", from: "primitive:Research", outcome: "made", id: expect.any(String) });
  expect(remade.outcomes[0]!.id).not.toBe(unrelated.id);
  expect(Object.values((await createdOf(ctx, pluginId)).from ?? {})).not.toContain(unrelated.id);
  expect((await call(router.tables.get, { id: unrelated.id }, { context: ctx })).fields.map((f) => f.name)).toEqual(["Name"]);
  remove();
});

test("a primitive needs the plugin's tables it names picked or made before", async () => {
  const { ctx, pluginId, remove } = await installed();
  await expect(setUp(ctx, pluginId, { primitives: ["Matters"] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "“Matters” names the table “Clients” of this plugin: pick it too" });
  await expect(setUp(ctx, pluginId, { primitives: ["Billing"] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "“Billing” isn't a table definition of this plugin" });
  expect(await call(router.tables.list, undefined, { context: ctx })).toEqual([]);
  // Once Clients is set up, Matters alone names it by id.
  await setUp(ctx, pluginId, { primitives: ["Clients"] });
  const clients = (await tableNamed(ctx, "Clients"))!;
  const preview = await call(router.plugins.setupPreview, { id: pluginId, pick: { primitives: ["Matters"] } }, { context: ctx });
  expect(preview.items[1]).toMatchObject({ input: { name: "Clients", referencesTableId: clients.id } });
  expect(preview.names[clients.id]).toEqual({ kind: "table", name: "Clients" });
  remove();
});

test("a field naming a table of the workspace gets that table's id, or waits for it", async () => {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  const plugin = fixtureRepo({
    "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "notes" }),
    "com.dispand/primitives/notes.json": JSON.stringify({
      name: "Notes",
      primitive: false,
      fields: [
        { name: "Contact", type: "reference", references: "Contacts" },
        { name: "Name", type: "text" },
      ],
    }),
  });
  const repo = fixtureRepo({ ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [{ name: "notes", source: { source: "url", url: plugin.url } }] }) });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { marketplaceId: market.id, entryName: "notes" }, { context: ctx });
  const pick = { primitives: ["Notes"] };

  const waiting = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  expect(waiting.items.map((i) => i.tool)).toEqual(["tables_create"]);
  expect(waiting.waiting).toEqual([
    { definition: "field:Notes.Contact", reason: "No table of the workspace is called “Contacts”" },
    { definition: "field:Notes.Name", reason: "Every table has a Name field already: this one isn't added" },
  ]);

  const contacts = await call(router.tables.create, { name: "contacts" }, { context: ctx });
  const ready = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  expect(ready.items[1]).toMatchObject({ tool: "fields_create", input: { tableId: { $item: 0 }, name: "Contact", referencesTableId: contacts.id } });
  plugin.remove();
  repo.remove();
});

const AGENTS = ["Intake and research", "Drafting", "Matter upkeep"];
const cloudHarness = async (ctx: Ctx) =>
  (await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context: ctx })).id;
const agentNamed = async (ctx: Ctx, name: string) => {
  const agent = (await call(router.agents.list, undefined, { context: ctx })).find((a) => a.name === name)!;
  return call(router.agents.get, { id: agent.id }, { context: ctx });
};

test("plugin setup shows the exact tool permissions and refuses a changed preview before making anything", async () => {
  const { ctx, pluginId, remove } = await installed();
  try {
    const harnessId = await cloudHarness(ctx);
    const action = catalogEntry("gmail")!.unasked![0]!;
    await ctx.db.insert(toolsTable).values({ id: "tool_gmail", ownerId: ctx.ownerId, name: "Gmail", kind: "http", url: "https://mail.example.com/mcp", transport: "streamable-http", catalogId: "gmail", actions: [{ name: action, description: "Read", inputSchema: { type: "object" }, readOnly: true }] });
    const pick = { ...ALL, agents: [{ name: "Drafting", harnessId }] };
    const before = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
    expect(before.items.at(-1)!.tools).toEqual([{ toolId: "tool_gmail", runs: [action] }]);
    await ctx.db.update(toolsTable).set({ actions: [] }).where(eq(toolsTable.id, "tool_gmail"));
    await expect(call(router.plugins.setUp, { id: pluginId, pick, reviewed: before.reviewed }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await tableNamed(ctx, "Clients")).toBeUndefined();
    const after = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
    expect(after.items.at(-1)!.tools).toEqual([{ toolId: "tool_gmail", runs: [] }]);
    expect((await call(router.plugins.setUp, { id: pluginId, pick, reviewed: after.reviewed }, { context: ctx })).outcomes.every((o) => o.outcome === "made")).toBe(true);
  } finally { remove(); }
});

test("the fixture's agents are set up as the plugin's, with their tables, skill package, tools and consults", async () => {
  const { ctx, pluginId, remove } = await installed(["legal-research"]);
  const harnessId = await cloudHarness(ctx);
  // The owner's Gmail, added from the catalog before: the agents naming it get it.
  await ctx.db.insert(toolsTable).values({ id: "tool_gmail", ownerId: ctx.ownerId, name: "Gmail", kind: "http", url: "https://mail.example.com/mcp", transport: "streamable-http", catalogId: "gmail" });
  const pick = { ...ALL, agents: AGENTS.map((name) => ({ name, harnessId })) };

  const preview = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  const agentItems = preview.items.slice(10);
  // The plugin's server Intake and research names is added first, with the URL the owner reads.
  expect(agentItems.map((i) => i.tool)).toEqual(["plugins_add_server", "agents_create", "agents_create", "agents_create"]);
  expect(agentItems[0]).toMatchObject({ input: { pluginId, server: "case-law", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/), transport: "streamable-http" }, creates: "tool" });
  expect(preview.names[pluginId]).toEqual({ kind: "plugin", name: "law-firm" });
  expect(agentItems[1]).toMatchObject({ input: { name: "Intake and research", toolIds: ["tool_gmail", { $item: 10 }] } });
  // Drafting consults Intake and research, which comes first; tables are those this setup makes.
  expect(agentItems[2]).toMatchObject({
    input: { name: "Drafting", harnessId, bundles: ["data"], dataTables: [{ $item: 1 }, { $item: 2 }], toolIds: ["tool_gmail"], skillPackageIds: [], consults: [{ agentId: { $item: 11 }, ask: false }] },
    creates: "agent",
  });
  expect(preview.waiting).toEqual([]);

  const { outcomes } = await setUp(ctx, pluginId, pick);
  expect(outcomes.every((o) => o.outcome === "made")).toBe(true);
  const [clients, matters, research] = await Promise.all(["Clients", "Matters", "Research"].map(async (n) => (await tableNamed(ctx, n))!.id));
  const intake = await agentNamed(ctx, "Intake and research");
  const drafting = await agentNamed(ctx, "Drafting");
  const upkeep = await agentNamed(ctx, "Matter upkeep");
  expect(intake).toMatchObject({ harnessId, bundles: ["data"], dataTables: [clients, matters, research], plugin: { id: pluginId, name: "law-firm" }, systemPrompt: expect.stringContaining("Read each new client email") });
  expect(intake.description).toBe("Takes in each new client email, finds its client and matter, and researches it.");
  expect(JSON.stringify(intake)).toContain("law-firm");
  expect(drafting.consults).toEqual([{ agentId: intake.id, ask: false, inactive: null }]);
  expect(JSON.stringify(drafting)).toContain("tool_gmail");
  const caseLaw = (await ctx.db.select().from(toolsTable).where(eq(toolsTable.pluginComponent, "case-law")))[0]!;
  expect(JSON.stringify(intake)).toContain(caseLaw.id);
  expect(caseLaw).toMatchObject({ pluginId, actions: [expect.objectContaining({ name: "lookup" })], actionsError: null });
  expect(upkeep.dataTables).toEqual([matters]);
  // The plugin's agents, each under its definition's name; listed as what it made.
  const rows = await ctx.db.select({ pluginId: agentsTable.pluginId, component: agentsTable.pluginComponent }).from(agentsTable);
  expect(rows.map((r) => [r.pluginId, r.component]).sort()).toEqual(AGENTS.map((name) => [pluginId, name]).sort());
  const created = await createdOf(ctx, pluginId);
  expect(created.agent?.sort()).toEqual([intake.id, drafting.id, upkeep.id].sort());
  expect(created.from).toMatchObject({ "agent:Intake and research": intake.id, "agent:Drafting": drafting.id, "agent:Matter upkeep": upkeep.id });
  remove();
});

test("an agent on a table the pick leaves out gets the workspace table of that name, or waits for it", async () => {
  const { ctx, pluginId, remove } = await installed();
  const harnessId = await cloudHarness(ctx);
  const pick = { agents: [{ name: "Matter upkeep", harnessId }] };
  const waiting = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  expect(waiting.items).toEqual([]);
  expect(waiting.waiting).toEqual([{ definition: "agent:Matter upkeep", reason: "No table “Matters” is set up or in the workspace: pick it too, or make it" }]);

  const matters = await call(router.tables.create, { name: "matters" }, { context: ctx });
  const ready = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  expect(ready.items).toMatchObject([{ tool: "agents_create", input: { name: "Matter upkeep", dataTables: [matters.id] } }]);
  expect(ready.names[matters.id]).toEqual({ kind: "table", name: "matters" });
  remove();
});

test("a second setup makes only the agents not made yet, and consults the ones made before by id", async () => {
  const { ctx, pluginId, remove } = await installed();
  const harnessId = await cloudHarness(ctx);
  await setUp(ctx, pluginId, { ...ALL, agents: [{ name: "Intake and research", harnessId }] });
  const intake = await agentNamed(ctx, "Intake and research");
  // Renamed by the owner: still the one this plugin made.
  await call(router.agents.update, { ...intake, name: "Intake", skillPackageIds: [], toolIds: [], consults: [] }, { context: ctx });

  const pick = { ...ALL, agents: AGENTS.map((name) => ({ name, harnessId })) };
  const preview = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  expect(preview.items.map((i) => (i.input as { name: string }).name)).toEqual(["Drafting", "Matter upkeep"]);
  expect(preview.items[0]).toMatchObject({ input: { consults: [{ agentId: intake.id, ask: false }] } });
  await setUp(ctx, pluginId, pick);
  expect((await call(router.agents.list, undefined, { context: ctx })).map((a) => a.name).sort()).toEqual(["Drafting", "Intake", "Matter upkeep"]);
  expect((await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx })).items).toEqual([]);
  remove();
});

test("a consult between an agent that changes the workspace and one that doesn't is refused as for any agent, and the run stops there", async () => {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  const plugin = fixtureRepo({
    "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "crew" }),
    "com.dispand/agents/builder.md": "---\nname: Builder\nbundles: [configure]\nconsults:\n  - agent: Helper\n    ask: true\n---\n\nBuild.\n",
    "com.dispand/agents/helper.md": "---\nname: Helper\nbundles: [data]\n---\n\nHelp.\n",
  });
  const repo = fixtureRepo({ ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [{ name: "crew", source: { source: "url", url: plugin.url } }] }) });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { marketplaceId: market.id, entryName: "crew" }, { context: ctx });
  const harnessId = await cloudHarness(ctx);

  const pick = { agents: [{ name: "Builder", harnessId }, { name: "Helper", harnessId }] };
  // A definition without tables: the item says "all", the scope the agent gets, so the owner reads it.
  const preview = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  expect(preview.items[0]).toMatchObject({ input: { name: "Helper", bundles: ["data"], dataTables: "all" } });
  const { outcomes } = await setUp(ctx, pluginId, pick);
  expect(outcomes).toEqual([
    { $item: 0, tool: "agents_create", from: "agent:Helper", outcome: "made", id: expect.any(String) },
    { $item: 1, tool: "agents_create", from: "agent:Builder", outcome: "refused", error: "Builder changes the workspace and Helper doesn't: an agent that changes the workspace and one that doesn't never consult each other" },
  ]);
  expect((await call(router.agents.list, undefined, { context: ctx })).map((a) => a.name)).toEqual(["Helper"]);
  plugin.remove();
  repo.remove();
});

test("a picked server is added as a tool without credentials, reads “needs sign-in” until its header is entered, and stays after uninstall", async () => {
  const { ctx, pluginId, remove } = await installed([], { apiKey: "case-key" });
  try {
    const pick = { servers: [{ name: "case-law" }] };
    const preview = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
    expect(preview.items).toMatchObject([{ tool: "plugins_add_server", input: { pluginId, server: "case-law" } }]);
    const { outcomes } = await setUp(ctx, pluginId, pick);
    const toolId = outcomes[0]!.id!;
    const tool = await call(router.tools.get, { id: toolId }, { context: ctx });
    expect(tool).toMatchObject({ signIn: "needed", actionsError: expect.stringContaining("refused the request (401)") });
    expect((await createdOf(ctx, pluginId)).from).toMatchObject({ "server:case-law": toolId });
    // Set up again: the tool is reused, not added twice.
    expect((await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx })).items).toEqual([]);

    await call(router.tools.update, { id: toolId, headers: { authorization: "Bearer case-key" } }, { context: ctx });
    expect(await call(router.tools.get, { id: toolId }, { context: ctx })).toMatchObject({ signIn: "connected", actions: [expect.objectContaining({ name: "lookup" })] });

    await removePlugin(ctx, pluginId);
    expect(await call(router.tools.get, { id: toolId }, { context: ctx })).toMatchObject({ id: toolId, plugin: null });
  } finally {
    remove();
  }
});

test("adding a server checks the URL and transport the owner reviewed, and names only the plugin's servers", async () => {
  const { ctx, pluginId, server, remove } = await installed();
  try {
    const input = { pluginId, server: "case-law", url: server.url, transport: "streamable-http" as const };
    await expect(call(router.plugins.addServer, { ...input, url: "https://elsewhere.example.com/mcp" }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(call(router.plugins.addServer, { ...input, transport: "sse" }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(call(router.plugins.addServer, { ...input, server: "nope" }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(call(router.plugins.setupPreview, { id: pluginId, pick: { servers: [{ name: "nope" }] } }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await call(router.plugins.addServer, input, { context: ctx })).toMatchObject({ name: "case-law", plugin: { id: pluginId } });
  } finally {
    remove();
  }
});

test("a kept table takes the next free name when the first one is taken too", async () => {
  const { ctx, pluginId, remove } = await installed();
  await call(router.tables.create, { name: "Clients" }, { context: ctx });
  await call(router.tables.create, { name: "Clients (law-firm)" }, { context: ctx });
  await setUp(ctx, pluginId);
  await removePlugin(ctx, pluginId);
  expect((await ctx.db.select().from(tablesTable).orderBy(tablesTable.name)).map((t) => t.name)).toEqual(["Clients", "Clients (law-firm)", "Clients (law-firm) 2", "Matters", "Research"]);
  remove();
});

const TRIGGERS = ["Matter changed", "New client email", "Research recorded"];

test("the fixture's triggers are set up on its agents as the plugin's: its table by id, the catalog's poll at once, nothing twice", async () => {
  const { ctx, pluginId, remove } = await installed(["legal-research"]);
  try {
    const harnessId = await cloudHarness(ctx);
    const pick = { ...ALL, agents: AGENTS.map((name) => ({ name, harnessId })), triggers: TRIGGERS };
    const preview = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
    expect(preview.items.filter((i) => i.tool === "triggers_create").map((i) => (i.input as { name: string }).name).sort()).toEqual(TRIGGERS);
    // Gmail isn't a tool yet: it is added from the catalog, as the owner's own, before the agents that use it.
    expect(preview.items.filter((i) => i.tool === "tools_add_from_catalog")).toHaveLength(1);
    expect(preview.waiting).toEqual([]);
    const { outcomes } = await setUp(ctx, pluginId, pick);
    expect(outcomes.filter((o) => o.outcome !== "made")).toEqual([]);

    const rows = await ctx.db.select().from(triggersTable);
    const upkeep = await agentNamed(ctx, "Matter upkeep");
    const matters = (await tableNamed(ctx, "Matters"))!;
    const changed = rows.find((t) => t.name === "Matter changed")!;
    expect(changed).toMatchObject({
      agentId: upkeep.id,
      kind: "primitive",
      enabled: true,
      instructions: "Update the conclusions.",
      config: { kind: "primitive", tableId: matters.id, operations: ["updated"] },
      pluginId,
      pluginComponent: "Matter changed",
      upstream: { name: "Matter changed", instructions: "Update the conclusions.", concurrency: "parallel", rateCap: 60 },
      overridden: [],
    });
    const [gmail] = await ctx.db.select().from(toolsTable).where(eq(toolsTable.catalogId, "gmail"));
    expect(gmail).toMatchObject({ pluginId: null });
    expect(rows.find((t) => t.name === "New client email")).toMatchObject({ kind: "poll", config: { toolId: gmail!.id, action: "search_threads", idPath: "id" }, pluginId });
    expect((await createdOf(ctx, pluginId)).from).toMatchObject({ "trigger:Matter changed": changed.id });
    expect((await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx })).items).toEqual([]);

    // A change of one is its owner's override; on or off is their setting; it goes only with its plugin.
    expect((await call(router.triggers.update, { id: changed.id, instructions: "Mine." }, { context: ctx })).overridden).toEqual(["instructions"]);
    expect((await call(router.triggers.update, { id: changed.id, enabled: false }, { context: ctx })).overridden).toEqual(["instructions"]);
    expect(await call(router.plugins.resetOverride, { kind: "trigger", id: changed.id, field: "instructions" }, { context: ctx })).toEqual({ overridden: [] });
    expect(await call(router.triggers.get, { id: changed.id }, { context: ctx })).toMatchObject({ instructions: "Update the conclusions.", enabled: false });
    await expect(call(router.triggers.delete, { id: changed.id }, { context: ctx })).rejects.toMatchObject({ code: "FORBIDDEN", message: "It is law-firm's: uninstall the plugin to remove it" });
    // The owner's own trigger on the plugin's agent is theirs to delete.
    const own = await call(router.triggers.create, { agentId: upkeep.id, name: "By hand", instructions: "Tidy up.", config: { kind: "manual", placement: "button" } }, { context: ctx });
    expect(own.overridden).toEqual([]);
    await call(router.triggers.delete, { id: own.id }, { context: ctx });
  } finally {
    remove();
  }
});

test("a trigger waits for its agent, and for a table its agent may not work on", async () => {
  const { ctx, pluginId, remove } = await installed();
  try {
    const alone = await call(router.plugins.setupPreview, { id: pluginId, pick: { triggers: ["Matter changed"] } }, { context: ctx });
    expect(alone.items).toEqual([]);
    expect(alone.waiting).toEqual([{ definition: "trigger:Matter changed", reason: "Its agent “Matter upkeep” isn't set up: pick it too" }]);
    await expect(call(router.plugins.setupPreview, { id: pluginId, pick: { triggers: ["Nope"] } }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  } finally {
    remove();
  }
});

test("a poll its tool wouldn't let run is listed as waiting, even when its agent is made by the same setup, and the other triggers are made", async () => {
  const { ctx, pluginId, remove } = await installed();
  try {
    const harnessId = await cloudHarness(ctx);
    // The owner's Gmail, with the action the poll reads turned off workspace-wide.
    const gmail = await call(router.tools.addFromCatalog, { catalogId: "gmail" }, { context: ctx });
    await call(router.tools.setActionEnabled, { toolId: gmail.id, action: "search_threads", enabled: false }, { context: ctx });
    const pick = { ...ALL, agents: AGENTS.map((name) => ({ name, harnessId })), triggers: TRIGGERS };
    const preview = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
    expect(preview.waiting).toContainEqual({ definition: "trigger:New client email", reason: "This action is disabled workspace-wide" });
    const { outcomes } = await setUp(ctx, pluginId, pick);
    expect(outcomes.filter((o) => o.outcome !== "made")).toEqual([]);
    expect((await ctx.db.select({ name: triggersTable.name }).from(triggersTable)).map((t) => t.name).sort()).toEqual(["Matter changed", "Research recorded"]);
  } finally {
    remove();
  }
});
