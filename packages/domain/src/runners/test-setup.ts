import { afterEach } from "vitest";

// A test tagged pglite-only that no longer wraps PGlite's client would be skipped on PostgreSQL for nothing.
afterEach(({ task }) => {
  if (task.tags?.includes("pglite-only") && !(task.meta as { wrapsPglite?: boolean }).wrapsPglite) {
    throw new Error("Tagged pglite-only, but never wraps PGlite's client (pgliteClient): drop the tag.");
  }
});
