import { expect, test } from "vitest";
import type { FieldSchema } from "./fields.ts";
import { FILTER_OPS, queryProblem, RowQuery } from "./query.ts";

const price: FieldSchema = { id: "f_price", name: "Price", type: "number", choices: [] };
const site: FieldSchema = { id: "f_site", name: "Site", type: "url", choices: [] };
const logo: FieldSchema = { id: "f_logo", name: "Logo", type: "attachment", choices: [] };
const done: FieldSchema = { id: "f_done", name: "Done", type: "checkbox", choices: [] };
const fields = [price, site, logo, done];

const q = (query: unknown) => queryProblem(RowQuery.parse(query), fields);

test("ops follow the field type", () => {
  expect(FILTER_OPS.number).not.toContain("contains");
  expect(q({ filters: [{ fieldId: "f_price", op: "contains", value: "1" }] })).not.toBeNull();
  expect(q({ filters: [{ fieldId: "f_done", op: "checked" }] })).toBeNull();
  expect(q({ filters: [{ fieldId: "f_logo", op: "is", value: "x" }] })).not.toBeNull();
  expect(q({ filters: [{ fieldId: "f_gone", op: "empty" }] })).toBe("A filter or sort uses a field that no longer exists");
  expect(q({ sort: [{ fieldId: "f_gone", dir: "asc" }] })).not.toBeNull();
  expect(q({ sort: [{ fieldId: "f_logo", dir: "asc" }] })).not.toBeNull();
  expect(q({ sort: [{ fieldId: "f_price", dir: "desc" }] })).toBeNull();
});

test("a filter value is parsed with its field", () => {
  expect(q({ filters: [{ fieldId: "f_price", op: ">", value: "lots" }] })).toBe("“Price”: expected a number, got “lots”");
  expect(q({ filters: [{ fieldId: "f_price", op: ">" }] })).toBe("“Price”: a value is needed");
  expect(q({ filters: [{ fieldId: "f_price", op: ">", value: " 1,5 " }] })).toBeNull();
  // "contains" takes any text, even on a URL field.
  expect(q({ filters: [{ fieldId: "f_site", op: "contains", value: "example" }] })).toBeNull();
  expect(q({ filters: [{ fieldId: "f_site", op: "is", value: "example" }] })).not.toBeNull();
});

test("a query has at most 20 filters and 3 sorts", () => {
  const filter = { fieldId: "f_done", op: "checked" };
  expect(RowQuery.safeParse({ filters: Array(21).fill(filter) }).success).toBe(false);
  expect(RowQuery.safeParse({ sort: Array(4).fill({ fieldId: "f_price", dir: "asc" }) }).success).toBe(false);
  expect(RowQuery.parse({})).toEqual({ filters: [], sort: [] });
});
