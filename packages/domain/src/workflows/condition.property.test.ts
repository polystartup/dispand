import fc from "fast-check";
import { expect, test } from "vitest";
import { CONDITION_OPS, evaluateCondition, type ConditionOp } from "./condition.ts";
import { stored } from "../messages/index.ts";

type Side = { text: string; n: number | null };

/** Numbers written the way the examples are (`10`, `9.5`, ` -1 `), with the number they stand for. */
const numbers: fc.Arbitrary<Side> = fc
  .tuple(fc.integer({ min: -100_000, max: 100_000 }), fc.constantFrom(0, 1, 2), fc.nat({ max: 2 }))
  .map(([i, digits, pad]) => ({ text: `${" ".repeat(pad)}${(i / 10 ** digits).toFixed(digits)}${" ".repeat(pad)}`, n: i / 10 ** digits }));
/** Text no reading calls a number. */
const nonNumbers: fc.Arbitrary<Side> = fc
  .oneof(
    fc.constantFrom("", "  ", "abc", "NaN", "12px", "--1", "1.2.3", "x9", "oui", "é"),
    fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), minLength: 1, maxLength: 6 }),
  )
  .map((text) => ({ text, n: null }));
const sides = fc.oneof(numbers, nonNumbers);
/** Any text, and text the number comparisons parse. */
const texts = fc.oneof(
  fc.string({ unit: "binary", maxLength: 8 }),
  fc.string({ maxLength: 8 }),
  sides.map((s) => s.text),
);
/** A value and an operand: unrelated, the same, the same in capitals, a slice of the value, or two sides of a number comparison. */
const pairs = fc.oneof(
  fc.tuple(texts, texts),
  texts.map((v) => [v, v] as const),
  texts.map((v) => [v, v.toUpperCase()] as const),
  texts.chain((v) =>
    fc.tuple(
      fc.constant(v),
      fc.tuple(fc.nat({ max: v.length }), fc.nat({ max: v.length })).map(([i, j]) => v.slice(Math.min(i, j), Math.max(i, j))),
    ),
  ),
  fc.tuple(sides, sides).map(([a, b]) => [a.text, b.text] as const),
);

// Fixed seeds and few runs: the same inputs on every run, so a merge queue never meets a new one.

// condition.ts "Both sides are trimmed"
test("evaluateCondition gives the same result, error included, whatever whitespace surrounds either side", () => {
  const pad = fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r\n", "\u00a0", "\u2028", "\u3000", "\ufeff"), maxLength: 3 });
  fc.assert(
    fc.property(fc.constantFrom(...CONDITION_OPS), pairs, fc.tuple(pad, pad, pad, pad), (op, [value, operand], [p1, p2, p3, p4]) => {
      expect(evaluateCondition(op, `${p1}${value}${p2}`, `${p3}${operand}${p4}`)).toEqual(evaluateCondition(op, value, operand));
    }),
    { seed: 401, numRuns: 3_000 },
  );
});

const TEXT_OPS: ConditionOp[] = ["equals", "not_equals", "contains", "not_contains"];
// French letters, whose cases map one to one: lower-casing can't tell `ς` is `Σ` (it gives `σ`), nor `ᾀ` is `ἈΙ`.
const LOWER = "abcdefghijklmnopqrstuvwxyzàâæçéèêëîïôœùûüÿ";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZÀÂÆÇÉÈÊËÎÏÔŒÙÛÜŸ";
const letters = fc.array(fc.constantFrom(...LOWER, " ", "-", "'", "1"), { maxLength: 8 });
/** `chars` with each letter's case chosen at random. */
const recased = (chars: string[]) =>
  fc.tuple(...chars.map((c) => (LOWER.includes(c) ? fc.constantFrom(c, UPPER[LOWER.indexOf(c)]!) : fc.constant(c)))).map((cs) => cs.join(""));
/** A value and an operand (its own text or a slice of it), each written twice in different cases, and a slice of the value. */
const caseVariants = letters.chain((value) => {
  const slice = fc.tuple(fc.nat({ max: value.length }), fc.nat({ max: value.length })).map(([i, j]) => value.slice(Math.min(i, j), Math.max(i, j)));
  return fc
    .tuple(fc.oneof(letters, slice), slice)
    .chain(([operand, part]) => fc.tuple(recased(value), recased(value), recased(operand), recased(operand), recased(part)));
});

// condition.ts "text comparisons ignore case"; condition.test.ts [" Yes ", "yes"] and ["Hello World", "world"].
test("equals, not_equals, contains and not_contains ignore the case of French letters", () => {
  fc.assert(
    fc.property(fc.constantFrom(...TEXT_OPS), caseVariants, (op, [value, value2, operand, operand2, part]) => {
      expect(evaluateCondition(op, value, operand)).toEqual(evaluateCondition(op, value2, operand2));
      expect(evaluateCondition("equals", value, value2)).toEqual({ matched: true });
      expect(evaluateCondition("contains", `x ${value} x`, part)).toEqual({ matched: true });
    }),
    { seed: 402, numRuns: 2_000 },
  );
});

// condition.ts CONDITION_OPS: each "not_" op is named for the opposite of its pair ("equals" / "not_equals", "contains" / "not_contains", "is_empty" / "is_not_empty").
test("not_equals, not_contains and is_not_empty are the opposites of equals, contains and is_empty", () => {
  const opposites: [ConditionOp, ConditionOp][] = [
    ["equals", "not_equals"],
    ["contains", "not_contains"],
    ["is_empty", "is_not_empty"],
  ];
  fc.assert(
    fc.property(fc.constantFrom(...opposites), pairs, ([op, opposite], [value, operand]) => {
      const result = evaluateCondition(op, value, operand);
      expect(result).toEqual({ matched: expect.any(Boolean) });
      expect(evaluateCondition(opposite, value, operand)).toEqual({ matched: !("matched" in result && result.matched) });
    }),
    { seed: 403, numRuns: 3_000 },
  );
});

// apps/web/src/components/workflow/panels/ConditionPanel.tsx "Operators that ignore the operand." (is_empty, is_not_empty); condition.test.ts "ignored".
test("is_empty and is_not_empty ignore the operand", () => {
  fc.assert(
    fc.property(fc.constantFrom<ConditionOp>("is_empty", "is_not_empty"), texts, texts, texts, (op, value, operand, other) => {
      expect(evaluateCondition(op, value, operand)).toEqual(evaluateCondition(op, value, other));
    }),
    { seed: 404, numRuns: 1_000 },
  );
});

// condition.ts "A greater/less comparison needs two numbers: anything else is an error for the owner, never a silent "else"."; condition.test.ts ["10", "9.5"] true, "greater_than on a non-number is an error".
test("greater_than and less_than compare two numbers as numbers, and are an error naming the side that isn't one", () => {
  // The same number written again (`1` and `1.00`) half the time, so equal sides are reached.
  const operands = (value: Side) =>
    value.n === null
      ? sides
      : fc.oneof(
          sides,
          fc.constantFrom(2, 3).map((d) => ({ text: value.n!.toFixed(d), n: value.n })),
        );
  const notNumber = (side: Side) => ({ error: stored("engine.fail.notNumber", { text: side.text.trim() }) });
  fc.assert(
    fc.property(
      fc.constantFrom<ConditionOp>("greater_than", "less_than"),
      sides.chain((value) => fc.tuple(fc.constant(value), operands(value))),
      (op, [value, operand]) => {
        const result = evaluateCondition(op, value.text, operand.text);
        if (value.n !== null && operand.n !== null) expect(result).toEqual({ matched: op === "greater_than" ? value.n > operand.n : value.n < operand.n });
        else if (operand.n !== null) expect(result).toEqual(notNumber(value));
        else if (value.n !== null) expect(result).toEqual(notNumber(operand));
        // Neither is a number: the claim doesn't say which side the error names.
        else expect([notNumber(value), notNumber(operand)]).toContainEqual(result);
      },
    ),
    { seed: 405, numRuns: 3_000 },
  );
});
