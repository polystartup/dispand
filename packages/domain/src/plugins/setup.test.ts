import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { plugins as pluginsTable } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { fixtureRepo, lawFirmMarket } from "./test-support.ts";

const ALL = { primitives: ["Clients", "Matters", "Research"] };

/** The owner's context with the law-firm plugin installed (definitions only). */
async function installed() {
  const ctx = { ...(await ownerContext()), gitFileUrls: true };
  const fx = lawFirmMarket();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { marketplaceId: market.id, entryName: "law-firm" }, { context: ctx });
  return { ctx, pluginId, remove: fx.remove };
}

type Ctx = Awaited<ReturnType<typeof installed>>["ctx"];

const setUp = (ctx: Ctx, id: string, pick = ALL) => call(router.plugins.setUp, { id, pick }, { context: ctx });
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
