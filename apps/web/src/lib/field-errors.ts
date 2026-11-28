import type { z } from "zod";

/** The first issue of each field of a failed parse, as `text(field, issue)`; no issue, no entry. */
export function fieldErrors(error: z.ZodError | undefined, text: (field: string, issue: z.core.$ZodIssue) => string): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error?.issues ?? []) errors[String(issue.path[0])] ??= text(String(issue.path[0]), issue);
  return errors;
}
