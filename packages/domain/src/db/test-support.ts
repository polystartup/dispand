import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { TestRunner } from "vitest";
import { onPostgres } from "../runners/test-tags.ts";
import type { Db } from "./client.ts";
import * as schema from "./schema.ts";
import { currentScope, SYSTEM, type Ambient } from "./scope.ts";
import { testDb } from "../runners/test-support.ts";

type Statement = { scope: Ambient; sql: string; params: unknown[] };

/**
 * `db`'s PGlite client, for a fixture that wraps it (records its statements, holds its queries, sets
 * its session). On a PostgreSQL server there is none: a domain test that needs it is tagged
 * `pglite-only`, which skips it there (`runners/test-tags.ts`).
 */
export function pgliteClient(db: Db): PGlite {
  if (onPostgres) throw new Error("This test wraps PGlite's client: tag it pglite-only (runners/test-tags.ts).");
  // For the check that every test so tagged needs it (`runners/test-setup.ts`).
  const test = TestRunner.getCurrentTest();
  if (test) (test.meta as { wrapsPglite?: boolean }).wrapsPglite = true;
  return (db as unknown as { $client: PGlite }).$client;
}

/**
 * `db` (default: the worker's database, emptied) behind the no-scope guard: a statement sent with no ambient
 * scope throws, so a missed entry point fails its test. Every statement is recorded with its
 * scope; `register` maps fixture ids to their workspace, and `expectNoCrossScope` fails on a
 * statement whose parameters name an id of another workspace than its scope's.
 */
export async function recordScopes(db?: Db) {
  const $client = pgliteClient(db ?? (await testDb()));
  const statements: Statement[] = [];
  const workspaceOf = new Map<string, string>();
  const logger = {
    logQuery(query: string, params: unknown[]) {
      const scope = currentScope();
      if (scope === undefined) throw new Error("database work outside a scope");
      statements.push({ scope, sql: query, params });
    },
  };
  return {
    db: drizzle($client, { schema, logger }) as unknown as Db,
    statements,
    register(id: string, workspaceId: string) {
      workspaceOf.set(id, workspaceId);
    },
    expectNoCrossScope() {
      for (const { scope, sql, params } of statements) {
        if (scope === SYSTEM || !scope.workspaceId) continue;
        const crossing = params.filter((p) => typeof p === "string" && workspaceOf.has(p) && workspaceOf.get(p) !== scope.workspaceId);
        if (crossing.length) throw new Error(`${sql} in workspace ${scope.workspaceId} touches ${crossing.join(", ")}`);
      }
    },
  };
}

/** The worker's database, emptied, behind the no-scope guard (`recordScopes`). */
export async function openGuardedDb(): Promise<Db> {
  return (await recordScopes()).db;
}
