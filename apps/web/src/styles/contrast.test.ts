import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const tokens = readFileSync(join(import.meta.dirname, "tokens.css"), "utf8");

/** The custom properties one block of tokens.css sets. */
function block(selector: string): Record<string, string> {
  const start = tokens.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in tokens.css`);
  const props: Record<string, string> = {};
  for (const [, name, value] of tokens.slice(start, tokens.indexOf("}", start)).matchAll(/(--[\w-]+): ([^;]+);/g)) props[name!] = value!;
  return props;
}

/** A token's `#rrggbb` or `rgba(r, g, b, a)` as [r, g, b, a]. */
function rgba(value: string | undefined): number[] {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value ?? "");
  if (hex) return [...hex.slice(1).map((h) => parseInt(h, 16)), 1];
  const parts = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(value ?? "");
  if (!parts) throw new Error(`Not #rrggbb or rgba(): ${value}`);
  return parts.slice(1).map(Number);
}

// A translucent colour over an opaque one as Chromium paints it: the alpha in 8 bits, and each
// channel on one of the two 8-bit steps around the blend. Both steps are returned, darker first:
// luminance rises with each channel, so if both pass, so does any mix of them.
const over = ([r, g, b, a]: number[], under: number[]) => {
  const alpha = Math.round(a! * 255) / 255;
  const blend = [r, g, b].map((c, i) => c! * alpha + under[i]! * (1 - alpha));
  return [blend.map(Math.floor), blend.map(Math.ceil)] as const;
};

// WCAG 2's relative luminance and contrast ratio.
const luminance = (rgb: number[]) =>
  [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
    const c = rgb[i]! / 255;
    return sum + weight * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  }, 0);
const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

// The success colour marks a succeeded status in 13px text, which AA asks 4.5:1 of, and a step's
// check and a runner's online dot (3:1), on the page, on cards and on hovered list rows.
test.each([
  ["light", ":root"],
  ["system's dark", ':root:not([data-theme="light"])'],
  ["chosen dark", ':root[data-theme="dark"]'],
])("the success colour has AA contrast in the %s theme", (_, selector) => {
  // What a dark block leaves out keeps its light value.
  const theme = { ...block(":root"), ...block(selector) };
  const surface = rgba(theme["--surface"]);
  const [darker, lighter] = over(rgba(theme["--surface-hover"]), surface);
  const backgrounds = { page: rgba(theme["--bg"]), card: surface, "hovered row": darker, "hovered row, a step lighter": lighter };
  for (const [name, under] of Object.entries(backgrounds)) expect(contrast(rgba(theme["--success"]), under), name).toBeGreaterThanOrEqual(4.5);
});
