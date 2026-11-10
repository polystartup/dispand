// The domain's only logger. It logs a fixed whitelist and nothing derived from error text: Drizzle
// errors quote the SQL and its bound params (event payloads, tokens) in their message, params,
// cause and stack, and a runner-chosen value (a sessionId with "\nat …") can forge stack lines.
// So: the error's class name, its Postgres code and constraint, each only if it has the shape of
// one, and the runnerId.

const CLASS_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function shaped(value: unknown, shape: RegExp): string | undefined {
  return typeof value === "string" && shape.test(value) ? value : undefined;
}

function summarize(err: unknown) {
  if (!(err instanceof Error)) return { name: typeof err };
  const cause = (err as { cause?: unknown }).cause;
  const db = (cause instanceof Error ? cause : err) as Error & { code?: unknown; constraint?: unknown };
  return {
    name: shaped(err.name, CLASS_NAME) ?? "Error",
    ...(cause instanceof Error && { cause: shaped(cause.name, CLASS_NAME) ?? "Error" }),
    ...(shaped(db.code, SQLSTATE) && { code: db.code as string }),
    ...(shaped(db.constraint, IDENTIFIER) && { constraint: db.constraint as string }),
  };
}

/**
 * Logs `event` (a fixed string) with the runner it concerns, the server-made id of the row it
 * concerns (`ref`, never a runner-chosen value), and a data-free summary of `err`.
 */
export function logError(event: string, err: unknown, meta: { runnerId?: string; ref?: string } = {}): void {
  console.error(event, { ...(meta.runnerId && { runnerId: meta.runnerId }), ...(meta.ref && { ref: meta.ref }), error: summarize(err) });
}
