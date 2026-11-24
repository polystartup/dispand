import { ORPCError } from "@orpc/server";
import { errorKind } from "../log.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db } from "../db/client.ts";
import { plugins as pluginsTable } from "../db/schema.ts";
import { message } from "../messages/index.ts";
import { base, type InitialContext, manager, member } from "../rpc/context.ts";
import { PackageError, validatePackage } from "../skills/package.ts";
import { type Tx } from "../skills/procedures.ts";
import { GitError } from "./git.ts";
import { MarketplaceError } from "./marketplace.ts";
import { WellKnownError } from "./well-known.ts";
import { PluginError, type PluginContents } from "./read-plugin.ts";

/** Reading plugins and marketplaces is any member's; installing, updating, removing and deciding is a manager's. */
export const reader = base.use(member);
export const writer = base.use(manager);

const traces = tracer("plugins");

export const counts = meter("plugins");

/** An install, update, uninstall or table change applied in a span and a counter: its action, the plugin's id (none at an install) and how it ended; never a name or a value. */
export function acted<T>(action: "install" | "update" | "uninstall" | "applyTableChange", pluginId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return traces.startActiveSpan(`plugins.${action}`, { attributes: { "dispand.plugin.action": action, ...(pluginId ? { "dispand.plugin.id": pluginId } : {}) } }, async (span) => {
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
  });
}

/** A failure the owner can act on (a fetch, a marketplace or a plugin that isn't readable): BAD_REQUEST with its words. */
export function asBadRequest(e: unknown): never {
  if (e instanceof PackageError) throw new ORPCError("BAD_REQUEST", message(e.say.key, e.say.values));
  if (e instanceof GitError || e instanceof MarketplaceError || e instanceof PluginError || e instanceof WellKnownError) {
    throw new ORPCError("BAD_REQUEST", message(e.say.key, e.say.values));
  }
  throw e;
}

export const Id = z.object({ id: z.string().max(64) });

/** The package these files make, or BAD_REQUEST with the reason (an owner's file may not fit the plugin's new ones). */
export function validated(files: Parameters<typeof validatePackage>[0]) {
  try {
    return validatePackage(files);
  } catch (e) {
    return asBadRequest(e);
  }
}

/** The chosen skills' files, checked as one package (its caps); BAD_REQUEST for a name the plugin doesn't have. */
export function chosenSkills(contents: PluginContents, names: string[]) {
  const chosen = names.map((name) => {
    const skill = contents.skills.find((s) => s.name === name);
    if (!skill) throw new ORPCError("BAD_REQUEST", message("plugins.install.noSkill", { name }));
    return skill;
  });
  const files = chosen.flatMap((s) => s.files);
  try {
    return { files, skills: validatePackage(files).skills };
  } catch (e) {
    return asBadRequest(e);
  }
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
