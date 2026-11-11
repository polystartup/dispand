import { expect, test } from "vitest";
import { fillLastPoll, itemsOf, MAX_ITEM_BYTES } from "./poll.ts";

test("{{lastPoll}} is filled in every string, nested ones included, and keys are left as they are", () => {
  expect(fillLastPoll({ filter: "gt {{lastPoll}}", nested: [{ "{{lastPoll}}": "{{lastPoll}}" }], top: 10 }, "2026-11-12T09:00:00.000Z")).toEqual({
    filter: "gt 2026-11-12T09:00:00.000Z",
    nested: [{ "{{lastPoll}}": "2026-11-12T09:00:00.000Z" }],
    top: 10,
  });
});

test("items are the list at the path, each with its id; without an id they are counted, twice kept once, too large kept without content", () => {
  const big = "x".repeat(MAX_ITEM_BYTES);
  const data = { page: { value: [{ id: "a" }, { meta: { id: 7 } }, { id: "a" }, { id: { x: 1 } }, { id: "b", body: big }] } };
  expect(itemsOf(data, "page.value", "id")).toEqual({
    items: [
      { id: "a", content: '{"id":"a"}', tooLarge: false },
      { id: "b", content: "", tooLarge: true },
    ],
    noId: 2,
  });
  expect(itemsOf(data, "page.value", "meta.id")).toMatchObject({ items: [{ id: "7" }], noId: 4 });
  expect(itemsOf([{ id: 1 }], "", "id")).toMatchObject({ items: [{ id: "1" }] });
  expect(itemsOf(data, "page", "id")).toEqual({ error: "The result has no list at “page”" });
  expect(itemsOf({}, "", "id")).toEqual({ error: "The result isn't a list" });
  // All of them, however many: one left out could fall before the next `{{lastPoll}}`.
  expect((itemsOf(Array.from({ length: 5000 }, (_, i) => ({ id: i })), "", "id") as { items: unknown[] }).items).toHaveLength(5000);
});
