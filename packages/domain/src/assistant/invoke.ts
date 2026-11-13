import { ORPCError } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { skillsAndTools } from "../agents/skills-and-tools.ts";
import type { Db, Tx } from "../db/client.ts";
import { agents, harnesses, skillPackages, skills, tools, type AgentSnapshot } from "../db/schema.ts";

/** A person's explicit skill choice extends this conversation, never the permanent agent. */
export async function invokedSnapshot(db: Db | Tx, ownerId: string, snapshot: AgentSnapshot, skillId: string, runnerId?: string | null): Promise<{ snapshot: AgentSnapshot; invocation: string; packageId: string }> {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, snapshot.id), eq(agents.ownerId, ownerId), eq(agents.builtIn, "assistant")));
  if (!agent) throw new ORPCError("FORBIDDEN");
  const [skill] = await db.select({ name: skills.name, packageId: skillPackages.id, package: skillPackages.name, required: skillPackages.requiredToolIds }).from(skills).innerJoin(skillPackages, eq(skillPackages.id, skills.packageId)).where(and(eq(skills.id, skillId), eq(skillPackages.ownerId, ownerId)));
  if (!skill) throw new ORPCError("NOT_FOUND", { message: "Skill not found" });
  if (runnerId === undefined) runnerId = (await db.select().from(harnesses).where(eq(harnesses.id, snapshot.harnessId)))[0]?.runnerId ?? undefined;
  skill.required = [...new Set(skill.required)];
  const required = skill.required.length ? await db.select().from(tools).where(and(inArray(tools.id, skill.required), eq(tools.ownerId, ownerId))) : [];
  if (required.length !== skill.required.length || required.some((t) => t.kind === "runner" && t.runnerId !== runnerId)) throw new ORPCError("BAD_REQUEST", { message: "This skill requires tools unavailable on this harness." });
  const invokedSkills = [...new Set([...(snapshot.invokedSkills ?? []), skill.packageId])];
  const effective = await skillsAndTools(db, agent.id, invokedSkills);
  const selected = effective.skills.filter((s) => invokedSkills.includes(s.packageId));
  const combined = [...snapshot.skills.filter((s) => !invokedSkills.includes(s.packageId)), ...selected];
  if (combined.length > 50) throw new ORPCError("BAD_REQUEST", { message: "A conversation can load at most 50 skill packages." });
  return {
    snapshot: { ...snapshot, invokedSkills, skills: combined, tools: [...snapshot.tools, ...effective.tools.filter((t) => skill.required.includes(t.toolId) && !snapshot.tools.some((s) => s.toolId === t.toolId)).map(({ toolId, name }) => ({ toolId, name }))] },
    invocation: `${skill.package}:${skill.name}`,
    packageId: skill.packageId,
  };
}
