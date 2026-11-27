import fc from "fast-check";
import { expect, test } from "vitest";
import { references, renameReferences, renderTemplate, type Reference } from "./template.ts";

type Token = { text: string; ref?: Reference };

// Keys a rename can confuse (prefixes of each other) and names an object answers to by itself.
const KEYS = ["a", "ab", "a_2", "brief", "constructor", "__proto__"];
const FIELDS = ["x", "idea", "A1", "toString", "valueOf", "hasOwnProperty", "constructor", "__proto__"];
const pair: fc.Arbitrary<Reference> = fc.record({ key: fc.constantFrom(...KEYS), field: fc.constantFrom(...FIELDS) });
const spaces = fc.nat({ max: 2 }).map((n) => " ".repeat(n));
const refOf = (pairs: fc.Arbitrary<Reference>): fc.Arbitrary<Token> =>
  fc.tuple(pairs, spaces, spaces).map(([r, before, after]) => ({ text: `{{${before}${r.key}.${r.field}${after}}}`, ref: r }));
/** Text without braces, so it can't complete a reference with its neighbours. */
const filler: fc.Arbitrary<Token> = fc
  .string({ unit: fc.constantFrom("a", "A", "x", "1", "_", ".", " ", "\n", "é", "$", "&"), maxLength: 6 })
  .map((text) => ({ text }));
/**
 * Look like references and aren't, whatever is around them: no key or field (template.test.ts `{{not a var}}`),
 * a key no node can have (model.ts: `slugify` gives a-z, digits and `_`), or braces that don't pair.
 * No odd field (`{{a.x-y}}`): nothing but the regex says what a field may hold.
 */
const nearMiss: fc.Arbitrary<Token> = fc
  .constantFrom("{{not a var}}", "{{a}}", "{{A.x}}", "{{a.}}", "{{.x}}", "{{a.x}", "{a.x}}", "{ {a.x}}", "{{a.x} }", "{{é.x}}")
  .map((text) => ({ text }));
const promptsOf = (pairs: fc.Arbitrary<Reference>) => fc.array(fc.oneof(refOf(pairs), filler, nearMiss), { maxLength: 12 });
const prompts = promptsOf(pair);
const join = (tokens: Token[]) => tokens.map((t) => t.text).join("");
const refsOf = (tokens: Token[]) => tokens.flatMap((t) => (t.ref ? [t.ref] : []));

// Fixed seeds and few runs: the same inputs on every run, so a merge queue never meets a new one.

// template.ts "spaces allowed inside the braces"; "Every `{{key.field}}` in `prompt`, in order (repeats included)."; template.test.ts "{{not a var}}" isn't one.
test("references gives every {{key.field}} in order, repeats included, and nothing else", () => {
  fc.assert(
    fc.property(prompts, (tokens) => {
      expect(references(join(tokens))).toEqual(refsOf(tokens));
    }),
    { seed: 301, numRuns: 2_000 },
  );
});

/** Values for some of the pairs, built as own properties (`__proto__` included); a Map says which. */
const known = fc
  .uniqueArray(fc.tuple(pair, fc.oneof(fc.constantFrom("", "$&", "$1", "$$", "{{a.x}}", "{{ ab.idea }}", "}}"), fc.string({ maxLength: 4 }))), {
    selector: ([r]) => `${r.key}.${r.field}`,
    maxLength: 12,
  })
  .map((entries) => {
    const byKey = new Map<string, [string, string][]>();
    for (const [r, value] of entries) byKey.set(r.key, [...(byKey.get(r.key) ?? []), [r.field, value]]);
    const values = Object.fromEntries([...byKey].map(([key, fields]) => [key, Object.fromEntries(fields)])) as Record<string, Record<string, string>>;
    return { values, lookup: new Map(entries.map(([r, value]) => [`${r.key}.${r.field}`, value])), pairs: entries.map(([r]) => r) };
  });
/** Values, and a prompt that references some of their pairs and some others. */
const rendering = known.chain((k) => fc.tuple(fc.constant(k), promptsOf(k.pairs.length > 0 ? fc.oneof(fc.constantFrom(...k.pairs), pair) : pair)));

// template.ts "Replaces `{{key.field}}` with `values[key][field]`; an unknown variable stays visible as `{{key.field}}`."
test("renderTemplate replaces each known {{key.field}} with its value, as is, and writes an unknown one as {{key.field}}", () => {
  fc.assert(
    fc.property(rendering, ([{ values, lookup }, tokens]) => {
      const expected = tokens.map((t) => (t.ref ? (lookup.get(`${t.ref.key}.${t.ref.field}`) ?? `{{${t.ref.key}.${t.ref.field}}}`) : t.text)).join("");
      expect(renderTemplate(join(tokens), values)).toBe(expected);
    }),
    { seed: 302, numRuns: 2_000 },
  );
});

/** Values that know none of the pairs: what Object's own members (`constructor`, `toString`...) must not stand in for. */
const unknowing = fc.constantFrom<Record<string, Record<string, string>>>(
  {},
  Object.create(null) as Record<string, Record<string, string>>,
  Object.fromEntries(KEYS.map((key) => [key, {}])),
);
/** Any text, braces included, with references mixed in. */
const anyPrompts = fc
  .array(
    fc.oneof(
      refOf(pair),
      nearMiss,
      fc.string({ maxLength: 6 }).map((text) => ({ text })),
    ),
    { maxLength: 10 },
  )
  .map(join);

// template.ts "an unknown variable stays visible as `{{key.field}}`."
test("renderTemplate keeps every unknown variable visible, even one named like Object's own members", () => {
  fc.assert(
    fc.property(anyPrompts, unknowing, (prompt, values) => {
      const rendered = renderTemplate(prompt, values);
      expect(references(rendered)).toEqual(references(prompt));
      expect(renderTemplate(rendered, values)).toBe(rendered);
    }),
    { seed: 303, numRuns: 2_000 },
  );
});

// template.ts "Rewrites every `{{from.field}}` to `{{to.field}}`."; model.ts "every prompt's references follow the key".
test("renameReferences rewrites {{from.field}} to {{to.field}} and leaves the rest of the prompt as it was", () => {
  fc.assert(
    fc.property(prompts, fc.constantFrom(...KEYS), fc.constantFrom(...KEYS, "b", "step_2"), (tokens, from, to) => {
      const renamed = renameReferences(join(tokens), from, to);
      expect(references(renamed)).toEqual(refsOf(tokens).map((r) => (r.key === from ? { ...r, key: to } : r)));
      expect(renamed).toBe(tokens.map((t) => (t.ref?.key === from ? `{{${to}.${t.ref.field}}}` : t.text)).join(""));
    }),
    { seed: 304, numRuns: 2_000 },
  );
});
