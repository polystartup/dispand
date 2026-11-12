import { expect, test } from "vitest";
import { fillLastPoll, itemsOf, MAX_ITEM_BYTES, MAX_TOKEN, nextToken } from "./poll.ts";

test("{{lastPoll}} is filled in every string, nested ones included, and keys are left as they are", () => {
  expect(fillLastPoll({ filter: "gt {{lastPoll}}", nested: [{ "{{lastPoll}}": "{{lastPoll}}" }], top: 10 }, "2026-11-12T09:00:00.000Z")).toEqual({
    filter: "gt 2026-11-12T09:00:00.000Z",
    nested: [{ "{{lastPoll}}": "2026-11-12T09:00:00.000Z" }],
    top: 10,
  });
});

test("{{lastPollEpoch}} is the same time in whole seconds, rounded down", () => {
  expect(fillLastPoll({ query: "in:inbox after:{{lastPollEpoch}}", since: "{{lastPoll}}" }, "2026-11-12T09:00:00.999Z")).toEqual({
    query: "in:inbox after:1794474000",
    since: "2026-11-12T09:00:00.999Z",
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

test("the next page's token is the query parameter of a link, or the value itself; none ends the walk; one that can't be followed fails", () => {
  const graph = { path: "@odata.nextLink", query: "$skiptoken", argument: "skiptoken" };
  expect(nextToken({ value: [], "@odata.nextLink": "https://graph.example.com/v1.0/me/messages?$skiptoken=abc&$top=10" }, graph)).toEqual({ token: "abc" });
  expect(nextToken({ value: [] }, graph)).toEqual({ token: null });
  expect(nextToken({ "@odata.nextLink": null }, graph)).toEqual({ token: null });
  expect(nextToken({ "@odata.nextLink": "not a link" }, graph)).toEqual({ error: "The result's next page at “@odata.nextLink” isn't a link" });
  expect(nextToken({ "@odata.nextLink": "https://graph.example.com/v1.0/me/messages?$top=10" }, graph)).toEqual({ error: "The result's next page has no “$skiptoken”" });
  const plain = { path: "page.next", argument: "cursor" };
  expect(nextToken({ page: { next: "c2" } }, plain)).toEqual({ token: "c2" });
  expect(nextToken({ page: { next: 2 } }, plain)).toEqual({ error: "The result's next page at “page.next” isn't text" });
  expect(nextToken({ page: { next: "x".repeat(MAX_TOKEN + 1) } }, plain)).toEqual({ error: "The result's next page token is too long to follow" });
});
