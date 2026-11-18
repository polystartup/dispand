/** The unique constraint a write broke ("" when the driver doesn't name it), or null for any other error. Drizzle wraps the driver's error in `cause`. */
export function uniqueConstraint(err: unknown): string | null {
  const e = err as { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } };
  const hit = e.code === "23505" ? e : e.cause?.code === "23505" ? e.cause : null;
  if (!hit) return null;
  return typeof hit.constraint === "string" ? hit.constraint : "";
}
