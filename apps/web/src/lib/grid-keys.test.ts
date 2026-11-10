import { expect, test } from "vitest";
import { nextCell } from "./grid-keys.ts";

const size = { rows: 3, cols: 4 };

test("arrows clamp at the edges", () => {
  expect(nextCell({ row: 0, col: 0 }, "ArrowUp", size)).toEqual({ row: 0, col: 0 });
  expect(nextCell({ row: 0, col: 0 }, "ArrowLeft", size)).toEqual({ row: 0, col: 0 });
  expect(nextCell({ row: 2, col: 3 }, "ArrowDown", size)).toEqual({ row: 2, col: 3 });
  expect(nextCell({ row: 2, col: 3 }, "ArrowRight", size)).toEqual({ row: 2, col: 3 });
  expect(nextCell({ row: 1, col: 1 }, "ArrowDown", size)).toEqual({ row: 2, col: 1 });
  expect(nextCell({ row: 1, col: 1 }, "Enter", size)).toEqual({ row: 2, col: 1 });
});

test("Tab wraps to the next row's first cell", () => {
  expect(nextCell({ row: 0, col: 2 }, "Tab", size)).toEqual({ row: 0, col: 3 });
  expect(nextCell({ row: 0, col: 3 }, "Tab", size)).toEqual({ row: 1, col: 0 });
  expect(nextCell({ row: 2, col: 3 }, "Tab", size)).toEqual({ row: 2, col: 3 });
  expect(nextCell({ row: 1, col: 0 }, "ShiftTab", size)).toEqual({ row: 0, col: 3 });
  expect(nextCell({ row: 0, col: 0 }, "ShiftTab", size)).toEqual({ row: 0, col: 0 });
});
