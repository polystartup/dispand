import { PluginOperation, PluginReport, PluginSource } from "@dispand/runner-protocol";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { harnesses, plugins, runners, skillFiles, skillPackages, skills } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { base, manager } from "../rpc/context.ts";
import { RunnerRequestFailed } from "./hub.ts";
import { pluginNativeKey, workspaceNativeKey } from "../skills/native.ts";
import { message } from "../messages/index.ts";

export const workspaceSkills = base.use(manager).handler(async ({ context }) => {
  const packages = await context.db.select().from(skillPackages).where(eq(skillPackages.workspaceId, context.access.workspaceId)).orderBy(asc(skillPackages.name));
  const ids = packages.map((p) => p.id);
  const standalone = packages.filter((p) => !p.pluginId);
  const standaloneIds = standalone.map((p) => p.id);
  const files = standaloneIds.length ? await context.db.select().from(skillFiles).where(inArray(skillFiles.packageId, standaloneIds)) : [];
  const names = ids.length ? await context.db.select().from(skills).where(inArray(skills.packageId, ids)).orderBy(asc(skills.name)) : [];
  const pluginRows = await context.db.select().from(plugins).where(eq(plugins.workspaceId, context.access.workspaceId)).orderBy(asc(plugins.name));
  return [
    ...pluginRows.map((plugin) => {
      const sourceKey = pluginNativeKey(plugin);
      const packageIds = packages.filter((p) => p.pluginId === plugin.id).map((p) => p.id);
      return {
        resource: { kind: "plugin" as const, id: plugin.id }, name: plugin.name, nativeName: `dispand-${plugin.id}`, sourceKey,
        skills: names.filter((s) => packageIds.includes(s.packageId)).map((s) => s.name),
        unavailable: sourceKey ? null : "Native installation requires a verified Git plugin. Update older imports before installing.",
      };
    }),
    ...standalone.map((pkg) => ({
      resource: { kind: "skill" as const, id: pkg.id }, name: pkg.name, nativeName: `dispand-${pkg.id}`,
      sourceKey: workspaceNativeKey(files.filter((f) => f.packageId === pkg.id).map((f) => ({ path: f.path, base64: Buffer.from(f.content).toString("base64") }))),
      skills: names.filter((s) => s.packageId === pkg.id).map((s) => s.name), unavailable: null,
    })),
  ];
});

/** Whole plugin references keep its individual workspace skills from becoming duplicate installs. */
export const workspacePlugin = base.use(manager).input(z.object({
  harnessIds: z.array(z.string().min(1).max(64)).min(1).max(2).refine((ids) => new Set(ids).size === ids.length, "Duplicate harness"),
  resource: z.discriminatedUnion("kind", [z.object({ kind: z.literal("plugin"), id: z.string().max(64) }), z.object({ kind: z.literal("skill"), id: z.string().max(64) })]),
  action: z.enum(["add", "remove"]),
  dryRun: z.boolean(),
  revision: z.string().min(1).max(200).optional(),
}).refine((input) => input.dryRun || input.revision !== undefined, "Apply requires a native preview revision")
  .refine((input) => input.action === "add" || input.harnessIds.length === 1, "Uninstall one harness at a time")).handler(async ({ input, context }) => {
  const selected = await context.db.select({ runnerId: runners.id, kind: harnesses.kind, registrant: runners.ownerId }).from(harnesses)
    .innerJoin(runners, eq(runners.id, harnesses.runnerId))
    .where(and(inArray(harnesses.id, input.harnessIds), eq(harnesses.workspaceId, context.access.workspaceId), eq(runners.workspaceId, context.access.workspaceId), isNull(runners.revokedAt)))
    .orderBy(asc(harnesses.id));
  if (selected.length !== input.harnessIds.length || selected.some((h) => h.kind !== "claude-code" && h.kind !== "codex")) throw new ORPCError("NOT_FOUND", message("runners.harnessNotFound"));
  const runnerId = selected[0]!.runnerId;
  // What it installs runs under the runner's machine account: only the person who registered it installs there.
  if (selected[0]!.registrant !== context.actorId) throw new ORPCError("FORBIDDEN", message("runners.registrantOnly"));
  if (selected.some((h) => h.runnerId !== runnerId)) throw new ORPCError("BAD_REQUEST", message("runners.groupByRunner"));
  const targets = [...new Set(selected.map((h) => h.kind))];
  const common = { name: `dispand-${input.resource.id}`, targets, dryRun: input.dryRun, revision: input.revision };
  let operation: PluginOperation;
  let sourceKey: string | undefined;
  if (input.resource.kind === "plugin") {
    const [plugin] = await context.db.select().from(plugins).where(and(eq(plugins.id, input.resource.id), eq(plugins.workspaceId, context.access.workspaceId)));
    if (!plugin) throw new ORPCError("NOT_FOUND", message("plugins.notFound"));
    sourceKey = pluginNativeKey(plugin);
    if (input.action === "add") {
      if (!sourceKey || !PluginSource.safeParse(plugin.url).success || !plugin.sha || !plugin.entryName) throw new ORPCError("BAD_REQUEST", message("runners.noNativeSource"));
      operation = PluginOperation.parse({ action: "add", ...common, source: plugin.url, sourceRef: plugin.sha, plugin: plugin.entryName, ...(plugin.nativeRoot !== "." ? { sourcePath: plugin.nativeRoot } : {}) });
    } else operation = PluginOperation.parse({ action: "remove", ...common });
  } else {
    const [pkg] = await context.db.select().from(skillPackages).where(and(eq(skillPackages.id, input.resource.id), eq(skillPackages.workspaceId, context.access.workspaceId)));
    if (!pkg) throw new ORPCError("NOT_FOUND", message("agent.skillNotFound"));
    if (pkg.pluginId) throw new ORPCError("BAD_REQUEST", message("runners.wholePlugin"));
    const files = await context.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.packageId, pkg.id));
    sourceKey = workspaceNativeKey(files.map((f) => ({ path: f.path, base64: Buffer.from(f.content).toString("base64") })));
    operation = PluginOperation.parse(input.action === "add"
      ? { action: "add-workspace", ...common, files: files.map((f) => ({ path: f.path, base64: Buffer.from(f.content).toString("base64") })) }
      : { action: "remove", ...common });
  }
  try {
    const inventory = (await context.hub.plugins(runnerId, { type: "plugin.request", requestId: newId("req"), operation: { action: "list" } })).report;
    if (inventory.error) throw new ORPCError("CONFLICT", message("runners.refreshInventory"));
    const already: NonNullable<PluginReport["results"]> = [];
    let blocked = false;
    for (const kind of targets) {
      const bindings = inventory.packages?.filter((p) => p.harness === kind) ?? [];
      const active = bindings.find((p) => !!sourceKey && p.sourceKey === sourceKey && p.installed && p.enabled === true && !p.pending);
      if (input.action === "add" && active) {
        already.push({ name: active.name, harness: active.harness, status: "already_installed" });
        continue;
      }
      if (input.action === "add" && bindings.some((p) => p.name === common.name || (!!sourceKey && p.sourceKey === sourceKey))) {
        blocked = true;
      }
      if (input.action === "remove") {
        const matching = active ?? bindings.find((p) => p.name === common.name) ?? bindings.find((p) => !!sourceKey && p.sourceKey === sourceKey);
        if (matching) operation = PluginOperation.parse({ ...operation, name: matching.name });
      }
    }
    if (blocked) return PluginReport.parse({ blocked: true, results: already });
    const pending = targets.filter((kind) => !already.some((p) => p.harness === kind));
    if (!pending.length) return PluginReport.parse({ changes: already.map(({ name, harness }) => ({ name, harness, action: "already_installed" })), results: already });
    operation = PluginOperation.parse({ ...operation, targets: pending });
    const report = (await context.hub.plugins(runnerId, { type: "plugin.request", requestId: newId("req"), operation })).report;
    return already.length ? PluginReport.parse({ ...report, results: [...already, ...(report.results ?? [])] }) : report;
  } catch (error) {
    if (!(error instanceof RunnerRequestFailed)) throw error;
    throw new ORPCError("CONFLICT", message("runners.unavailable"));
  }
});
