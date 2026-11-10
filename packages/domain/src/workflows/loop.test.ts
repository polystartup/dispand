import { expect, test } from "vitest";
import { itemValues, loopResults, parseList } from "./loop.ts";

test("parseList cases", () => {
  expect(parseList("[]")).toEqual({ items: [] });
  expect(parseList('["a","b"]')).toEqual({ items: ["a", "b"] });
  expect(parseList('{"a":1}')).toEqual({ error: "is not a list (a JSON array)" });
  expect(parseList("a\nb")).toEqual({ error: "is not a list (a JSON array)" });
  expect(parseList("  [1]  ")).toEqual({ items: [1] });
});

test("itemValues of a text item", () => {
  expect(itemValues("hello", 2)).toEqual({ item: "hello", index: "3" });
  expect(itemValues([1, 2], 0)).toEqual({ item: "[1,2]", index: "1" });
});

test("itemValues of an object item", () => {
  expect(itemValues({ name: "x", stars: 3, __proto__: 1 }, 0)).toEqual({ item: '{"name":"x","stars":3}', index: "1", name: "x", stars: "3" });
  const parsed = JSON.parse('{"__proto__":{"a":1},"item":"no","index":"no","bad key":1,"tags":["a"]}') as unknown;
  const values = itemValues(parsed, 4);
  expect(values).toEqual({ item: JSON.stringify(parsed), index: "5", tags: '["a"]' });
  expect(Object.hasOwn(values, "__proto__")).toBe(false);
});

test("loopResults gives one object per iteration", () => {
  expect(loopResults([])).toBe("[]");
  expect(loopResults([{ fetch: { title: "A" } }, { fetch: { title: "B" } }])).toBe('[{"fetch":{"title":"A"}},{"fetch":{"title":"B"}}]');
});

test("itemValues makes decoded text storable", () => {
  const list = parseList('["a\\u0000b", {"name": "\\ud800"}]');
  if (!("items" in list)) throw new Error("not a list");
  expect(itemValues(list.items[0], 0).item).toBe("a�b");
  expect(itemValues(list.items[1], 1)).toEqual({ item: '{"name":"\\ud800"}', index: "2", name: "�" });
});
