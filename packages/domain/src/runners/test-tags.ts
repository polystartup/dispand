import type { TestTagDefinition } from "vitest";

/** The tests run on a PostgreSQL server (`test-support.ts`), not on PGlite. */
export const onPostgres = !!process.env.DISPAND_TEST_DATABASE_URL;

/**
 * The tests a PostgreSQL server (`DISPAND_TEST_DATABASE_URL`, `test-support.ts`) skips, by tag, each
 * for the reason its description gives: `test("…", { tags: ["pglite-only"] }, …)`. A tag no test
 * carries fails `test-tags.test.ts`, and a test's tag missing here fails it (Vitest's `strictTags`).
 */
export const testTags: TestTagDefinition[] = [
  { name: "pglite-only", description: "Wraps PGlite's client (`pgliteClient`): records its statements, holds its queries or sets its session.", skip: onPostgres },
  // A race or a bug PostgreSQL shows, until its issue is fixed: postgres-<issue>.
  { name: "postgres-468", description: "#468: expects 50 concurrent writes listed in the order they started.", skip: onPostgres },
];
