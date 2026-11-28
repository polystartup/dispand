import type { z } from "zod";

/** The first issue of each field of a failed parse, as `text(field)`; no issue, no entry. */
export function fieldErrors(error: z.ZodError | undefined, text: (field: string) => string): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const { path } of error?.issues ?? []) errors[String(path[0])] ??= text(String(path[0]));
  return errors;
}
