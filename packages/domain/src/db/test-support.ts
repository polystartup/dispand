import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "./client.ts";
import * as schema from "./schema.ts";
import { currentScope, SYSTEM, type Ambient } from "./scope.ts";
import { testDb } from "../runners/test-support.ts";

type Statement = { scope: Ambient; sql: string; params: unknown[] };

/**
 * `db` (default: the worker's database, emptied) behind the no-scope guard: a statement sent with no ambient
 * scope throws, so a missed entry point fails its test. Every statement is recorded with its
 * scope; `register` maps fixture ids to their workspace, and `expectNoCrossScope` fails on a
 * statement whose parameters name an id of another workspace than its scope's.
 */
export async function recordScopes(db?: Db) {
  const { $client } = (db ?? (await testDb())) as unknown as { $client: PGlite };
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
