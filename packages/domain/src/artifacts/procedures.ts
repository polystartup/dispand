import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ID } from "@dispand/runner-protocol";
import { artifacts as table } from "../db/schema.ts";
import { message } from "../messages/index.ts";
import { authed, base } from "../rpc/context.ts";

// The owner's generated artifacts: the chat fetches an artifact's code when its card shows.
// Not a tool: a Job shows artifacts with `artifact_show` and never reads them back this way.

/** One of the owner's artifacts, with its code. */
const get = base
  .use(authed)
  .input(z.object({ id: z.string().min(1).max(ID) }))
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .select({ id: table.id, runId: table.runId, title: table.title, format: table.format, code: table.code, replaces: table.replaces, createdAt: table.createdAt })
      .from(table)
      .where(and(eq(table.id, input.id), eq(table.ownerId, context.ownerId)));
    if (!row) throw new ORPCError("NOT_FOUND", message("artifacts.notFound"));
    return row;
  });

export const artifacts = { get };
