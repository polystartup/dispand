import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ID } from "@dispand/runner-protocol";
import { artifacts as table, runs, workspaces } from "../db/schema.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { message } from "../messages/index.ts";
import { readableRun } from "../workspace/access.ts";
import { base, inPlacedScope, signedIn } from "../rpc/context.ts";

// The chat fetches generated code when its reader opens the artifact.
// Not a tool: a Job shows artifacts with `artifact_show` and never reads them back this way.

const notFound = () => new ORPCError("NOT_FOUND", message("artifacts.notFound"));

/** The generated code of an artifact in a Job the reader can open. */
const get = base
  .use(signedIn)
  .input(z.object({ id: z.string().min(1).max(ID) }))
  .handler(async ({ input, context }) => {
    // The artifact's workspace, from its run under SYSTEM; the read then runs there, once the reader is admitted.
    const [placed] = await inScope(SYSTEM, () => context.db.select({ organizationId: workspaces.organizationId, workspaceId: workspaces.id }).from(table)
      .innerJoin(runs, eq(runs.id, table.runId)).innerJoin(workspaces, eq(workspaces.id, runs.workspaceId)).where(eq(table.id, input.id)));
    return inPlacedScope(context, placed, notFound, async () => {
    const [row] = await context.db
      .select({ id: table.id, runId: table.runId, title: table.title, format: table.format, code: table.code, replaces: table.replaces, createdAt: table.createdAt })
      .from(table)
      .innerJoin(runs, eq(runs.id, table.runId))
      .where(and(eq(table.id, input.id), readableRun(context)));
    if (!row) throw notFound();
    return row;
    });
  });

export const artifacts = { get };
