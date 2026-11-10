import { expect, test } from "vitest";
import { type Cell, cellSchema, cellText, convertCells, type FieldSchema, parseCellText, typeHint } from "./fields.ts";

const field = (type: FieldSchema["type"], choices: FieldSchema["choices"] = []): FieldSchema => ({ id: `f_${type}`, name: type, type, choices });
const text = field("text");
const long = field("long-text");
const num = field("number");
const check = field("checkbox");
const date = field("date");
const url = field("url");
const files = field("attachment");
const status = field("single-select", [
  { id: "c_idea", label: "Idea" },
  { id: "c_live", label: "Live" },
]);
const ids = () => {
  let n = 0;
  return () => `c_${++n}`;
};

test("parseCellText accepts what an agent writes and refuses what doesn't fit", () => {
  expect(parseCellText(num, " 1 234,5 ")).toEqual({ ok: true, value: 1234.5 });
  expect(parseCellText(num, "lots")).toEqual({ ok: false, reason: "expected a number, got “lots”" });
  expect(parseCellText(num, "1e999").ok).toBe(false);
  expect(parseCellText(date, "2026-02-30").ok).toBe(false);
  expect(parseCellText(date, "2026-11-04T23:30:00+01:00")).toEqual({ ok: true, value: "2026-11-04" });
  expect(parseCellText(date, "tomorrow").ok).toBe(false);
  expect(parseCellText(check, "Yes")).toEqual({ ok: true, value: true });
  expect(parseCellText(check, "unchecked")).toEqual({ ok: true, value: false });
  expect(parseCellText(check, "maybe").ok).toBe(false);
  expect(parseCellText(url, "javascript:alert(1)").ok).toBe(false);
  expect(parseCellText(url, " https://example.com/a ")).toEqual({ ok: true, value: "https://example.com/a" });
  expect(parseCellText(status, " idea ")).toEqual({ ok: true, value: "c_idea" });
  expect(parseCellText(status, "Someday").ok).toBe(false);
  expect(parseCellText(files, "a.png").ok).toBe(false);
  expect(parseCellText(text, "")).toEqual({ ok: true, value: null });
  expect(parseCellText(files, "  ")).toEqual({ ok: true, value: null });
  expect(parseCellText(text, "x".repeat(10_001)).ok).toBe(false);
  expect(parseCellText(text, "a\u0000b").ok).toBe(false);
});

test("cellText writes each type the way parseCellText reads it back", () => {
  const cases: [FieldSchema, Cell][] = [
    [text, "hello"],
    [num, 1234.5],
    [check, true],
    [check, false],
    [date, "2026-11-04"],
    [url, "https://example.com/"],
    [status, "c_live"],
  ];
  for (const [f, v] of cases) expect(parseCellText(f, cellText(f, v))).toEqual({ ok: true, value: v });
  expect(cellText(status, "c_gone")).toBe("");
  expect(cellText(files, ["a_1", "a_2"], { a_1: "a.png", a_2: "b.png" })).toBe("a.png, b.png");
  expect(cellText(num, null)).toBe("");
});

test("convertCells: text to number clears what isn't a number and counts it", () => {
  expect(convertCells(["12", "about 20", null], text, num, ids())).toEqual({ cells: [12, null, null], cleared: 1, choices: [] });
});

test("convertCells: text to single-select makes one choice per distinct value", () => {
  const r = convertCells(["Idea", "Live", "idea", ""], text, { ...status, choices: [] }, ids());
  expect(r.choices.map((c) => c.label)).toEqual(["Idea", "Live"]);
  expect(r.cells).toEqual([r.choices[0]!.id, r.choices[1]!.id, r.choices[0]!.id, null]);
  expect(r.cleared).toBe(0);
});

test("convertCells: to single-select keeps existing choices and stops at 100", () => {
  const values = Array.from({ length: 101 }, (_, i) => `v${i}`);
  const r = convertCells(["Live", ...values], text, status, ids());
  expect(r.choices).toHaveLength(100);
  expect(r.choices.slice(0, 2)).toEqual(status.choices);
  expect(r.cells[0]).toBe("c_live");
  expect(r.cells.at(-1)).toBeNull();
  expect(r.cleared).toBe(3);
});

test("convertCells: anything to attachment clears, attachment to text keeps the names", () => {
  expect(convertCells(["a", null, "b"], text, files, ids())).toEqual({ cells: [null, null, null], cleared: 2, choices: [] });
  const names = { a_1: "a.png", a_2: "b.png" };
  expect(convertCells([["a_1", "a_2"], null], files, text, ids(), names)).toEqual({ cells: ["a.png, b.png", null], cleared: 0, choices: [] });
});

test("convertCells: long text past the text limit clears", () => {
  expect(convertCells(["x".repeat(10_001), "short"], long, text, ids())).toEqual({ cells: [null, "short"], cleared: 1, choices: [] });
});

test("convertCells: same type with a removed choice clears its cells", () => {
  const to = { ...status, choices: [status.choices[0]!] };
  expect(convertCells(["c_idea", "c_live", null], status, to, ids())).toEqual({ cells: ["c_idea", null, null], cleared: 1, choices: to.choices });
});

test("cellSchema refuses a choice id that isn't one, a NaN and a lone surrogate", () => {
  expect(cellSchema(status).safeParse("c_live").success).toBe(true);
  expect(cellSchema(status).safeParse("c_gone").success).toBe(false);
  expect(cellSchema(num).safeParse(Number.NaN).success).toBe(false);
  expect(cellSchema(num).safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  expect(cellSchema(num).safeParse("12").success).toBe(false);
  expect(cellSchema(text).safeParse("a\uD800b").success).toBe(false);
  expect(cellSchema(text).safeParse("x".repeat(10_001)).success).toBe(false);
  expect(cellSchema(date).safeParse("2026-02-30").success).toBe(false);
  expect(cellSchema(url).safeParse("ftp://example.com").success).toBe(false);
  expect(cellSchema(check).safeParse("true").success).toBe(false);
  expect(cellSchema(files).safeParse(Array.from({ length: 21 }, (_, i) => `a_${i}`)).success).toBe(false);
  for (const f of [text, long, num, check, date, url, files, status]) expect(cellSchema(f).safeParse(null).success).toBe(true);
});

test("typeHint lists the choices and stays within its bound", () => {
  expect(typeHint(num)).toBe("a number");
  expect(typeHint(status)).toBe("one of: Idea, Live");
  const many = { ...status, choices: Array.from({ length: 100 }, (_, i) => ({ id: `c_${i}`, label: `${i}`.padEnd(100, "x") })) };
  const hint = typeHint(many);
  expect(hint.length).toBeLessThanOrEqual(3000);
  expect(hint.endsWith("…")).toBe(true);
  const emoji = { ...status, choices: Array.from({ length: 100 }, (_, i) => ({ id: `c_${i}`, label: "😀".repeat(50) })) };
  expect(typeHint(emoji).isWellFormed()).toBe(true);
  const reason = parseCellText(num, `a${"😀".repeat(100)}`);
  expect(!reason.ok && reason.reason.isWellFormed()).toBe(true);
});
