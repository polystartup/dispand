import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { METRICS } from "./metrics.ts";

// The example telemetry stack (`deploy/otel/`) names Dispand's metrics, labels and spans: each must
// still be one Dispand exports, so a rename fails here instead of leaving a silent alert or panel.
const EXAMPLE = join(import.meta.dirname, "../../../../deploy/otel");
const SOURCES = [join(import.meta.dirname, ".."), join(import.meta.dirname, "../../../../apps/web/src")];

const files = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
const examples = files(EXAMPLE).filter((file) => /\.(ya?ml|json)$/.test(file));
const occurrences = (pattern: RegExp) =>
  examples.flatMap((file) => [...readFileSync(file, "utf8").matchAll(pattern)].map((m) => ({ file: relative(EXAMPLE, file), name: m[1]! })));

/** Prometheus's names (`collector.yaml`): dots as underscores, a counter's `_total`, a duration's unit, a histogram's series. */
const prometheus = (name: string) => name.replaceAll(".", "_");
const SUFFIXES = ["", "_total", "_milliseconds", "_bucket", "_sum", "_count", "_milliseconds_bucket", "_milliseconds_sum", "_milliseconds_count"];
/** Each name a metric goes by in Prometheus, and the labels it carries there. */
const metrics = new Map(
  Object.entries(METRICS).flatMap(([name, attributes]) =>
    // `le`: a histogram bucket's bound, on its `_bucket` series only.
    SUFFIXES.map((suffix) => [prometheus(name) + suffix, new Set([...(suffix.endsWith("_bucket") ? ["le"] : []), ...attributes.map(prometheus)])] as const),
  ),
);
// `le`: a histogram's bucket bound.
const labels = new Set(["le", ...Object.values(METRICS).flat().map(prometheus)]);

test("every Dispand metric the example's alerts and dashboard read is one Dispand exports", () => {
  const used = occurrences(/\b(dispand_[a-z0-9_]+)/g).filter(({ name }) => !labels.has(name));
  expect(new Set(used.map((u) => u.name)).size).toBeGreaterThan(10);
  expect(used.filter(({ name }) => !metrics.has(name))).toEqual([]);
});

test("every label a selector matches is one its own metric carries", () => {
  const used = occurrences(/\b(dispand_[a-z0-9_]+\{[^}]*\})/g).flatMap(({ file, name }) => {
    const [, metric, matchers] = /^([a-z0-9_]+)\{(.*)\}$/.exec(name)!;
    return [...matchers!.matchAll(/([a-z_]+)\s*(?:=~|!~|!=|=)/g)].map((m) => ({ file, metric: metric!, label: m[1]! }));
  });
  expect(used.length).toBeGreaterThan(5);
  expect(used.filter(({ metric, label }) => !metrics.get(metric)?.has(label))).toEqual([]);
});

test("every label the example's alerts and dashboard read is an attribute its metrics carry", () => {
  const used = [
    // Selectors (`{dispand_result="failed"}`), groupings (`by (le, dispand_tool_kind)`), legends and annotations (`{{dispand_result}}`, `$labels.x`).
    ...occurrences(/[{,]\s*([a-z_]+)\s*(?:=~|!~|!=|=)\s*\\?"/g),
    ...occurrences(/\bby \(([^)]*)\)/g).flatMap(({ file, name }) => name.split(",").map((label) => ({ file, name: label.trim() }))),
    ...occurrences(/\{\{\s*([a-z_]+)\s*\}\}/g),
    ...occurrences(/\$labels\.([a-z_]+)/g),
  ];
  expect(used.length).toBeGreaterThan(10);
  expect(used.filter(({ name }) => !labels.has(name))).toEqual([]);
});

test("every span the example's README names is one Dispand makes", () => {
  const made = new Set(
    SOURCES.flatMap(files)
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/\.start(?:Active)?Span\(\s*"([^"]+)"|\b(?:inSpan|markSpan)\(\s*\w+,\s*"([^"]+)"/g)].map((m) => m[1] ?? m[2]!),
      ),
  );
  const readme = readFileSync(join(EXAMPLE, "README.md"), "utf8");
  const traces = readme.split("\n## Traces\n")[1]?.split("\n## ")[0] ?? "";
  const named = [...traces.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].map((m) => m[1]!).filter((name) => !name.startsWith("dispand."));
  expect(named.length).toBeGreaterThan(5);
  expect(named.filter((name) => !made.has(name))).toEqual([]);
});
