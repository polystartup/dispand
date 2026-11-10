import { expect, test } from "vitest";
import { takeNew } from "./new-questions.ts";

test("the first list only learns; later lists give the question ids not seen before", () => {
  const first = takeNew(null, [{ id: "a" }, { id: "b" }]);
  expect(first.fresh).toEqual([]);
  // One answered and one asked: the count stays the same, a new question still shows.
  const second = takeNew(first.seen, [{ id: "b" }, { id: "c" }]);
  expect(second.fresh).toEqual([{ id: "c" }]);
  // Nothing new: no notification, even when the count went up from an earlier dip.
  expect(takeNew(second.seen, [{ id: "b" }, { id: "c" }]).fresh).toEqual([]);
});
