import { ORPCError } from "@orpc/server";
import { errorKind } from "../log.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db } from "../db/client.ts";
import { plugins as pluginsTable } from "../db/schema.ts";
import { message } from "../messages/index.ts";
import { type InitialContext } from "../rpc/context.ts";
import { validatePackage } from "../skills/package.ts";
import { type Tx } from "../skills/procedures.ts";
import { type PluginContents } from "./read-plugin.ts";

const traces = tracer("plugins");

export const counts = meter("plugins");

/** An install, update, uninstall or table change applied in a span and a counter: its action, the plugin's id (none at an install) and how it ended; never a name or a value. */
export function acted<T>(
  action: "install" | "update" | "uninstall" | "applyTableChange" | "approveNative",
  pluginId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return traces.startActiveSpan(
    `plugins.${action}`,
    { attributes: { "dispand.plugin.action": action, ...(pluginId ? { "dispand.plugin.id": pluginId } : {}) } },
    async (span) => {
      let result = "done";
      try {
        return await fn();
      } catch (err) {
        result = "failed";
        recordError(span, errorKind(err));
        throw err;
      } finally {
        span.setAttribute("dispand.result", result);
        span.end();
        counts.counter("dispand.plugins.actions").add(1, { "dispand.plugin.action": action, "dispand.result": result });
      }
    },
  );
}

export const Id = z.object({ id: z.string().max(64) });

/** The chosen skills' files, checked as one package (its caps); BAD_REQUEST for a name the plugin doesn't have. */
export function chosenSkills(contents: PluginContents, names: string[]) {
  const chosen = names.map((name) => {
    const skill = contents.skills.find((s) => s.name === name);
    if (!skill) throw new ORPCError("BAD_REQUEST", message("plugins.install.noSkill", { name }));
    return skill;
  });
  const files = chosen.flatMap((s) => s.files);
  return { files, skills: validatePackage(files).skills };
}

export type PluginRow = typeof pluginsTable.$inferSelect;

/** What a plugin helper needs of its caller: who acts, and in which workspace (a person behind `member`, or a Job in its run's). */
export type PluginContext = InitialContext & { actorId: string; access: { workspaceId: string } };

export async function findPlugin(db: Db | Tx, workspaceId: string, id: string, lock = false): Promise<PluginRow> {
  const query = db
    .select()
    .from(pluginsTable)
    .where(and(eq(pluginsTable.id, id), eq(pluginsTable.workspaceId, workspaceId)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new ORPCError("NOT_FOUND", message("plugins.notFound"));
  return row;
}
