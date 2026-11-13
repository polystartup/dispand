import { ORPCError } from "@orpc/server";
import type { HarnessCommand } from "@dispand/runner-protocol";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { agents, harnesses, runs, skillPackages, skills, stepRuns } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";

export type CommandEntry = { name: string; description: string; source: "harness" | "dispand"; skillId?: string };

/** The native catalog plus skills installed in this workspace, without duplicate invocations. */
export const assistantCommands = base.use(authed).input(z.object({ agentId: z.string(), runId: z.string().optional() })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN");
  const [agent] = await context.db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.ownerId, context.ownerId), eq(agents.builtIn, "assistant")));
  if (!agent) throw new ORPCError("NOT_FOUND");
  const [saved] = await context.db.select().from(harnesses).where(and(eq(harnesses.id, agent.harnessId), eq(harnesses.ownerId, context.ownerId)));
  let target = saved?.type === "cli" ? { runnerId: saved.runnerId!, kind: saved.kind as "codex" | "claude-code" } : null;
  let sessionId: string | undefined;
  if (input.runId) {
    const [run] = await context.db.select().from(runs).where(and(eq(runs.id, input.runId), eq(runs.ownerId, context.ownerId), eq(runs.agentId, agent.id)));
    if (!run) throw new ORPCError("NOT_FOUND");
    const steps = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, run.id));
    const step = steps.find((s) => s.start?.interactive);
    const historical = run.snapshot ? (await context.db.select().from(harnesses).where(and(eq(harnesses.id, run.snapshot.harnessId), eq(harnesses.ownerId, context.ownerId))))[0] : undefined;
    const h = step?.harness ?? (historical?.type === "cli" ? { runnerId: historical.runnerId!, kind: historical.kind as "codex" | "claude-code" } : undefined);
    target = h && !("type" in h && h.type === "cloud") && "runnerId" in h ? { runnerId: h.runnerId, kind: h.kind } : null;
    sessionId = run.status === "running" || run.status === "waiting" ? step?.sessionId ?? undefined : undefined;
  }
  let native: HarnessCommand[] = [];
  let nativeUnavailable = false;
  if (target) {
    try {
      const reply = await context.hub.commands(target.runnerId, { type: "commands.request", requestId: newId("commands"), harness: target.kind, ...(sessionId ? { sessionId } : {}) });
      if (reply.error || !reply.commands) throw new Error("Discovery failed");
      native = reply.commands;
    } catch { nativeUnavailable = true; }
  }
  const entries: CommandEntry[] = native.map((c) => ({ name: c.name, description: c.description, source: "harness" }));
  const installed = await context.db.select({ skillId: skills.id, name: skills.name, description: skills.description, package: skillPackages.name, packageId: skillPackages.id, pluginId: skillPackages.pluginId }).from(skills).innerJoin(skillPackages, eq(skillPackages.id, skills.packageId)).where(eq(skillPackages.ownerId, context.ownerId)).orderBy(asc(skillPackages.name), asc(skills.name));
  for (const skill of installed) {
    const name = `${skill.package}:${skill.name}`;
    const nativeNamespace = `dispand-${skill.pluginId ?? skill.packageId}`.toLowerCase().replace(/[._]/g, "-");
    const nativeIndex = native.findIndex((c) => [c.name, ...(c.aliases ?? [])].some((n) => n === name || n === `${nativeNamespace}:${skill.name}` || (n.startsWith(`${nativeNamespace}@`) && n.endsWith(`:${skill.name}`))));
    if (nativeIndex >= 0) entries[nativeIndex]!.skillId ??= skill.skillId;
    else entries.push({ name, description: skill.description, source: "dispand", skillId: skill.skillId });
  }
  return { entries, nativeUnavailable, skillsOnly: target?.kind === "codex" };
});
