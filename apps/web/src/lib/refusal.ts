/** Why the server refused, when its error has one of `codes` (those whose message is written for a person); else `fallback`. */
export function refusal(e: unknown, fallback: string, codes: readonly string[] = ["BAD_REQUEST", "CONFLICT", "FORBIDDEN", "NOT_FOUND"]): string {
  const { code, message } = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; message?: unknown };
  return typeof code === "string" && codes.includes(code) && typeof message === "string" ? message : fallback;
}
