import { storable } from "@dispand/runner-protocol";
import { z } from "zod";

// Pure: shared by the workflow model and the data modules, which the model imports, so it lives
// apart from both.

/**
 * Text that reaches a runner: within the protocol's bounds (prompts well under its `TEXT`, so
 * filled-in values have room) and storable (no NUL, no lone surrogate).
 */
export const StorableText = (max: number) =>
  z.string().max(max).refine(storable, "contains a character Dispand can't store (NUL or a lone surrogate)");

/** `s` made storable: NUL and lone surrogates become U+FFFD. */
export function storableText(s: string): string {
  return s.replaceAll("\u0000", "\uFFFD").toWellFormed();
}

/** `s` on one line, at most 255 characters: every control and line-breaking character becomes a space. How a file's name is shown to an agent. */
export function oneLine(s: string): string {
  return [...s].map((c) => { const n = c.codePointAt(0)!; return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 ? " " : c; }).join("").slice(0, 255);
}
