import { ORPCError } from "@orpc/server";
import { and, count, eq, inArray } from "drizzle-orm";
import { message, type MessageKey } from "../messages/index.ts";
import type { Db, Tx } from "./client.ts";
import { agents, attachments, skillPackages, tables, tools } from "./schema.ts";

/** The workspace rows an id kept in jsonb or text may name, with what a missing one answers. */
const KINDS = [
  [tables, "data.table.notFound"],
  [tools, "tools.notFound"],
  [attachments, "data.file.gone"],
  [agents, "agent.notFound"],
  [skillPackages, "agent.skillNotFound"],
] as const satisfies readonly (readonly [unknown, MessageKey])[];
type WorkspaceTable = (typeof KINDS)[number][0];

/**
 * Refuses (NOT_FOUND) unless every id names a row of `workspaceId`: the check a foreign key can't
 * make for ids kept in jsonb or text, run when the row holding them is written.
 */
export async function assertSameWorkspace(tx: Db | Tx, workspaceId: string, refs: { table: WorkspaceTable; ids: string[] }[]): Promise<void> {
  for (const { table, ids } of refs) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) continue;
    const [found] = await tx.select({ n: count() }).from(table).where(and(inArray(table.id, unique), eq(table.workspaceId, workspaceId)));
    if ((found?.n ?? 0) !== unique.length) throw new ORPCError("NOT_FOUND", message(KINDS.find(([t]) => t === table)![1]));
  }
}
