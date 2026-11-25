import { expect, test } from "vitest";
import { fileParts, joinParts, type Part, type Segment } from "./file-parts.ts";

const partsIn = (segments: Segment[]) => segments.filter((s): s is Part => typeof s !== "string");
/** The text each side's parts put back give: the three files again. */
const sides = (segments: Segment[]) => (["old", "mine", "next"] as const).map((k) => joinParts(segments, partsIn(segments).map((p) => p[k])));

test("a long file is cut around each change, a few lines of context each side, and its parts put back give each file again", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i}.\n`);
  const old = lines.join("");
  const mine = lines.map((l, i) => (i === 10 ? "Mine.\n" : l)).join("");
  const next = [...lines.slice(0, 900), "Added by the plugin.\n", ...lines.slice(900)].join("");
  const segments = fileParts(old, mine, next)!;
  expect(partsIn(segments)).toEqual([
    { old: lines.slice(7, 14).join(""), mine: [...lines.slice(7, 10), "Mine.\n", ...lines.slice(11, 14)].join(""), next: lines.slice(7, 14).join("") },
    { old: lines.slice(896, 903).join(""), mine: lines.slice(896, 903).join(""), next: [...lines.slice(896, 900), "Added by the plugin.\n", ...lines.slice(900, 903)].join("") },
  ]);
  expect(segments.length).toBe(5);
  expect(sides(segments)).toEqual([old, mine, next]);
});

test("Stem's merged parts go back between the shared lines; a part's text missing its line end gets one", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}.\n`);
  const old = lines.join("");
  const mine = lines.map((l, i) => (i === 50 ? "Mine.\n" : l)).join("");
  const next = lines.map((l, i) => (i === 50 ? "Theirs.\n" : l)).join("");
  const segments = fileParts(old, mine, next)!;
  const merged = [...lines.slice(47, 50), "Both.\n", ...lines.slice(51, 54)].join("").slice(0, -1);
  expect(joinParts(segments, [merged])).toBe([...lines.slice(0, 50), "Both.\n", ...lines.slice(51)].join(""));
  // One text per part, no more, no fewer.
  expect(joinParts(segments, [])).toBeNull();
  expect(joinParts(segments, [merged, merged])).toBeNull();
});

test("changes at either end, a missing last line end, empty files and changes that touch are cut and put back exactly", () => {
  const cases: [string, string, string][] = [
    ["a\nb\nc", "a\nb\nc\n", "z\na\nb\nc"],
    ["", "mine\n", "theirs"],
    ["a\nb\n", "", "a\nb\nc\n"],
    ["a\nb\nc\nd\n", "a\nX\nc\nd\n", "a\nb\nY\nd\n"],
    ["same\n".repeat(50), `top\n${"same\n".repeat(50)}`, `${"same\n".repeat(50)}bottom`],
  ];
  for (const [old, mine, next] of cases) expect(sides(fileParts(old, mine, next)!)).toEqual([old, mine, next]);
});

test("random edits on files of repeated lines are always cut so the parts give each file back", () => {
  let seed = 7;
  const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const words = ["", "a", "b", "---", "  ", "c"];
  const edit = (lines: string[]) => {
    const out = [...lines];
    for (let n = random(6); n > 0; n--) {
      const at = random(out.length + 1);
      if (random(2)) out.splice(at, random(4), ...Array.from({ length: random(3) }, () => `${words[random(words.length)]}\n`));
      else out.splice(at, 0, `${words[random(words.length)]}\n`);
    }
    return out.join("") + (random(4) ? "" : "no line end");
  };
  for (let round = 0; round < 300; round++) {
    const lines = Array.from({ length: random(60) }, () => `${words[random(words.length)]}\n`);
    const [old, mine, next] = [lines.join(""), edit(lines), edit(lines)];
    const segments = fileParts(old, mine, next)!;
    expect(sides(segments)).toEqual([old, mine, next]);
    // Shared text sits only between parts, never two in a row.
    expect(segments.some((s, i) => typeof s === "string" && typeof segments[i + 1] === "string")).toBe(false);
  }
});

test("a side that changed too much isn't cut", () => {
  const old = Array.from({ length: 3000 }, (_, i) => `Old ${i}.\n`).join("");
  const next = Array.from({ length: 3000 }, (_, i) => `New ${i}.\n`).join("");
  expect(fileParts(old, `${old}Mine.\n`, next)).toBeNull();
});
