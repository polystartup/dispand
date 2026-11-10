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
