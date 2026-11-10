import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents as agentsTable, fields as fieldsTable, harnesses as harnessesTable, pages, tables, triggers as triggersTable, user, widgets, workflows, workflowVersions } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

test("home page exists after setup and can't be deleted", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  expect(home).toMatchObject({ id: expect.stringMatching(/^page_/), ownerId: context.ownerId, kind: "home", title: "Home", widgets: [] });
  // Created once: concurrent and later calls get the same page.
  const again = await Promise.all([call(router.pages.home, undefined, { context }), call(router.pages.home, undefined, { context })]);
  expect(again.map((p) => p.id)).toEqual([home.id, home.id]);
  expect(await context.db.select().from(pages)).toHaveLength(1);

  await expect(call(router.pages.delete, { id: home.id }, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await context.db.select().from(pages)).toHaveLength(1);
});

test("widgets: create with the workflow's name, rename, save layouts per breakpoint, delete", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  const wf = await call(router.workflows.create, { name: "Write a post" }, { context });
  const widget = await call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf.id }, { context });
  expect(widget).toMatchObject({ id: expect.stringMatching(/^widget_/), pageId: home.id, type: "workflow-form", title: "Write a post", workflowId: wf.id });
  expect(Object.keys(widget.layout).sort()).toEqual(["lg", "md", "sm"]);
  // A second one goes below the first.
  const wf2 = await call(router.workflows.create, { name: "Write again" }, { context });
  const second = await call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf2.id, title: "Again" }, { context });
  expect(second.layout.lg.y).toBe(widget.layout.lg.y + widget.layout.lg.h);

  const renamed = await call(router.widgets.update, { id: widget.id, title: "  Start a post now " }, { context });
  expect(renamed.title).toBe("Start a post now");

  await call(
    router.widgets.saveLayout,
    { pageId: home.id, layouts: { lg: [{ i: widget.id, x: 6, y: 0, w: 6, h: 9 }], sm: [{ i: second.id, x: 0, y: 3, w: 1, h: 4 }] } },
    { context },
  );
  const after = await call(router.pages.home, undefined, { context });
  const byId = new Map(after.widgets.map((w) => [w.id, w]));
  expect(byId.get(widget.id)!.layout).toEqual({ ...widget.layout, lg: { x: 6, y: 0, w: 6, h: 9 } });
  expect(byId.get(second.id)!.layout).toEqual({ ...second.layout, sm: { x: 0, y: 3, w: 1, h: 4 } });

  // An item wider than the grid is refused.
  await expect(
    call(router.widgets.saveLayout, { pageId: home.id, layouts: { lg: [{ i: widget.id, x: 8, y: 0, w: 6, h: 4 }] } }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });

  await call(router.widgets.delete, { id: widget.id }, { context });
  expect((await call(router.pages.home, undefined, { context })).widgets.map((w) => w.id)).toEqual([second.id]);
});

test("widget for a non-manual or other owner's workflow is refused", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });

  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(workflows).values({ id: "wf_other", ownerId: "user_other", name: "Eve's", currentVersion: 1 });
  await expect(call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: "wf_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });

  // A trigger other than manual (stored by a later version of the app) can't back a form.
  const wf = await call(router.workflows.create, { name: "Nightly" }, { context });
  const scheduled = { ...wf.def, trigger: { ...wf.def.trigger, type: "schedule" } } as unknown as typeof wf.def;
  await context.db.update(workflowVersions).set({ def: scheduled }).where(eq(workflowVersions.workflowId, wf.id));
  await expect(call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf.id }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  // Another owner's page, and another owner's widget.
  await context.db.insert(pages).values({ id: "page_other", ownerId: "user_other", kind: "home", title: "Home" });
  const mine = await call(router.workflows.create, { name: "Mine" }, { context });
  await expect(call(router.widgets.create, { pageId: "page_other", type: "workflow-form", workflowId: mine.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.pages.delete, { id: "page_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.widgets.update, { id: "widget_nope", title: "x" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(router.widgets.saveLayout, { pageId: "page_other", layouts: { lg: [] } }, { context }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("widgets.create is idempotent per page and workflow", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  const wf = await call(router.workflows.create, { name: "Write a post" }, { context });
  const results = await Promise.all([
    call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf.id }, { context }),
    call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf.id }, { context }),
  ]);
  const again = await call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf.id, title: "Other" }, { context });
  expect(new Set([...results, again].map((w) => w.id)).size).toBe(1);
  expect(again.title).toBe("Write a post");
  expect((await call(router.pages.home, undefined, { context })).widgets).toHaveLength(1);
});

test("forms made twice before creation was idempotent keep their own settings", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  const wf = await call(router.workflows.create, { name: "Write a post" }, { context });
  const first = await call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf.id }, { context });
  // A second form for the same workflow, as the earlier API allowed, with its own title.
  await context.db.insert(widgets).values({ ...(await context.db.select().from(widgets).where(eq(widgets.id, first.id)))[0]!, id: "widget_older", title: "Mine" });
  const again = await call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf.id }, { context });
  expect([first.id, "widget_older"]).toContain(again.id);
  expect((await call(router.pages.home, undefined, { context })).widgets.map((w) => w.title).sort()).toEqual(["Mine", "Write a post"]);
});

test("pages: create, list after Home, rename, delete with its widgets", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  const projects = await call(router.pages.create, { title: "  Projects " }, { context });
  expect(projects).toEqual({ id: expect.stringMatching(/^page_/), kind: "page", title: "Projects" });
  const later = await call(router.pages.create, { title: "Projects" }, { context });
  expect((await call(router.pages.list, undefined, { context })).map((p) => [p.kind, p.title])).toEqual([
    ["home", "Home"],
    ["page", "Projects"],
    ["page", "Projects"],
  ]);
  expect((await call(router.pages.list, undefined, { context }))[0]!.id).toBe(home.id);

  await call(router.pages.rename, { id: projects.id, title: "Portfolio" }, { context });
  const wf = await call(router.workflows.create, { name: "Write a post" }, { context });
  const widget = await call(router.widgets.create, { pageId: projects.id, type: "workflow-form", workflowId: wf.id }, { context });
  expect(await call(router.pages.get, { id: projects.id }, { context })).toMatchObject({
    id: projects.id,
    ownerId: context.ownerId,
    kind: "page",
    title: "Portfolio",
    widgets: [{ id: widget.id, pageId: projects.id }],
  });

  await call(router.pages.delete, { id: projects.id }, { context });
  expect((await call(router.pages.list, undefined, { context })).map((p) => p.id)).toEqual([home.id, later.id]);
  expect(await context.db.select().from(widgets).where(eq(widgets.id, widget.id))).toEqual([]);
  await expect(call(router.pages.get, { id: projects.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("pages: Home is listed before any call to pages.home", async () => {
  const context = await ownerContext();
  expect((await call(router.pages.list, undefined, { context })).map((p) => p.kind)).toEqual(["home"]);
});

test("Home can't be renamed or deleted", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  await expect(call(router.pages.rename, { id: home.id, title: "Start" }, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(call(router.pages.delete, { id: home.id }, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await call(router.pages.get, { id: home.id }, { context })).title).toBe("Home");
});

test("another owner's page is NOT_FOUND for get, rename, delete and widgets.create", async () => {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(pages).values({ id: "page_eve", ownerId: "user_other", kind: "page", title: "Eve's" });
  const wf = await call(router.workflows.create, { name: "Mine" }, { context });
  await expect(call(router.pages.get, { id: "page_eve" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.pages.rename, { id: "page_eve", title: "Mine" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.pages.delete, { id: "page_eve" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.widgets.create, { pageId: "page_eve", type: "workflow-form", workflowId: wf.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await call(router.pages.list, undefined, { context })).map((p) => p.id)).not.toContain("page_eve");
  expect(await context.db.select().from(pages).where(eq(pages.id, "page_eve"))).toHaveLength(1);
});

test("the 51st page is refused", async () => {
  const context = await ownerContext();
  await call(router.pages.home, undefined, { context });
  await Promise.all(Array.from({ length: 50 }, (_, i) => call(router.pages.create, { title: `Page ${i}` }, { context })));
  await expect(call(router.pages.create, { title: "One too many" }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await call(router.pages.list, undefined, { context })).filter((p) => p.kind === "page")).toHaveLength(50);
});

async function projectsTable(context: Awaited<ReturnType<typeof ownerContext>>) {
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const logo = await call(router.fields.create, { tableId: table.id, name: "Logo", type: "attachment" }, { context });
  const price = await call(router.fields.create, { tableId: table.id, name: "Price", type: "number" }, { context });
  return { table, name: table.fields[0]!, logo, price };
}

test("grid and table widgets: create with the table's name, fields checked against the table", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  const { table, name, logo, price } = await projectsTable(context);
  const grid = await call(
    router.widgets.create,
    { pageId: home.id, type: "grid", tableId: table.id, config: { fieldIds: [name.id, price.id], coverFieldId: logo.id } },
    { context },
  );
  expect(grid).toMatchObject({ type: "grid", title: "Projects", tableId: table.id, config: { fieldIds: [name.id, price.id], coverFieldId: logo.id } });
  // Data widgets aren't deduplicated; each goes below the last.
  const list = await call(
    router.widgets.create,
    { pageId: home.id, type: "table", tableId: table.id, config: { fieldIds: [name.id], sort: { fieldId: price.id, dir: "desc" } }, title: "All" },
    { context },
  );
  expect(list).toMatchObject({ type: "table", title: "All", config: { sort: { fieldId: price.id, dir: "desc" } } });
  expect(list.layout.lg.y).toBe(grid.layout.lg.y + grid.layout.lg.h);
  const again = await call(router.widgets.create, { pageId: home.id, type: "table", tableId: table.id, config: { fieldIds: [name.id] } }, { context });
  expect(again.id).not.toBe(list.id);

  const bad = (config: object, type: "grid" | "table" = "table") =>
    expect(call(router.widgets.create, { pageId: home.id, type, tableId: table.id, config } as never, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await bad({ fieldIds: ["fld_nope"] });
  await bad({ fieldIds: [name.id, name.id] });
  await bad({ fieldIds: [] });
  await bad({ fieldIds: [name.id], sort: { fieldId: logo.id, dir: "asc" } });
  await bad({ fieldIds: [name.id], sort: { fieldId: "fld_nope", dir: "asc" } });

  // The widget's config is changed in place, and only what its type keeps is stored.
  const updated = await call(
    router.widgets.update,
    { id: list.id, config: { fieldIds: [price.id, name.id], coverFieldId: logo.id, sort: { fieldId: name.id, dir: "asc" } } },
    { context },
  );
  expect(updated).toMatchObject({ config: { fieldIds: [price.id, name.id], sort: { fieldId: name.id, dir: "asc" } } });
  expect("coverFieldId" in (updated as { config: object }).config).toBe(false);
  expect(updated.title).toBe("All");
  await expect(call(router.widgets.update, { id: list.id, config: { fieldIds: ["fld_nope"] } }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const wf = await call(router.workflows.create, { name: "Write" }, { context });
  const form = await call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf.id }, { context });
  await expect(call(router.widgets.update, { id: form.id, config: { fieldIds: [name.id] } }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("a cover that isn't an attachment field is refused", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  const { table, name, price } = await projectsTable(context);
  for (const coverFieldId of [price.id, name.id, "fld_nope"]) {
    await expect(
      call(router.widgets.create, { pageId: home.id, type: "grid", tableId: table.id, config: { fieldIds: [name.id], coverFieldId } }, { context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect((await call(router.pages.home, undefined, { context })).widgets).toEqual([]);
});

test("deleting a table deletes its widgets", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  const { table, name } = await projectsTable(context);
  const other = await call(router.tables.create, { name: "Notes" }, { context });
  const mine = await call(router.widgets.create, { pageId: home.id, type: "grid", tableId: table.id, config: { fieldIds: [name.id] } }, { context });
  const kept = await call(router.widgets.create, { pageId: home.id, type: "table", tableId: other.id, config: { fieldIds: [other.fields[0]!.id] } }, { context });
  await call(router.tables.delete, { id: table.id }, { context });
  expect((await call(router.pages.home, undefined, { context })).widgets.map((w) => w.id)).toEqual([kept.id]);
  expect(await context.db.select().from(widgets).where(eq(widgets.id, mine.id))).toEqual([]);
});

test("another owner's table can't back a widget", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tables).values({ id: "tbl_eve", ownerId: "user_other", name: "Eve's" });
  await context.db.insert(fieldsTable).values({ id: "fld_eve", ownerId: "user_other", tableId: "tbl_eve", name: "Name", type: "text", position: 0 });
  await expect(
    call(router.widgets.create, { pageId: home.id, type: "grid", tableId: "tbl_eve", config: { fieldIds: ["fld_eve"] } }, { context }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await call(router.pages.home, undefined, { context })).widgets).toEqual([]);
});

test("old workflow widgets still read", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  const wf = await call(router.workflows.create, { name: "Write a post" }, { context });
  const layout = (await call(router.widgets.create, { pageId: home.id, type: "workflow-form", workflowId: wf.id }, { context })).layout;
  await context.db.delete(widgets);
  // A row as migration 0007 left it: no table, no config.
  await context.db.insert(widgets).values({ id: "widget_old", ownerId: context.ownerId, pageId: home.id, type: "workflow-form", title: "Old", workflowId: wf.id, layout });
  expect((await call(router.pages.home, undefined, { context })).widgets).toEqual([
    { id: "widget_old", pageId: home.id, type: "workflow-form", title: "Old", workflowId: wf.id, layout },
  ]);
  // The database refuses a widget that has neither or both targets.
  await expect(context.db.insert(widgets).values({ id: "widget_bad", ownerId: context.ownerId, pageId: home.id, type: "grid", title: "x", workflowId: wf.id, layout })).rejects.toThrow();
});

test("creates a trigger-form widget titled after the trigger and refuses another owner's trigger", async () => {
  const context = await ownerContext();
  const home = await call(router.pages.home, undefined, { context });
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Ask the clerk", config: { kind: "manual", placement: "chat" } }, { context });

  const widget = await call(router.widgets.create, { pageId: home.id, type: "trigger-form", triggerId: trigger.id }, { context });
  expect(widget).toMatchObject({ id: expect.stringMatching(/^widget_/), pageId: home.id, type: "trigger-form", title: "Ask the clerk", triggerId: trigger.id });
  // One per trigger on a page: asking again returns it.
  expect((await call(router.widgets.create, { pageId: home.id, type: "trigger-form", triggerId: trigger.id, title: "Other" }, { context })).id).toBe(widget.id);
  expect((await call(router.pages.home, undefined, { context })).widgets).toEqual([widget]);

  // Only a manual trigger has a form.
  const schedule = await call(router.triggers.create, { agentId: agent.id, name: "Daily", config: { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/Paris" } }, { context });
  await expect(call(router.widgets.create, { pageId: home.id, type: "trigger-form", triggerId: schedule.id }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(harnessesTable).values({ id: "harness_other", ownerId: "user_other", name: "Eve's", runnerId, kind: "claude-code", permissionMode: "default" });
  await context.db.insert(agentsTable).values({ id: "agent_other", ownerId: "user_other", name: "Eve's", harnessId: "harness_other", systemPrompt: "" });
  await context.db.insert(triggersTable).values({ id: "trigger_other", ownerId: "user_other", agentId: "agent_other", kind: "manual", name: "T", config: { kind: "manual", placement: "button" } });
  await expect(call(router.widgets.create, { pageId: home.id, type: "trigger-form", triggerId: "trigger_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });

  // The widget goes with its trigger.
  await call(router.triggers.delete, { id: trigger.id }, { context });
  expect((await call(router.pages.home, undefined, { context })).widgets).toEqual([]);
});
