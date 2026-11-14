import type { PluginReport } from "@dispand/runner-protocol";
import { call, ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { harnesses, runners } from "../db/schema.ts";
import { newId } from "../ids.ts";
import type { InitialContext } from "../rpc/context.ts";
import { RunnerRequestFailed } from "../runners/hub.ts";
import { workspacePlugin } from "../runners/workspace-plugin.ts";

// A plugin installed natively on a harness follows the plugin: an update moves it to the new
// commit, as its owner installed it, with nothing of theirs to keep (the native copy is never
// overridden). Each move goes through the same native operations a person uses, preview first.

class StepFailed extends Error {}

type Context = InitialContext & { ownerId: string };
/** The harnesses holding the plugin natively, enabled, and what stays as it is: a runner that couldn't be asked, an install disabled or mid-change. */
export type NativeInstalls = { harnesses: { id: string; name: string }[]; unchecked: string[] };

/**
 * Where Dispand installed the plugin natively (`dispand-<plugin id>`): asked of each online runner.
 * Only an enabled, settled install follows: one its owner disabled stays disabled, and is named with
 * the runners that couldn't be asked.
 */
export async function nativeInstalls(context: Context, pluginId: string): Promise<NativeInstalls> {
  const cli = await context.db
    .select({ id: harnesses.id, name: harnesses.name, kind: harnesses.kind, runnerId: runners.id, runnerName: runners.name })
    .from(harnesses)
    .innerJoin(runners, eq(runners.id, harnesses.runnerId))
    .where(and(eq(harnesses.ownerId, context.ownerId), eq(runners.ownerId, context.ownerId), isNull(runners.revokedAt), inArray(harnesses.kind, ["claude-code", "codex"])))
    .orderBy(asc(harnesses.name));
  const found: NativeInstalls = { harnesses: [], unchecked: [] };
  for (const runnerId of [...new Set(cli.map((h) => h.runnerId))]) {
    const mine = cli.filter((h) => h.runnerId === runnerId);
    if (!context.hub.isOnline(runnerId)) {
      found.unchecked.push(mine[0]!.runnerName);
      continue;
    }
    const report = await context.hub
      .plugins(runnerId, { type: "plugin.request", requestId: newId("req"), operation: { action: "list" } })
      .then((r) => r.report)
      .catch((err: unknown) => {
        if (err instanceof RunnerRequestFailed) return { error: "unreachable" } as PluginReport;
        throw err;
      });
    if (report.error) {
      found.unchecked.push(mine[0]!.runnerName);
      continue;
    }
    // Harnesses of one kind on a runner share its native account: the first one names it.
    for (const binding of (report.packages ?? []).filter((p) => p.name === `dispand-${pluginId}`)) {
      const harness = mine.find((h) => h.kind === binding.harness);
      if (!harness || found.harnesses.some((h) => h.id === harness.id)) continue;
      if (binding.installed && binding.enabled === true && !binding.pending) found.harnesses.push({ id: harness.id, name: harness.name });
      else found.unchecked.push(`${harness.name} (disabled or changing there)`);
    }
  }
  return found;
}

/**
 * Moves the plugin's native install to the plugin's current commit on each harness the owner was
 * shown (`shown`) that still holds it: removed, then added again, each previewed then applied. A
 * shown harness where that fails, or that can't be asked now, and one holding it that wasn't
 * shown, are returned, with why.
 */
export async function moveNative(context: Context, pluginId: string, shown: string[]): Promise<{ name: string; reason: string }[]> {
  const installs = await nativeInstalls(context, pluginId);
  const leftBehind: { name: string; reason: string }[] = installs.harnesses.filter((h) => !shown.includes(h.id)).map((h) => ({ name: h.name, reason: "it wasn't on the update's screen" }));
  const gone = shown.filter((id) => !installs.harnesses.some((h) => h.id === id));
  if (gone.length) {
    for (const h of await context.db.select({ name: harnesses.name }).from(harnesses).where(and(inArray(harnesses.id, gone), eq(harnesses.ownerId, context.ownerId)))) {
      leftBehind.push({ name: h.name, reason: "its runner couldn't be asked, or the install changed since" });
    }
  }
  const step = async (harnessId: string, action: "add" | "remove") => {
    const request = { harnessIds: [harnessId], resource: { kind: "plugin" as const, id: pluginId }, action };
    const plan = await call(workspacePlugin, { ...request, dryRun: true }, { context });
    if (plan.error || plan.blocked || !plan.revision) throw new StepFailed(plan.error ?? "the native preview was blocked");
    const result = await call(workspacePlugin, { ...request, dryRun: false, revision: plan.revision }, { context });
    if (result.error || result.results?.some((r) => r.status === "failed")) throw new StepFailed(result.error ?? "the native step failed");
  };
  for (const harness of installs.harnesses.filter((h) => shown.includes(h.id))) {
    try {
      await step(harness.id, "remove");
      await step(harness.id, "add");
    } catch (err) {
      if (!(err instanceof ORPCError) && !(err instanceof StepFailed)) throw err;
      leftBehind.push({ name: harness.name, reason: err.message });
    }
  }
  return leftBehind;
}
