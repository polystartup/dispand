import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents as agentsTable, plugins as pluginsTable, tools as toolsTable } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import type { SetupPick } from "./setup.ts";
import { fixtureRepo, lawFirmMarket } from "./test-support.ts";

const ALL = { primitives: ["Clients", "Matters", "Research"] };

/** The owner's context with the law-firm plugin installed (definitions, and the skills given). */
async function installed(skills: string[] = []) {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  const fx = lawFirmMarket();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { marketplaceId: market.id, entryName: "law-firm", skills }, { context: ctx });
  return { ctx, pluginId, remove: fx.remove };
}

type Ctx = Awaited<ReturnType<typeof installed>>["ctx"];

const setUp = (ctx: Ctx, id: string, pick: SetupPick = ALL) => call(router.plugins.setUp, { id, pick }, { context: ctx });
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

test("a run stops where the owner's own table holds a name and says so; once renamed, the next run resumes without duplicates", async () => {
  const { ctx, pluginId, remove } = await installed();
  const own = await call(router.tables.create, { name: "research" }, { context: ctx });
  const first = await setUp(ctx, pluginId);
  expect(first.outcomes.slice(0, 4)).toEqual([
    { $item: 0, tool: "tables_create", from: "primitive:Clients", outcome: "made", id: expect.any(String) },
    { $item: 1, tool: "tables_create", from: "primitive:Matters", outcome: "made", id: expect.any(String) },
    { $item: 2, tool: "tables_create", from: "primitive:Research", outcome: "refused", error: "A table is already called “Research”" },
    { $item: 3, tool: "fields_create", from: "field:Clients.Email", outcome: "not made" },
  ]);
  expect(first.outcomes.slice(3).every((o) => o.outcome === "not made")).toBe(true);

  await call(router.tables.rename, { id: own.id, name: "Old research" }, { context: ctx });
  const second = await setUp(ctx, pluginId);
  // Clients and Matters are reused by id: only Research is made.
  expect(second.outcomes.filter((o) => o.tool === "tables_create").map((o) => o.from)).toEqual(["primitive:Research"]);
  expect(second.outcomes.every((o) => o.outcome === "made")).toBe(true);
  expect((await call(router.tables.list, undefined, { context: ctx })).map((t) => t.name)).toEqual(["Clients", "Matters", "Old research", "Research"]);
  const research = await call(router.tables.get, { id: (await tableNamed(ctx, "Research"))!.id }, { context: ctx });
  expect(research.fields.map((f) => f.name)).toEqual(["Name", "Matters"]);
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

  // A recorded table that is gone is made again; the unrelated table bearing its name is reported, never bound.
  await call(router.tables.delete, { id: (await tableNamed(ctx, "Research"))!.id }, { context: ctx });
  await call(router.tables.rename, { id: unrelated.id, name: "Research" }, { context: ctx });
  const stopped = await setUp(ctx, pluginId);
  expect(stopped.outcomes[0]).toEqual({ $item: 0, tool: "tables_create", from: "primitive:Research", outcome: "refused", error: "A table is already called “Research”" });
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

test("the fixture's agents are set up as copies with their tables, skill package, tools and consults", async () => {
  const { ctx, pluginId, remove } = await installed(["legal-research"]);
  const harnessId = await cloudHarness(ctx);
  // The owner's Gmail, added from the catalog before: the agents naming it get it.
  await ctx.db.insert(toolsTable).values({ id: "tool_gmail", ownerId: ctx.ownerId, name: "Gmail", kind: "http", url: "https://mail.example.com/mcp", transport: "streamable-http", catalogId: "gmail" });
  const pick = { ...ALL, agents: AGENTS.map((name) => ({ name, harnessId })) };

  const preview = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  const agentItems = preview.items.slice(10);
  expect(agentItems.map((i) => i.tool)).toEqual(["agents_create", "agents_create", "agents_create"]);
  // Drafting consults Intake and research, which comes first; tables are those this setup makes.
  expect(agentItems[1]).toMatchObject({
    input: { name: "Drafting", harnessId, bundles: ["data"], dataTables: [{ $item: 1 }, { $item: 2 }], toolIds: ["tool_gmail"], skillPackageIds: [], consults: [{ agentId: { $item: 10 }, ask: false }] },
    creates: "agent",
  });
  expect(preview.waiting).toEqual([{ definition: "agent:Intake and research", reason: "“case-law” isn't added as a tool yet: the agent is made without it" }]);

  const { outcomes } = await setUp(ctx, pluginId, pick);
  expect(outcomes.every((o) => o.outcome === "made")).toBe(true);
  const [clients, matters, research] = await Promise.all(["Clients", "Matters", "Research"].map(async (n) => (await tableNamed(ctx, n))!.id));
  const intake = await agentNamed(ctx, "Intake and research");
  const drafting = await agentNamed(ctx, "Drafting");
  const upkeep = await agentNamed(ctx, "Matter upkeep");
  expect(intake).toMatchObject({ harnessId, bundles: ["data"], dataTables: [clients, matters, research], plugin: null, systemPrompt: expect.stringContaining("Read each new client email") });
  expect(intake.description).toBe("Takes in each new client email, finds its client and matter, and researches it.");
  expect(JSON.stringify(intake)).toContain("law-firm");
  expect(drafting.consults).toEqual([{ agentId: intake.id, ask: false, inactive: null }]);
  expect(JSON.stringify(drafting)).toContain("tool_gmail");
  expect(upkeep.dataTables).toEqual([matters]);
  // Copies: no link to the plugin, so its updates never rewrite them; listed as what it made.
  const rows = await ctx.db.select({ pluginId: agentsTable.pluginId }).from(agentsTable);
  expect(rows.every((r) => r.pluginId === null)).toBe(true);
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
