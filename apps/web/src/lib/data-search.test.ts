import { expect, test } from "vitest";
import { parseDataSearch, toDataSearch } from "./data-search.ts";

const query = {
  filters: [
    { fieldId: "fld_a", op: "contains" as const, value: "Orch" },
    { fieldId: "fld_b", op: "empty" as const },
  ],
  sort: [{ fieldId: "fld_c", dir: "desc" as const }],
};

test("round-trips a query", () => {
  const search = toDataSearch(query, "row_1");
  expect(typeof search.q).toBe("string");
  expect(parseDataSearch(search)).toEqual({ query, row: "row_1" });
  // The router may hand the JSON back already parsed.
  expect(parseDataSearch({ q: JSON.parse(search.q!), row: "row_1" })).toEqual({ query, row: "row_1" });
  expect(toDataSearch({ filters: [], sort: [] })).toEqual({});
});

test("drops an unknown op and a malformed q instead of throwing", () => {
  expect(parseDataSearch({ q: "{" })).toEqual({ query: { filters: [], sort: [] } });
  expect(parseDataSearch(undefined)).toEqual({ query: { filters: [], sort: [] } });
  expect(parseDataSearch({ q: 42, row: ["x"] })).toEqual({ query: { filters: [], sort: [] } });
  const q = JSON.stringify({ filters: [{ fieldId: "fld_a", op: "resembles", value: "x" }, query.filters[0]], sort: [{ fieldId: "fld_c", dir: "sideways" }] });
  expect(parseDataSearch({ q })).toEqual({ query: { filters: [query.filters[0]], sort: [] } });
});

test("keeps at most 20 filters and 3 sorts", () => {
  const many = { filters: Array.from({ length: 25 }, () => query.filters[1]), sort: Array.from({ length: 5 }, () => query.sort[0]) };
  const parsed = parseDataSearch({ q: JSON.stringify(many) }).query;
  expect([parsed.filters.length, parsed.sort.length]).toEqual([20, 3]);
});
