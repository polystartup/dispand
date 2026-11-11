import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { z } from "zod";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { NOT_TOOLS, PLATFORM_TOOLS, procedureOf, procedurePaths } from "./tools.ts";

const toolPaths = PLATFORM_TOOLS.map((t) => t.path);

test("every procedure of the router is a tool or declared not a tool, never both", () => {
  const paths = procedurePaths(router);
  const declared = [...toolPaths, ...NOT_TOOLS];
  // A procedure in neither list: declare it in platform/tools.ts, as a tool of a bundle or in NOT_TOOLS.
  expect(paths.filter((p) => !declared.includes(p))).toEqual([]);
  // A stale entry: the procedure is gone or was renamed.
  expect(declared.filter((p) => !paths.includes(p))).toEqual([]);
  expect(toolPaths.filter((p) => NOT_TOOLS.includes(p))).toEqual([]);
  expect(new Set(declared).size).toBe(declared.length);
});

test("a procedure nobody declared fails the walk", () => {
  const paths = procedurePaths({ ...router, extra: { thing: router.tables.list } });
  expect(paths).toContain("extra.thing");
  expect([...toolPaths, ...NOT_TOOLS]).not.toContain("extra.thing");
});

test("tool names are unique, at most 64 characters, and their input is the procedure's own schema", () => {
  expect(new Set(PLATFORM_TOOLS.map((t) => t.name)).size).toBe(PLATFORM_TOOLS.length);
  for (const tool of PLATFORM_TOOLS) {
    expect(tool.name).toBe(tool.path.replace(".", "_").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    expect(tool.name).toMatch(/^[a-z_]{1,64}$/);
    expect(tool.description.length).toBeGreaterThan(10);
    const own = (procedureOf(router, tool.path) as unknown as { "~orpc": { inputSchema?: unknown } })["~orpc"].inputSchema;
    // A procedure without input takes an empty object as a tool.
    if (own) expect(tool.input).toBe(own);
    else expect(tool.input.safeParse({}).success).toBe(true);
  }
});

test("the tools are exactly the data and configure ones, on tables, fields, rows and agents only", () => {
  const of = (bundle: string) => PLATFORM_TOOLS.filter((t) => t.bundle === bundle).map((t) => t.name).sort();
  expect(of("data")).toEqual(["rows_create", "rows_delete", "rows_get", "rows_list", "rows_update", "tables_get", "tables_list"]);
  expect(of("configure")).toEqual([
    "agents_create",
    "agents_get",
    "agents_list",
    "agents_set_tool_ask",
    "agents_tool_ask",
    "agents_update",
    "fields_create",
    "fields_delete",
    "fields_reorder",
    "fields_update",
    "tables_create",
    "tables_delete",
    "tables_rename",
  ]);
  expect(PLATFORM_TOOLS).toHaveLength(20);
  expect(PLATFORM_TOOLS.every((t) => ["tables", "fields", "rows", "agents"].includes(t.path.split(".")[0]!))).toBe(true);
  // What changes what agents may do is marked: it runs only on a proposal a person approved.
  expect(PLATFORM_TOOLS.filter((t) => t.grant).map((t) => t.name).sort()).toEqual(["agents_create", "agents_set_tool_ask", "agents_update", "fields_delete", "tables_delete"]);
  // What needs a person, and what agents never touch, are named as not tools.
  for (const path of ["fields.retype", "auth.setup", "runners.create", "tools.create", "agents.delete", "triggers.create", "questions.answer", "files.upload"]) {
    expect(NOT_TOOLS).toContain(path);
  }
});

test("tables of a call: a row id gives its table, several rows every table, tables.create none", async () => {
  const context = await ownerContext();
  const t1 = await call(router.tables.create, { name: "Clients" }, { context });
  const t2 = await call(router.tables.create, { name: "Matters" }, { context });
  const r1 = await call(router.rows.create, { tableId: t1.id }, { context });
  const r2 = await call(router.rows.create, { tableId: t2.id }, { context });
  const field = await call(router.fields.create, { tableId: t2.id, name: "Title", type: "text" }, { context });
  const tablesOf = (name: string, input: unknown) => PLATFORM_TOOLS.find((t) => t.name === name)!.tables(context.db, context.ownerId, input);

  expect(await tablesOf("rows_get", { id: r1.id })).toEqual([t1.id]);
  expect(await tablesOf("rows_update", { id: r2.id, values: {} })).toEqual([t2.id]);
  expect((await tablesOf("rows_delete", { ids: [r1.id, r2.id] })).sort()).toEqual([t1.id, t2.id].sort());
  expect(await tablesOf("rows_list", { tableId: t1.id })).toEqual([t1.id]);
  expect(await tablesOf("rows_create", { tableId: t2.id })).toEqual([t2.id]);
  expect(await tablesOf("tables_get", { id: t1.id })).toEqual([t1.id]);
  expect(await tablesOf("tables_rename", { id: t1.id, name: "X" })).toEqual([t1.id]);
  expect(await tablesOf("fields_create", { tableId: t2.id, name: "N", type: "text" })).toEqual([t2.id]);
  expect(await tablesOf("fields_update", { id: field.id, name: "Name" })).toEqual([t2.id]);
  expect(await tablesOf("fields_reorder", { tableId: t2.id, fieldIds: [field.id] })).toEqual([t2.id]);
  expect(await tablesOf("tables_create", { name: "New" })).toEqual([]);
  expect(await tablesOf("tables_list", {})).toEqual([]);
  // An id that names nothing (or someone else's row) names an unknown table: never "no table".
  expect(await tablesOf("rows_get", { id: "row_nobody" })).toEqual([null]);
  expect(await tablesOf("rows_delete", { ids: [r1.id, "row_nobody"] })).toContain(null);
  expect(await tablesOf("fields_update", { id: "field_nobody" })).toEqual([null]);
});

test("tables.list's filter keeps only the tables in scope; \"all\" keeps everything", () => {
  const list = PLATFORM_TOOLS.find((t) => t.name === "tables_list")!;
  const output = [{ id: "t1", name: "A" }, { id: "t2", name: "B" }];
  expect(list.filter!(output, ["t2"])).toEqual([{ id: "t2", name: "B" }]);
  expect(list.filter!(output, "all")).toEqual(output);
  expect(list.filter!(output, [])).toEqual([]);
});

test("every tool's input has a JSON Schema an MCP client or a model can read", () => {
  for (const tool of PLATFORM_TOOLS) {
    expect(z.toJSONSchema(tool.input, { io: "input" }), tool.name).toMatchObject({ type: "object" });
  }
});
