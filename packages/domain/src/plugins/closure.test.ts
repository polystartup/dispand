import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import * as schema from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { startFakeMcp } from "../tools/test-server.ts";
import { checkChoices, inUse, REFERENCES, type Element } from "./closure.ts";
import { lawFirmMarket, installReviewed } from "./test-support.ts";

const ELEMENT_TABLES = ["agents", "tools", "skill_packages", "tables", "fields", "triggers"];

test("every foreign key to an element's table is one the uninstall knows what to do about", () => {
  // A reference added later must be classed here, or an uninstall could delete under it unseen.
  const found: Record<string, string> = {};
  for (const table of Object.values(schema)) {
    if (!(table instanceof PgTable)) continue;
    const config = getTableConfig(table);
    for (const fk of config.foreignKeys) {
      const to = getTableConfig(fk.reference().foreignTable).name;
      if (ELEMENT_TABLES.includes(to)) found[`${config.name}.${fk.reference().columns.map((c) => c.name).join(",")}`] = fk.onDelete ?? "no action";
    }
  }
  expect(Object.keys(found).sort()).toEqual(Object.keys(REFERENCES).sort());
  // What a deletion would take with it is the element's own part, its history, content rule 2 counts, or something rule 3 asks about.
  for (const [key, onDelete] of Object.entries(found)) if (onDelete === "cascade") expect(["part", "history", "content", "needs"], key).toContain(REFERENCES[key]);
  // Content is never cascaded away unasked: each such reference is a reason of rule 2.
  expect(Object.entries(REFERENCES).filter(([, kind]) => kind === "content").map(([key]) => key).sort()).toEqual(["attachments.table_id", "memories.agent_id", "memories.table_id", "rows.table_id"]);
});

const AGENTS = ["Intake and research", "Drafting", "Matter upkeep"];

/** The law-firm plugin installed and all set up on a cloud harness, with its case-law server as a tool. */
async function setUp() {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  const server = await startFakeMcp([{ name: "lookup", description: "Finds case law", inputSchema: { type: "object" }, call: () => ({ content: [] }) }]);
  const fx = lawFirmMarket(server.url);
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const { pluginId } = await installReviewed(ctx, { marketplaceId: market.id, entryName: "law-firm", skills: ["legal-research"] });
  const harness = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context: ctx });
  const pick = { primitives: ["Clients", "Matters", "Research"], agents: AGENTS.map((name) => ({ name, harnessId: harness.id })), triggers: ["Matter changed", "Research recorded"] };
  const { reviewed } = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  const { outcomes } = await call(router.plugins.setUp, { id: pluginId, pick, reviewed }, { context: ctx });
  expect(outcomes.filter((o) => o.outcome !== "made")).toEqual([]);
  const elements = () => inUse(ctx.db, ctx.ownerId, pluginId);
  const named = async (name: string) => (await elements()).find((e) => e.name === name)!;
  const uninstall = async (choices: Record<string, "keep" | "delete"> = {}) => {
    const preview = await call(router.plugins.uninstallPreview, { id: pluginId }, { context: ctx });
    return call(router.plugins.uninstall, { id: pluginId, reviewed: preview.reviewed, choices }, { context: ctx });
  };
  return { ctx, pluginId, harness, elements, named, uninstall, remove: () => { fx.remove(); void server.close(); } };
}

test("nothing of the plugin's is asked about when its owner changed nothing and nothing of theirs uses it, and it all goes", async () => {
  const { ctx, elements, uninstall, remove } = await setUp();
  try {
    const all = await elements();
    expect(all.map((e) => e.kind).sort()).toEqual(["agent", "agent", "agent", "skill", "table", "table", "table", "tool"]);
    expect(all.filter((e) => e.reasons.length)).toEqual([]);
    await uninstall();
    expect(await ctx.db.select({ id: schema.plugins.id }).from(schema.plugins).where(eq(schema.plugins.source, "marketplace"))).toEqual([]);
    for (const table of [schema.agents, schema.tables, schema.triggers, schema.skillPackages] as const) {
      const left = await ctx.db.select().from(table);
      expect(left.filter((row) => !("builtIn" in row && row.builtIn)).map((row) => row.name)).toEqual([]);
    }
    // The catalog's Gmail is the owner's own: it stays.
    expect((await ctx.db.select({ name: schema.tools.name, catalogId: schema.tools.catalogId }).from(schema.tools)).map((t) => t.catalogId)).toEqual(["gmail"]);
  } finally {
    remove();
  }
});

test("each kind of change the owner made is a reason to ask", async () => {
  const { ctx, named, remove } = await setUp();
  try {
    const drafting = await named("Drafting");
    const agent = await call(router.agents.get, { id: drafting.id }, { context: ctx });
    await call(router.agents.update, { id: agent.id, name: agent.name, harnessId: agent.harnessId, systemPrompt: "Mine.", skillPackageIds: agent.skills.map((s) => s.packageId), toolIds: agent.tools.filter((t) => t.explicit).map((t) => t.toolId) }, { context: ctx });
    expect((await named("Drafting")).reasons).toEqual(["You changed it"]);

    // A change of one of its triggers counts for the agent, which the trigger goes with.
    const [trigger] = await ctx.db.select().from(schema.triggers).where(eq(schema.triggers.name, "Matter changed"));
    await call(router.triggers.update, { id: trigger!.id, instructions: "Mine." }, { context: ctx });
    expect((await named("Matter upkeep")).reasons).toEqual(["You changed its trigger “Matter changed”"]);

    const skill = (await named("law-firm"));
    expect(skill.kind).toBe("skill");
    await call(router.skills.setFile, { packageId: skill.id, path: "legal-research/notes.md", base64: Buffer.from("Mine.").toString("base64") }, { context: ctx });
    expect((await named("law-firm")).reasons).toEqual(["You changed its files"]);

    const tool = await named("case-law");
    await call(router.tools.update, { id: tool.id, name: "Case law" }, { context: ctx });
    expect((await named("Case law")).reasons).toEqual(["You changed it"]);

    // A table: a field of the owner's, rows, or memory.
    const clients = await named("Clients");
    await call(router.fields.create, { tableId: clients.id, name: "Phone", type: "text" }, { context: ctx });
    expect((await named("Clients")).reasons).toEqual(["You changed its fields"]);
    // A rename of the table itself, or of its first field, is a change too.
    await call(router.tables.rename, { id: clients.id, name: "Customers" }, { context: ctx });
    expect((await named("Customers")).reasons).toEqual(["You renamed it", "You changed its fields"]);
    const research = await named("Research");
    await ctx.db.insert(schema.memories).values({ id: "mem_1", ownerId: ctx.ownerId, scope: "table", tableId: research.id, path: "notes.md", name: "Notes", description: "", type: "reference", body: "x", author: { kind: "user" }, revision: 1 } as never);
    expect((await named("Research")).reasons).toEqual(["It has memory entries"]);
    const matters = await named("Matters");
    await call(router.rows.create, { tableId: matters.id, values: {} } as never, { context: ctx });
    expect((await named("Matters")).reasons[0]).toBe("It has 1 row");
  } finally {
    remove();
  }
});

test("what a kept agent needs is known from the start, a set that drops it unasked is refused, and force delete is allowed when stated", async () => {
  const { ctx, harness, named, uninstall, remove } = await setUp();
  try {
    // The owner's own agent consults Drafting, which consults Intake and research, which uses the skill, the case-law tool and the tables.
    const drafting = await named("Drafting");
    await call(router.agents.create, { name: "Mine", harnessId: harness.id, systemPrompt: "", skillPackageIds: [], toolIds: [], consults: [{ agentId: drafting.id, ask: true }] }, { context: ctx });
    expect((await named("Drafting")).reasons).toEqual(["The agent “Mine” may consult it"]);
    const intake = await named("Intake and research");
    expect((await named("Drafting")).needs).toContain(intake.key);
    const [skill, tool, clients] = [await named("law-firm"), await named("case-law"), await named("Clients")];
    expect(intake.needs).toEqual(expect.arrayContaining([skill.key, tool.key, clients.key]));
    expect(intake.reasons).toEqual([]);

    // Keeping Drafting without saying what becomes of what it needs is refused; nothing is removed.
    await expect(uninstall({ [drafting.key]: "keep" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await ctx.db.select({ id: schema.plugins.id }).from(schema.plugins).where(eq(schema.plugins.source, "marketplace"))).toHaveLength(1);

    // Kept with its consulted agent and what that one needs, the tool force deleted: said, so allowed.
    const all = await inUse(ctx.db, ctx.ownerId, (await ctx.db.select().from(schema.plugins).where(eq(schema.plugins.source, "marketplace")))[0]!.id);
    const closure = new Set<string>();
    const walk = (key: string) => { for (const n of all.find((e) => e.key === key)!.needs) if (!closure.has(n)) { closure.add(n); walk(n); } };
    walk(drafting.key);
    const choices: Record<string, "keep" | "delete"> = { [drafting.key]: "keep" };
    for (const key of closure) choices[key] = key === tool.key ? "delete" : "keep";
    await uninstall(choices);

    const kept = await call(router.agents.get, { id: intake.id }, { context: ctx });
    expect(kept).toMatchObject({ plugin: null, overridden: [] });
    expect(kept.tools.map((t) => t.name)).not.toContain("case-law");
    expect(kept.skills.map((s) => s.packageId)).toEqual([skill.id]);
    expect(await ctx.db.select().from(schema.tools).where(eq(schema.tools.id, tool.id))).toEqual([]);
    expect((await ctx.db.select().from(schema.tables).where(eq(schema.tables.id, clients.id)))[0]).toMatchObject({ pluginId: null, definition: null });
    // Matter upkeep was nobody's need: gone, with its trigger.
    expect((await ctx.db.select({ name: schema.agents.name }).from(schema.agents)).map((a) => a.name)).not.toContain("Matter upkeep");
    expect((await ctx.db.select({ name: schema.triggers.name }).from(schema.triggers)).map((t) => t.name)).toEqual(["Research recorded"]);
  } finally {
    remove();
  }
});

test("an uninstall applies only what was shown: a stale review is refused and nothing is removed", async () => {
  const { ctx, pluginId, named, remove } = await setUp();
  try {
    const preview = await call(router.plugins.uninstallPreview, { id: pluginId }, { context: ctx });
    const matters = await named("Matters");
    await call(router.rows.create, { tableId: matters.id, values: {} } as never, { context: ctx });
    await expect(call(router.plugins.uninstall, { id: pluginId, reviewed: preview.reviewed, choices: {} }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await ctx.db.select().from(schema.tables).where(eq(schema.tables.id, matters.id))).toHaveLength(1);
  } finally {
    remove();
  }
});

test("choices are checked as a whole", () => {
  const element = (key: string, more: Partial<Element> = {}): Element => ({ key, kind: "agent", id: key, name: key.split(":")[1]!, reasons: [], needs: [], keepOnly: null, ...more });
  const elements = [element("agent:a", { reasons: ["You changed it"], needs: ["tool:t"] }), element("tool:t", { kind: "tool" }), element("agent:w", { reasons: ["A workflow uses this agent"], keepOnly: "A workflow uses this agent" })];
  expect(checkChoices(elements, {})).toBe("Choose what becomes of a");
  expect(checkChoices(elements, { "agent:a": "keep", "agent:w": "keep" })).toBe("Choose what becomes of t, which a needs");
  expect(checkChoices(elements, { "agent:a": "keep", "tool:t": "delete", "agent:w": "delete" })).toBe("A workflow uses this agent");
  expect(checkChoices(elements, { "agent:a": "delete", "agent:w": "keep", "nope:x": "keep" })).toBe("Not an element of this plugin");
  expect(checkChoices(elements, { "agent:a": "delete", "agent:w": "keep" })).toBeNull();
  expect(checkChoices(elements, { "agent:a": "keep", "tool:t": "keep", "agent:w": "keep" })).toBeNull();
});

test("a table can't be deleted while a table that stays names its rows: the uninstall says which field, and removes nothing", async () => {
  const { ctx, pluginId, named, uninstall, remove } = await setUp();
  try {
    const clients = await named("Clients");
    const mine = await call(router.tables.create, { name: "Invoices" }, { context: ctx });
    await call(router.fields.create, { tableId: mine.id, name: "Client", type: "reference", referencesTableId: clients.id }, { context: ctx });
    expect(await named("Clients")).toMatchObject({ reasons: ["The field “Client” of your table “Invoices” names its rows"], keepOnly: "The field “Client” of your table “Invoices” names its rows: delete that field first to delete this table" });
    // Matters names Clients' rows too: kept without Clients, it would name a table that is gone.
    const matters = await named("Matters");
    expect(matters.needs).toContain(clients.key);
    await call(router.fields.delete, { id: (await call(router.tables.get, { id: mine.id }, { context: ctx })).fields.find((f) => f.name === "Client")!.id }, { context: ctx });
    await expect(uninstall({ [matters.key]: "keep", [clients.key]: "delete" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Matters names the rows of Clients: keep both, or delete both" });
    expect(await ctx.db.select({ id: schema.plugins.id }).from(schema.plugins).where(eq(schema.plugins.id, pluginId))).toHaveLength(1);
  } finally {
    remove();
  }
});
