import { ORPCError } from "@orpc/server";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { fields as fieldsTable, pages as pagesTable, tables as tablesTable, triggers, widgets as widgetsTable, workflows, workflowVersions } from "../db/schema.ts";
import { queryProblem } from "../data/query.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { StorableText } from "../text.ts";
import { GridConfig, TableConfig } from "./config.ts";
import { BREAKPOINTS, fits, GridPos, placeBelow, type Breakpoint } from "./layout.ts";

const owner = base.use(authed);

const Title = z.string().trim().min(1).max(100);

/** A widget as the client sees it: a workflow form, an agent trigger's form, or a Grid or Table widget with its table and fields. */
function toWidget(w: typeof widgetsTable.$inferSelect) {
  const { id, pageId, title, layout } = w;
  const base = { id, pageId, title, layout };
  if (w.type === "workflow-form") return { ...base, type: "workflow-form" as const, workflowId: w.workflowId! };
  if (w.type === "trigger-form") return { ...base, type: "trigger-form" as const, triggerId: w.triggerId! };
  if (w.type === "grid") return { ...base, type: "grid" as const, tableId: w.tableId!, config: w.config as GridConfig };
  return { ...base, type: "table" as const, tableId: w.tableId!, config: w.config as TableConfig };
}

async function requirePage(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(pagesTable)
    .where(and(eq(pagesTable.id, id), eq(pagesTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

async function requireWidget(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(widgetsTable)
    .where(and(eq(widgetsTable.id, id), eq(widgetsTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

/** The most pages an owner makes, Home aside. */
export const MAX_PAGES = 50;

const PageTitle = StorableText(100).trim().min(1);

/** The owner's Home, created on the first call (one per owner, by a unique index). */
async function ensureHome(db: Db, ownerId: string) {
  const where = and(eq(pagesTable.ownerId, ownerId), eq(pagesTable.kind, "home"));
  let [page] = await db.select().from(pagesTable).where(where);
  if (!page) {
    await db.insert(pagesTable).values({ id: newId("page"), ownerId, kind: "home", title: "Home" }).onConflictDoNothing();
    [page] = await db.select().from(pagesTable).where(where);
  }
  return page!;
}

async function pageWithWidgets(db: Db, page: typeof pagesTable.$inferSelect) {
  const rows = await db.select().from(widgetsTable).where(eq(widgetsTable.pageId, page.id)).orderBy(asc(widgetsTable.createdAt), asc(widgetsTable.id));
  const { id, ownerId, kind, title } = page;
  return { id, ownerId, kind, title, widgets: rows.map(toWidget) };
}

/** The owner's home page and its widgets. */
const home = owner.handler(async ({ context }) => pageWithWidgets(context.db, await ensureHome(context.db, context.ownerId)));

/** Home first, then the owner's pages in the order they were made. */
const list = owner.handler(async ({ context }) => {
  await ensureHome(context.db, context.ownerId);
  return context.db
    .select({ id: pagesTable.id, kind: pagesTable.kind, title: pagesTable.title })
    .from(pagesTable)
    .where(eq(pagesTable.ownerId, context.ownerId))
    .orderBy(sql`${pagesTable.kind} <> 'home'`, asc(pagesTable.createdAt), asc(pagesTable.id));
});

const get = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  return pageWithWidgets(context.db, await requirePage(context.db, context.ownerId, input.id));
});

const createPage = owner.input(z.object({ title: PageTitle })).handler(async ({ input, context }) => {
  // One create at a time per owner, so two can't both take the last place.
  return context.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dispand:pages:${context.ownerId}`}))`);
    const [n] = await tx
      .select({ n: count() })
      .from(pagesTable)
      .where(and(eq(pagesTable.ownerId, context.ownerId), eq(pagesTable.kind, "page")));
    if (n!.n >= MAX_PAGES) throw new ORPCError("BAD_REQUEST", { message: `At most ${MAX_PAGES} pages` });
    const [page] = await tx
      .insert(pagesTable)
      .values({ id: newId("page"), ownerId: context.ownerId, kind: "page", title: input.title })
      .returning({ id: pagesTable.id, kind: pagesTable.kind, title: pagesTable.title });
    return page!;
  });
});

const renamePage = owner.input(z.object({ id: z.string(), title: PageTitle })).handler(async ({ input, context }) => {
  const page = await requirePage(context.db, context.ownerId, input.id);
  if (page.kind === "home") throw new ORPCError("FORBIDDEN", { message: "Home can't be renamed" });
  await context.db.update(pagesTable).set({ title: input.title }).where(eq(pagesTable.id, page.id));
});

/** Deletes a page and, by cascade, its widgets; Home is fixed. */
const removePage = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  const page = await requirePage(context.db, context.ownerId, input.id);
  if (page.kind === "home") throw new ORPCError("FORBIDDEN", { message: "Home can't be deleted" });
  await context.db.delete(pagesTable).where(and(eq(pagesTable.id, page.id), eq(pagesTable.ownerId, context.ownerId)));
});

export const pages = { home, list, get, create: createPage, rename: renamePage, delete: removePage };

const createForm = z.object({ pageId: z.string(), type: z.literal("workflow-form"), workflowId: z.string(), title: Title.optional() });
const createTriggerForm = z.object({ pageId: z.string(), type: z.literal("trigger-form"), triggerId: z.string(), title: Title.optional() });
const createGrid = z.object({ pageId: z.string(), type: z.literal("grid"), tableId: z.string(), config: GridConfig, title: Title.optional() });
const createTable = z.object({ pageId: z.string(), type: z.literal("table"), tableId: z.string(), config: TableConfig, title: Title.optional() });

/** The table's fields, when it is the owner's and the config only uses them (a cover is a files field). */
async function checkConfig(db: Db, ownerId: string, tableId: string, config: GridConfig | TableConfig) {
  const [table] = await db
    .select({ name: tablesTable.name })
    .from(tablesTable)
    .where(and(eq(tablesTable.id, tableId), eq(tablesTable.ownerId, ownerId)));
  if (!table) throw new ORPCError("NOT_FOUND", { message: "Table not found" });
  const fields = (await db.select().from(fieldsTable).where(eq(fieldsTable.tableId, tableId))).map((f) => ({ id: f.id, name: f.name, type: f.type, choices: f.choices }));
  const byId = new Map(fields.map((f) => [f.id, f]));
  const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
  if (new Set(config.fieldIds).size !== config.fieldIds.length) throw bad("A field is chosen twice");
  if (config.fieldIds.some((id) => !byId.has(id))) throw bad("A chosen field isn't a field of this table");
  if ("coverFieldId" in config && config.coverFieldId !== undefined && byId.get(config.coverFieldId)?.type !== "attachment") {
    throw bad("The cover must be a files field of this table");
  }
  if ("sort" in config && config.sort) {
    const problem = queryProblem({ filters: [], sort: [config.sort] }, fields);
    if (problem) throw bad(problem);
  }
  return table;
}

const create = owner.input(z.discriminatedUnion("type", [createForm, createTriggerForm, createGrid, createTable])).handler(async ({ input, context }) => {
  await requirePage(context.db, context.ownerId, input.pageId);
  if (input.type === "trigger-form") {
    const [trigger] = await context.db
      .select({ name: triggers.name, config: triggers.config })
      .from(triggers)
      .where(and(eq(triggers.id, input.triggerId), eq(triggers.ownerId, context.ownerId)));
    if (!trigger) throw new ORPCError("NOT_FOUND", { message: "Trigger not found" });
    const { config } = trigger;
    if (config.kind !== "manual") throw new ORPCError("BAD_REQUEST", { message: "Only a manual trigger can have a form" });
    // One form per trigger on a page, serialized per page like workflow forms.
    const row = await context.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dispand:widgets:${input.pageId}`}))`);
      const existing = await tx.select().from(widgetsTable).where(eq(widgetsTable.pageId, input.pageId));
      const already = existing.find((w) => w.triggerId === input.triggerId);
      if (already) return already;
      const [inserted] = await tx
        .insert(widgetsTable)
        .values({
          id: newId("widget"),
          ownerId: context.ownerId,
          pageId: input.pageId,
          type: "trigger-form",
          title: input.title ?? trigger.name,
          triggerId: input.triggerId,
          layout: placeBelow(
            existing.map((w) => w.layout),
            config.placement,
          ),
        })
        .returning();
      return inserted!;
    });
    return toWidget(row);
  }
  if (input.type !== "workflow-form") {
    const table = await checkConfig(context.db, context.ownerId, input.tableId, input.config);
    const existing = await context.db.select({ layout: widgetsTable.layout }).from(widgetsTable).where(eq(widgetsTable.pageId, input.pageId));
    const [row] = await context.db
      .insert(widgetsTable)
      .values({
        id: newId("widget"),
        ownerId: context.ownerId,
        pageId: input.pageId,
        type: input.type,
        title: input.title ?? table.name,
        tableId: input.tableId,
        config: input.config,
        layout: placeBelow(
          existing.map((w) => w.layout),
          "data",
        ),
      })
      .returning();
    return toWidget(row!);
  }
  const [wf] = await context.db
    .select({ name: workflows.name, def: workflowVersions.def })
    .from(workflows)
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.version, workflows.currentVersion)))
    .where(and(eq(workflows.id, input.workflowId), eq(workflows.ownerId, context.ownerId)));
  if (!wf) throw new ORPCError("NOT_FOUND", { message: "Workflow not found" });
  if (wf.def.trigger.type !== "manual") throw new ORPCError("BAD_REQUEST", { message: "Only a manual workflow can have a form" });
  // One form per workflow on a page: asking again returns it (a double click, a second visit).
  // Serialized per page, so two concurrent creates can't both insert (older duplicates stay as they are).
  const row = await context.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dispand:widgets:${input.pageId}`}))`);
    const existing = await tx.select().from(widgetsTable).where(eq(widgetsTable.pageId, input.pageId));
    const already = existing.find((w) => w.workflowId === input.workflowId);
    if (already) return already;
    const [inserted] = await tx
      .insert(widgetsTable)
      .values({
        id: newId("widget"),
        ownerId: context.ownerId,
        pageId: input.pageId,
        type: "workflow-form",
        title: input.title ?? wf.name,
        workflowId: input.workflowId,
        layout: placeBelow(
          existing.map((w) => w.layout),
          wf.def.trigger.field.type === "chat" ? "chat" : "button",
        ),
      })
      .returning();
    return inserted!;
  });
  return toWidget(row);
});

const UpdateConfig = GridConfig.extend({ sort: TableConfig.shape.sort });

/** Renames a widget, or sets what a Grid or Table widget shows (`config`, checked against its table). */
const update = owner
  .input(z.object({ id: z.string(), title: Title.optional(), config: UpdateConfig.optional() }))
  .handler(async ({ input, context }) => {
    const widget = await requireWidget(context.db, context.ownerId, input.id);
    let config: GridConfig | TableConfig | undefined;
    if (input.config) {
      if (widget.type === "workflow-form" || widget.type === "trigger-form") throw new ORPCError("BAD_REQUEST", { message: "A form has no fields to choose" });
      // Only what the widget's type keeps: a Grid has a cover, a Table a sort.
      const { fieldIds, coverFieldId, sort } = input.config;
      config = widget.type === "grid" ? { fieldIds, coverFieldId } : { fieldIds, sort };
      await checkConfig(context.db, context.ownerId, widget.tableId!, config);
    }
    const [row] = await context.db
      .update(widgetsTable)
      .set({ ...(input.title && { title: input.title }), ...(config && { config }) })
      .where(eq(widgetsTable.id, input.id))
      .returning();
    return toWidget(row!);
  });

const removeWidget = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  await requireWidget(context.db, context.ownerId, input.id);
  await context.db.delete(widgetsTable).where(eq(widgetsTable.id, input.id));
});

const Item = GridPos.extend({ i: z.string() });
const Layouts = z.object({ lg: z.array(Item).max(200), md: z.array(Item).max(200), sm: z.array(Item).max(200) }).partial();

/** Saves the positions of the page's widgets at each breakpoint given; items of other pages are ignored. */
const saveLayout = owner.input(z.object({ pageId: z.string(), layouts: Layouts })).handler(async ({ input, context }) => {
  await requirePage(context.db, context.ownerId, input.pageId);
  for (const bp of BREAKPOINTS) {
    for (const item of input.layouts[bp] ?? []) {
      if (!fits(bp, item)) throw new ORPCError("BAD_REQUEST", { message: `A widget is wider than the ${bp} grid` });
    }
  }
  const ids = [...new Set(BREAKPOINTS.flatMap((bp) => (input.layouts[bp] ?? []).map((item) => item.i)))];
  if (ids.length === 0) return;
  await context.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(widgetsTable)
      .where(and(eq(widgetsTable.pageId, input.pageId), inArray(widgetsTable.id, ids)))
      .for("update");
    for (const row of rows) {
      const layout = { ...row.layout };
      for (const bp of BREAKPOINTS) {
        const item = input.layouts[bp]?.find((it) => it.i === row.id);
        if (item) layout[bp as Breakpoint] = { x: item.x, y: item.y, w: item.w, h: item.h };
      }
      await tx.update(widgetsTable).set({ layout }).where(eq(widgetsTable.id, row.id));
    }
  });
});

export const widgets = { create, update, delete: removeWidget, saveLayout };
