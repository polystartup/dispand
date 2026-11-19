import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ID } from "@dispand/runner-protocol";
import { artifacts as table, runs } from "../db/schema.ts";
import { message } from "../messages/index.ts";
import { readableRun } from "../workspace/access.ts";
import { base, signedIn } from "../rpc/context.ts";

// The chat fetches generated code when its reader opens the artifact.
// Not a tool: a Job shows artifacts with `artifact_show` and never reads them back this way.

/** The generated code of an artifact in a Job the reader can open. */
const get = base
  .use(signedIn)
  .input(z.object({ id: z.string().min(1).max(ID) }))
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .select({ id: table.id, runId: table.runId, title: table.title, format: table.format, code: table.code, replaces: table.replaces, createdAt: table.createdAt })
      .from(table)
      .innerJoin(runs, and(eq(runs.id, table.runId), eq(runs.ownerId, table.ownerId)))
      .where(and(eq(table.id, input.id), readableRun(context)));
    if (!row) throw new ORPCError("NOT_FOUND", message("artifacts.notFound"));
    return row;
  });

export const artifacts = { get };
