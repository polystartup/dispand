import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import * as schema from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { startFakeMcp } from "../tools/test-server.ts";
import { moveNative } from "./native.ts";
import { installReviewed, lawFirm, lawFirmMarket } from "./test-support.ts";

const AGENTS = ["Intake and research", "Drafting", "Matter upkeep"];
const DRAFTING = "com.dispand/agents/drafting.md";
const UPKEEP = "com.dispand/agents/matter-upkeep.md";
const CHANGED = "com.dispand/triggers/matter-changed.json";
const INTAKE = "com.dispand/agents/intake-and-research.md";
const RESEARCH_TABLE = "com.dispand/primitives/research.json";

/** The law-firm plugin installed and set up, with the way to publish a new version of some of its files. */
async function setUp() {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  // An action its server calls read-only: one a setup may start on Run.
  const server = await startFakeMcp([{ name: "lookup", description: "Finds case law", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, call: () => ({ content: [] }) }]);
  const fx = lawFirmMarket(server.url);
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const { pluginId } = await installReviewed(ctx, { marketplaceId: market.id, entryName: "law-firm", skills: ["legal-research"] });
  const harness = await call(router.harnesses.create, { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5", systemPrompt: "" }, { context: ctx });
  const pick = { primitives: ["Clients", "Matters", "Research"], agents: AGENTS.map((name) => ({ name, harnessId: harness.id })), triggers: ["Matter changed", "Research recorded"] };
  const { reviewed } = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
  await call(router.plugins.setUp, { id: pluginId, pick, reviewed }, { context: ctx });
  const files = lawFirm();
  const agent = async (name: string) => {
    const [row] = await ctx.db.select().from(schema.agents).where(eq(schema.agents.pluginComponent, name));
    return call(router.agents.get, { id: row!.id }, { context: ctx });
  };
  const preview = () => call(router.plugins.updatePreview, { id: pluginId }, { context: ctx });
  return { ctx, pluginId, harness, files, agent, preview, publish: (changed: Record<string, string>, removed: string[] = []) => fx.plugin.commit(changed, removed), remove: () => { fx.remove(); void server.close(); } };
}

const edited = (file: string, from: string, to: string) => {
  if (!file.includes(from)) throw new Error(`fixture changed: ${from}`);
  return file.replace(from, to);
};

test("an update with nothing to show applies at once; a reworded agent stops on the screen and applies only once confirmed", async () => {
  const { ctx, pluginId, files, agent, preview, publish, remove } = await setUp();
  try {
    // Nothing changed upstream: no entry, and it applies without a review.
    expect(await preview()).toMatchObject({ conflicts: [], changes: [] });
    await call(router.plugins.update, { id: pluginId }, { context: ctx });

    const sha = publish({ [DRAFTING]: edited(files[DRAFTING]!, "Draft the reply to the client from the research recorded, as a draft in the mailbox.", "Draft the reply, briefly.") });
    const shown = await preview();
    expect(shown.sha).toBe(sha);
    expect(shown.changes).toMatchObject([{ kind: "agent", name: "Drafting", field: "systemPrompt", class: "wording", after: "Draft the reply, briefly." }]);
    // Not confirmed: refused, and the agent is told what it was.
    await expect(call(router.plugins.update, { id: pluginId }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await agent("Drafting")).systemPrompt).toContain("as a draft in the mailbox");
    expect(await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed }, { context: ctx })).toEqual({ sha });
    expect(await agent("Drafting")).toMatchObject({ systemPrompt: "Draft the reply, briefly.", overridden: [] });
    expect((await preview()).changes).toEqual([]);
  } finally {
    remove();
  }
});

test("what an agent gains is listed as widening, what it only loses is silent, and each follows by id", async () => {
  const { ctx, pluginId, files, agent, preview, publish, remove } = await setUp();
  try {
    const [research] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Research"));
    const [caseLaw] = await ctx.db.select().from(schema.tools).where(eq(schema.tools.pluginComponent, "case-law"));
    publish({
      // Matter upkeep gains a table, a tool and the right to change tables; Drafting loses a table.
      [UPKEEP]: edited(edited(files[UPKEEP]!, "bundles: [data]", "bundles: [data, configure]\ntools: [case-law]"), "tables: [Matters]", "tables: [Matters, Research]"),
      [DRAFTING]: edited(files[DRAFTING]!, "tables: [Matters, Research]", "tables: [Matters]"),
      [CHANGED]: edited(files[CHANGED]!, '"operations": ["updated"]', '"operations": ["updated", "created"]'),
    });
    const shown = await preview();
    expect(shown.changes.filter((c) => c.class === "widening").map((c) => `${c.name}.${c.field}`).sort()).toEqual(["Matter changed.config", "Matter upkeep.bundles", "Matter upkeep.dataTables", "Matter upkeep.toolIds"]);
    expect(shown.changes.filter((c) => c.class === "silent").map((c) => `${c.name}.${c.field}`)).toEqual(["Drafting.dataTables"]);
    // The ids the screen shows read by name.
    expect(shown.names).toMatchObject({ [caseLaw!.id]: "case-law", [research!.id]: "Research" });
    await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed }, { context: ctx });
    const upkeep = await agent("Matter upkeep");
    expect(upkeep).toMatchObject({ bundles: ["data", "configure"], overridden: [] });
    expect(upkeep.dataTables).toContain(research!.id);
    expect(upkeep.tools.map((t) => t.toolId)).toEqual([caseLaw!.id]);
    // The screen showed the tool gained, not which of its actions would run unasked: none does, though its server calls one read-only.
    const asks = await ctx.db.select().from(schema.agentTools).where(eq(schema.agentTools.toolId, caseLaw!.id));
    expect(asks.find((a) => a.agentId === upkeep.id)!.unasked).toEqual([]);
    expect((await agent("Drafting")).dataTables).not.toContain(research!.id);
    const [trigger] = await ctx.db.select().from(schema.triggers).where(eq(schema.triggers.pluginComponent, "Matter changed"));
    expect(trigger).toMatchObject({ config: { operations: ["updated", "created"] }, overridden: [] });
  } finally {
    remove();
  }
});

test("an override stays through two updates, each shown as a conflict; taking the plugin's gives its latest value", async () => {
  const { ctx, pluginId, files, agent, preview, publish, remove } = await setUp();
  try {
    const drafting = await agent("Drafting");
    await call(router.agents.update, { id: drafting.id, name: drafting.name, harnessId: drafting.harnessId, systemPrompt: "Mine.", skillPackageIds: drafting.skills.map((s) => s.packageId), toolIds: drafting.tools.filter((t) => t.explicit).map((t) => t.toolId) }, { context: ctx });
    const was = "Draft the reply to the client from the research recorded, as a draft in the mailbox.";
    publish({ [DRAFTING]: edited(files[DRAFTING]!, was, "Second.") });
    const first = await preview();
    expect(first.conflicts).toMatchObject([{ kind: "agent", name: "Drafting", field: "systemPrompt", old: expect.stringContaining("as a draft"), mine: "Mine.", next: "Second." }]);
    expect(first.changes).toEqual([]);
    // Keep mine, the default: the owner's text stays, the plugin's new one is kept underneath.
    await call(router.plugins.update, { id: pluginId, reviewed: first.reviewed }, { context: ctx });
    expect(await agent("Drafting")).toMatchObject({ systemPrompt: "Mine.", overridden: ["systemPrompt"] });
    expect((await preview()).conflicts).toEqual([]);

    publish({ [DRAFTING]: edited(files[DRAFTING]!, was, "Third.") });
    const second = await preview();
    expect(second.conflicts).toMatchObject([{ old: "Second.", mine: "Mine.", next: "Third." }]);
    // A choice for a field that isn't in conflict is refused.
    await expect(call(router.plugins.update, { id: pluginId, reviewed: second.reviewed, take: ["agent:nope:systemPrompt"] }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await call(router.plugins.update, { id: pluginId, reviewed: second.reviewed, take: [second.conflicts[0]!.key] }, { context: ctx });
    expect(await agent("Drafting")).toMatchObject({ systemPrompt: "Third.", overridden: [] });
  } finally {
    remove();
  }
});

test("an update applies only what was shown: a version published after the screen is refused, and nothing of it is applied", async () => {
  const { ctx, pluginId, files, agent, preview, publish, remove } = await setUp();
  try {
    publish({ [DRAFTING]: edited(files[DRAFTING]!, "as a draft in the mailbox.", "as a draft.") });
    const shown = await preview();
    // A widening change the owner never saw arrives before they confirm.
    publish({ [UPKEEP]: edited(files[UPKEEP]!, "bundles: [data]", "bundles: [data, configure]") });
    await expect(call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await agent("Matter upkeep")).bundles).toEqual(["data"]);
    expect((await agent("Drafting")).systemPrompt).toContain("as a draft in the mailbox");
  } finally {
    remove();
  }
});

test("a change an element's own checks refuse is reported and offered again by the next update", async () => {
  const { ctx, pluginId, files, agent, preview, publish, remove } = await setUp();
  try {
    // The trigger would watch a table its agent may not work on.
    publish({ [CHANGED]: edited(files[CHANGED]!, '"table": "Matters"', '"table": "Clients"') });
    const shown = await preview();
    expect(shown.changes).toMatchObject([{ kind: "trigger", name: "Matter changed", field: "config", class: "widening" }]);
    const result = await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed }, { context: ctx });
    expect(result.failed).toMatchObject([{ name: "Matter changed" }]);
    const [matters] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Matters"));
    const [clients] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Clients"));
    const [trigger] = await ctx.db.select().from(schema.triggers).where(eq(schema.triggers.pluginComponent, "Matter changed"));
    expect(trigger).toMatchObject({ config: { tableId: matters!.id }, overridden: [] });

    // The owner lets the agent work on that table: the same change is shown again, and applies.
    const upkeep = await agent("Matter upkeep");
    await call(router.agents.update, { id: upkeep.id, name: upkeep.name, harnessId: upkeep.harnessId, systemPrompt: upkeep.systemPrompt, skillPackageIds: [], toolIds: [], dataTables: [matters!.id, clients!.id] }, { context: ctx });
    const again = await preview();
    expect(again.changes).toMatchObject([{ kind: "trigger", field: "config" }]);
    expect((await call(router.plugins.update, { id: pluginId, reviewed: again.reviewed }, { context: ctx })).failed).toBeUndefined();
    expect((await ctx.db.select().from(schema.triggers).where(eq(schema.triggers.id, trigger!.id)))[0]).toMatchObject({ config: { tableId: clients!.id }, overridden: [] });
  } finally {
    remove();
  }
});

const NEW_AGENT = `---
name: Billing
description: Prepares each matter's invoice.
harness: cloud
bundles: [data]
tables: [Matters, Invoices]
---

Prepare the invoice of each matter.
`;
const NEW_TABLE = JSON.stringify({ name: "Invoices", primitive: true, fields: [{ name: "Amount", type: "number" }] });
const NEW_TRIGGER = JSON.stringify({ agent: "Billing", name: "Invoice due", instructions: "Prepare it.", config: { kind: "schedule", cron: "0 9 * * 1", timezone: "UTC" } });

test("what a new version adds is named on the update's screen, made by none of it, and set up afterwards with its grants shown", async () => {
  const { ctx, pluginId, harness, preview, publish, remove } = await setUp();
  try {
    publish({ "com.dispand/agents/billing.md": NEW_AGENT, "com.dispand/primitives/invoices.json": NEW_TABLE, "com.dispand/triggers/invoice-due.json": NEW_TRIGGER });
    const shown = await preview();
    expect(shown.additions.map((a) => a.key).sort()).toEqual(["agent:Billing", "primitive:Invoices", "trigger:Invoice due"]);
    expect(shown.additions.find((a) => a.kind === "agent")).toMatchObject({ name: "Billing", detail: "Prepares each matter's invoice." });
    // What it names is what the owner saw: without the screen's token, nothing is applied.
    await expect(call(router.plugins.update, { id: pluginId }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    // The update makes nothing new: it has no way to be told to.
    await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed }, { context: ctx });
    expect(await ctx.db.select().from(schema.agents).where(eq(schema.agents.pluginComponent, "Billing"))).toEqual([]);
    expect((await preview()).additions).toEqual([]);

    // From the plugin's Set up: the items say what the agent may do, and are what is made.
    const pick = { primitives: ["Invoices"], agents: [{ name: "Billing", harnessId: harness.id }], triggers: ["Invoice due"] };
    const setup = await call(router.plugins.setupPreview, { id: pluginId, pick }, { context: ctx });
    expect(setup.items.find((i) => i.tool === "agents_create")).toMatchObject({ input: { name: "Billing", bundles: ["data"], systemPrompt: expect.stringContaining("Prepare the invoice") } });
    const { outcomes } = await call(router.plugins.setUp, { id: pluginId, pick, reviewed: setup.reviewed }, { context: ctx });
    expect(outcomes.filter((o) => o.outcome !== "made")).toEqual([]);
    const [billing] = await ctx.db.select().from(schema.agents).where(eq(schema.agents.pluginComponent, "Billing"));
    expect(billing).toMatchObject({ pluginId, harnessId: harness.id });
    expect(await ctx.db.select().from(schema.triggers).where(eq(schema.triggers.pluginComponent, "Invoice due"))).toMatchObject([{ agentId: billing!.id, pluginId }]);
  } finally {
    remove();
  }
});

test("what a new version drops goes with the update when nothing uses it, and is asked about when the owner has something to lose", async () => {
  const { ctx, pluginId, harness, agent, preview, publish, remove } = await setUp();
  try {
    // Research holds a row; Matter upkeep is untouched; its trigger goes with it.
    const [research] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Research"));
    await call(router.rows.create, { tableId: research!.id, values: {} } as never, { context: ctx });
    const upkeep = await agent("Matter upkeep");
    // The new version has neither the Research table, nor Matter upkeep and its trigger, and Drafting no longer names Research.
    publish(
      {
        [DRAFTING]: edited(lawFirm()[DRAFTING]!, "tables: [Matters, Research]", "tables: [Matters]"),
        [INTAKE]: edited(lawFirm()[INTAKE]!, "tables: [Clients, Matters, Research]", "tables: [Clients, Matters]"),
      },
      [RESEARCH_TABLE, UPKEEP, CHANGED, "com.dispand/triggers/research-recorded.json"],
    );
    const shown = await preview();
    expect(shown.removals.map((r) => [r.kind, r.name, r.reasons]).sort()).toEqual([
      ["agent", "Matter upkeep", []],
      ["table", "Research", ["It has 1 row"]],
      ["trigger", "Research recorded", []],
    ]);
    // The table has a row: without a choice for it, nothing is applied.
    await expect(call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await ctx.db.select().from(schema.agents).where(eq(schema.agents.id, upkeep.id))).toHaveLength(1);
    const table = shown.removals.find((r) => r.kind === "table")!;
    await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed, choices: { [table.key]: "keep" } }, { context: ctx });
    // Kept, the table is the owner's own; the agent nothing used is gone with its trigger, and so is the dropped trigger of an agent that stays.
    expect((await ctx.db.select().from(schema.tables).where(eq(schema.tables.id, research!.id)))[0]).toMatchObject({ pluginId: null, name: "Research" });
    expect(await ctx.db.select().from(schema.agents).where(eq(schema.agents.id, upkeep.id))).toEqual([]);
    expect((await ctx.db.select({ name: schema.triggers.name }).from(schema.triggers)).map((t) => t.name)).toEqual([]);
    expect((await preview()).removals).toEqual([]);
    void harness;
  } finally {
    remove();
  }
});

test("a trigger a new version drops while its agent stays is asked about when the owner changed it, and kept, becomes theirs", async () => {
  const { ctx, pluginId, preview, publish, remove } = await setUp();
  try {
    const [trigger] = await ctx.db.select().from(schema.triggers).where(eq(schema.triggers.pluginComponent, "Matter changed"));
    await call(router.triggers.update, { id: trigger!.id, instructions: "Mine." }, { context: ctx });
    publish({}, [CHANGED]);
    const shown = await preview();
    expect(shown.removals).toMatchObject([{ kind: "trigger", name: "Matter changed", reasons: ["You changed it"] }]);
    await expect(call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed, choices: { [shown.removals[0]!.key]: "keep" } }, { context: ctx });
    expect((await ctx.db.select().from(schema.triggers).where(eq(schema.triggers.id, trigger!.id)))[0]).toMatchObject({ pluginId: null, instructions: "Mine.", overridden: [] });
    expect(await call(router.triggers.get, { id: trigger!.id }, { context: ctx })).toMatchObject({ plugin: null });
    // No longer the plugin's: its setup record forgets it, so a definition of that name could be set up again.
    const [plugin] = await ctx.db.select({ created: schema.plugins.created }).from(schema.plugins).where(eq(schema.plugins.id, pluginId));
    expect(JSON.stringify(plugin!.created)).not.toContain(trigger!.id);
  } finally {
    remove();
  }
});

test("the update's screen gives the new version's changelog section when it has one, and the two commits either way", async () => {
  const { files, preview, publish, remove } = await setUp();
  try {
    const before = await preview();
    expect(before.releaseNotes).toMatchObject({ version: "1.0.0", text: null });
    const sha = publish({
      "plugin.json": files["plugin.json"]!.replace('"version": "1.0.0"', '"version": "1.1.0"'),
      "CHANGELOG.md": "# Changelog\n\n## 1.1.0\n\n- Drafting writes shorter replies.\n\n## 1.0.0\n\n- First.\n",
    });
    expect((await preview()).releaseNotes).toEqual({ from: before.sha, to: sha, version: "1.1.0", text: "## 1.1.0\n\n- Drafting writes shorter replies." });
  } finally {
    remove();
  }
});

const MATTERS = "com.dispand/primitives/matters.json";

test("a table's changes are listed with their ticks, only the ticked ones apply, and a declined one isn't offered again", async () => {
  const { ctx, pluginId, files, preview, publish, remove } = await setUp();
  try {
    const [matters] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Matters"));
    const definition = JSON.parse(files[MATTERS]!) as { fields: { name: string; type: string }[] };
    definition.fields = [...definition.fields.filter((f) => f.name !== "Conclusions"), { name: "Fee", type: "number" }];
    publish({ [MATTERS]: JSON.stringify(definition) });
    const shown = await preview();
    expect(shown.tables).toEqual([
      {
        tableId: matters!.id,
        name: "Matters",
        changes: [
          { key: "add:Fee", kind: "add", field: "Fee", ticked: true },
          { key: "remove:Conclusions", kind: "remove", field: "Conclusions", ticked: false },
        ],
      },
    ]);
    // A table change needs the screen's token.
    await expect(call(router.plugins.update, { id: pluginId }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    // A key that isn't one of the table's changes is refused.
    await expect(call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed, tables: { [matters!.id]: ["remove:Clients"] } }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed, tables: { [matters!.id]: ["add:Fee"] } }, { context: ctx });
    const fields = await ctx.db.select().from(schema.fields).where(eq(schema.fields.tableId, matters!.id));
    expect(fields.map((f) => [f.name, f.pluginField]).sort()).toEqual([["Clients", "Clients"], ["Conclusions", "Conclusions"], ["Fee", "Fee"], ["Name", null]]);
    // The removal was declined: the table keeps the field, and the next update doesn't ask again.
    expect((await preview()).tables).toEqual([]);
  } finally {
    remove();
  }
});

test("a parent naming a field the owner didn't add is refused and offered again: the table keeps its parent", async () => {
  const { ctx, pluginId, files, preview, publish, remove } = await setUp();
  try {
    const [matters] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Matters"));
    const definition = JSON.parse(files[MATTERS]!) as { fields: { name: string; type: string; references?: string }[]; parent: { field: string; required: boolean } };
    const before = definition.parent.field;
    const referencing = definition.fields.find((f) => f.name === before)!;
    definition.fields.push({ ...referencing, name: "Client" });
    definition.parent = { ...definition.parent, field: "Client" };
    publish({ [MATTERS]: JSON.stringify(definition) });
    const shown = await preview();
    const result = await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed, tables: { [matters!.id]: ["parent"] } }, { context: ctx });
    expect(result.failed).toMatchObject([{ name: "Matters" }]);
    const [table] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.id, matters!.id));
    const [parentField] = await ctx.db.select().from(schema.fields).where(eq(schema.fields.id, table!.parentFieldId!));
    expect(parentField!.pluginField).toBe(before);
    expect((await preview()).tables[0]!.changes.map((c) => c.key)).toEqual(["add:Client", "parent"]);
  } finally {
    remove();
  }
});

test("a table change that fails is reported and offered again; a field an update adds is recorded like a setup's", async () => {
  const { ctx, pluginId, files, preview, publish, remove } = await setUp();
  try {
    const [matters] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Matters"));
    const definition = JSON.parse(files[MATTERS]!) as { fields: { name: string; type: string }[]; parent: { field: string; required: boolean } };
    // Every row must name its client now; this one names none, so the change is refused.
    await call(router.rows.create, { tableId: matters!.id, values: {} } as never, { context: ctx });
    definition.parent = { ...definition.parent, required: true };
    definition.fields.push({ name: "Fee", type: "number" });
    publish({ [MATTERS]: JSON.stringify(definition) });
    const shown = await preview();
    const result = await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed, tables: { [matters!.id]: ["add:Fee", "parent"] } }, { context: ctx });
    expect(result.failed).toMatchObject([{ name: "Matters" }]);
    // The parent change is still offered; the field added isn't, and is the plugin's on record.
    expect((await preview()).tables).toMatchObject([{ tableId: matters!.id, changes: [{ key: "parent" }] }]);
    const [fee] = await ctx.db.select().from(schema.fields).where(eq(schema.fields.name, "Fee"));
    const [plugin] = await ctx.db.select({ created: schema.plugins.created }).from(schema.plugins).where(eq(schema.plugins.id, pluginId));
    expect(plugin!.created.from).toMatchObject({ "field:Matters.Fee": fee!.id });
    expect(plugin!.created.field).toContain(fee!.id);
  } finally {
    remove();
  }
});

/** A runner whose native inventory holds the plugin on Claude Code, answering each native operation and recording it. */
async function nativeRunner(ctx: Awaited<ReturnType<typeof setUp>>["ctx"], pluginId: string, fail?: "add", enabled = true) {
  const { runnerId } = await call(router.runners.create, { name: "Desk" }, { context: ctx });
  await ctx.db.insert(schema.harnesses).values({ id: "h_native", ownerId: ctx.ownerId, name: "Claude Code", runnerId, kind: "claude-code", permissionMode: "default" });
  const operations: string[] = [];
  let installed = true;
  vi.spyOn(ctx.hub, "isOnline").mockImplementation((id) => id === runnerId);
  vi.spyOn(ctx.hub, "plugins").mockImplementation(async (_runner, msg) => {
    const op = msg.operation;
    const report = (r: object) => ({ type: "plugin.replied" as const, requestId: msg.requestId, report: r });
    if (op.action === "list") return report({ packages: installed ? [{ name: `dispand-${pluginId}`, harness: "claude-code", installed: true, enabled, pending: false }] : [] });
    if (op.action !== "add" && op.action !== "remove") throw new Error("unexpected native operation");
    operations.push(`${op.action}${op.dryRun ? " preview" : ""}`);
    if (op.dryRun) return report({ revision: "rev", blocked: false, changes: [] });
    if (op.action === "add" && fail === "add") return report({ error: "The native account refused it" });
    installed = op.action === "add";
    return report({ results: [{ name: op.name, harness: "claude-code", status: op.action === "add" ? "installed" : "removed" }] });
  });
  return operations;
}

test("an update names the harnesses holding the plugin natively and moves each install to the new commit", async () => {
  const { ctx, pluginId, files, preview, publish, remove } = await setUp();
  try {
    const operations = await nativeRunner(ctx, pluginId);
    publish({ [DRAFTING]: edited(files[DRAFTING]!, "Draft", "Write") });
    const shown = await preview();
    expect(shown.native).toEqual({ harnesses: [{ id: "h_native", name: "Claude Code" }], unchecked: [] });
    // Native installs need an https source: this one, as the update writes it, gets one.
    await ctx.db.update(schema.plugins).set({ url: "https://example.com/law-firm.git", sha: "a".repeat(40), entryName: "law-firm", nativeRoot: "." }).where(eq(schema.plugins.id, pluginId));
    // Only what the screen showed moves.
    expect(await moveNative(ctx, pluginId, [])).toMatchObject([{ name: "Claude Code", reason: "it wasn't on the update's screen" }]);
    expect(operations).toEqual([]);
    expect(await moveNative(ctx, pluginId, ["h_native"])).toEqual([]);
    expect(operations).toEqual(["remove preview", "remove", "add preview", "add"]);
  } finally {
    remove();
  }
});

test("an offline runner is named as unchecked; a native step that fails leaves the plugin updated and its harness listed", async () => {
  const { ctx, pluginId, files, preview, publish, remove } = await setUp();
  try {
    const operations = await nativeRunner(ctx, pluginId);
    const { runnerId: offline } = await call(router.runners.create, { name: "Laptop" }, { context: ctx });
    await ctx.db.insert(schema.harnesses).values({ id: "h_offline", ownerId: ctx.ownerId, name: "Codex", runnerId: offline, kind: "codex", permissionMode: "default" });
    publish({ [DRAFTING]: edited(files[DRAFTING]!, "Draft", "Write") });
    const shown = await preview();
    expect(shown.native.unchecked).toEqual(["Laptop"]);
    // Moving a native install needs the screen's token, whatever else the update holds.
    await expect(call(router.plugins.update, { id: pluginId, native: ["h_native"] }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    // The fixture's source is a local folder, which can't be installed natively: the add is refused.
    const result = await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed, native: ["h_native"] }, { context: ctx });
    expect(result.sha).toBe(shown.sha);
    expect(result.leftBehind).toMatchObject([{ name: "Claude Code" }]);
    expect(operations.at(-1)).toBe("remove");
    const [plugin] = await ctx.db.select({ sha: schema.plugins.sha }).from(schema.plugins).where(eq(schema.plugins.id, pluginId));
    expect(plugin!.sha).toBe(shown.sha);
  } finally {
    remove();
  }
});

test("a native install its owner disabled isn't moved: it is named as staying, and stays disabled", async () => {
  const { ctx, pluginId, preview, publish, files, remove } = await setUp();
  try {
    const operations = await nativeRunner(ctx, pluginId, undefined, false);
    publish({ [DRAFTING]: edited(files[DRAFTING]!, "Draft", "Write") });
    const shown = await preview();
    expect(shown.native).toEqual({ harnesses: [], unchecked: ["Claude Code (disabled or changing there)"] });
    await call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed, native: ["h_native"] }, { context: ctx });
    expect(operations).toEqual([]);
  } finally {
    remove();
  }
});

test("a skill's file the plugin rewords names, on the update's screen, every agent its text reaches", async () => {
  const { pluginId, files, preview, publish, remove } = await setUp();
  try {
    const SKILL = "skills/legal-research/SKILL.md";
    publish({ [SKILL]: `${files[SKILL]!}\nCite the court and the year.\n` });
    const shown = await preview();
    expect(shown.changes).toContainEqual(expect.objectContaining({ kind: "skill", field: "file:legal-research/SKILL.md", class: "wording", reaches: ["Intake and research"] }));
    expect(pluginId).toBeDefined();
  } finally {
    remove();
  }
});

test("a skill an agent gains with a new version is on the update's screen whole: its files, under the screen's token", async () => {
  const { files, preview, publish, remove } = await setUp();
  try {
    // The same release rewords the skill: what the agent gets is the new text.
    const SKILL = "skills/legal-research/SKILL.md";
    publish({ [DRAFTING]: edited(files[DRAFTING]!, "tools: [\"catalog:gmail\"]", "tools: [\"catalog:gmail\"]\nskills: [legal-research]"), [SKILL]: `${files[SKILL]!}\nCite the court and the year.\n` });
    const shown = await preview();
    const change = shown.changes.find((c) => c.name === "Drafting" && c.field === "skillPackageIds") as { class: string; gained?: { name: string; files: { path: string; text: string | null }[] }[] } | undefined;
    expect(change?.class).toBe("widening");
    expect(change!.gained![0]!.files.map((f) => f.path)).toContain("legal-research/SKILL.md");
    expect(change!.gained![0]!.files.find((f) => f.path === "legal-research/SKILL.md")!.text).toContain("Cite the court and the year.");
  } finally {
    remove();
  }
});

test("a value written to a field after the update's screen was read refuses its removal: the screen is shown again", async () => {
  const { ctx, pluginId, files, preview, publish, remove } = await setUp();
  try {
    const [matters] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Matters"));
    const conclusions = (await ctx.db.select().from(schema.fields).where(eq(schema.fields.tableId, matters!.id))).find((f) => f.name === "Conclusions")!;
    const row = await call(router.rows.create, { tableId: matters!.id, values: { [conclusions.id]: "Settled." } } as never, { context: ctx });
    const definition = JSON.parse(files[MATTERS]!) as { fields: { name: string }[] };
    definition.fields = definition.fields.filter((f) => f.name !== "Conclusions");
    publish({ [MATTERS]: JSON.stringify(definition) });
    const shown = await preview();
    expect(shown.tables[0]!.changes).toMatchObject([{ key: "remove:Conclusions", loses: 1 }]);
    // A Job writes to that field meanwhile: the screen counted what was there, not this.
    await call(router.rows.update, { id: (row as { id: string }).id, values: { [conclusions.id]: "Settled, then appealed." } } as never, { context: ctx });
    await expect(call(router.plugins.update, { id: pluginId, reviewed: shown.reviewed, tables: { [matters!.id]: ["remove:Conclusions"] } }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await ctx.db.select().from(schema.fields).where(eq(schema.fields.id, conclusions.id))).length).toBe(1);
    // Read again, it applies.
    const again = await preview();
    await call(router.plugins.update, { id: pluginId, reviewed: again.reviewed, tables: { [matters!.id]: ["remove:Conclusions"] } }, { context: ctx });
    expect(await ctx.db.select().from(schema.fields).where(eq(schema.fields.id, conclusions.id))).toEqual([]);
  } finally {
    remove();
  }
});

test("a field removal names, on the update's screen, the workflows whose data step uses the field", async () => {
  const { ctx, files, agent, preview, publish, remove } = await setUp();
  try {
    const [matters] = await ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Matters"));
    const conclusions = (await ctx.db.select().from(schema.fields).where(eq(schema.fields.tableId, matters!.id))).find((f) => f.name === "Conclusions")!;
    const drafting = await agent("Drafting");
    const workflow = await call(router.workflows.create, { name: "Close matter" }, { context: ctx });
    const def = {
      trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId: drafting.id, prompt: "Ask what was decided." } },
      steps: [{ id: "n_data", key: "record", type: "data", name: "Record", action: "create-row", tableId: matters!.id, inputs: [{ fieldId: conclusions.id, source: { type: "output", nodeId: "n_chat", name: "decision" } }] }],
      edges: [{ from: "n_chat", to: "n_data" }],
    };
    await call(router.workflows.update, { id: workflow.id, name: "Close matter", def } as never, { context: ctx });
    const definition = JSON.parse(files[MATTERS]!) as { fields: { name: string }[] };
    definition.fields = definition.fields.filter((f) => f.name !== "Conclusions");
    publish({ [MATTERS]: JSON.stringify(definition) });
    expect((await preview()).tables[0]!.changes).toMatchObject([{ key: "remove:Conclusions", stops: ["Close matter"] }]);
  } finally {
    remove();
  }
});
