import { call } from "@orpc/server";
import { agents as agentProcedures } from "../agents/procedures.ts";
import type { InitialContext } from "../rpc/context.ts";
import { tools as toolProcedures } from "../tools/procedures.ts";
import { triggers as triggerProcedures } from "../triggers/procedures.ts";
import type { ElementKind } from "./overrides.ts";

/**
 * Writes fields of one of a plugin's agents, tools or triggers through the element's own update,
 * as a person's change on its page would be: checked, and recorded as an override when it isn't
 * the plugin's value. An agent is written whole, as it is now, with these fields over it.
 */
export async function writeFields(context: InitialContext & { ownerId: string }, kind: ElementKind, id: string, values: Record<string, unknown>): Promise<{ overridden: string[] }> {
  if (kind === "tool") return { overridden: (await call(toolProcedures.update, { id, ...values } as never, { context: context as never })).overridden };
  if (kind === "trigger") return { overridden: (await call(triggerProcedures.update, { id, ...values } as never, { context: context as never })).overridden };
  const a = await call(agentProcedures.get, { id }, { context: context as never });
  const whole = {
    id,
    name: a.name,
    description: a.description,
    harnessId: a.harnessId,
    systemPrompt: a.systemPrompt,
    ...(a.model === undefined ? {} : { model: a.model }),
    bundles: a.bundles,
    selfLearning: a.selfLearning,
    dataTables: a.dataTables,
    skillPackageIds: a.skills.map((s) => s.packageId),
    toolIds: a.tools.filter((t) => t.explicit).map((t) => t.toolId),
    consults: a.consults.map(({ agentId, ask }) => ({ agentId, ask })),
  };
  return { overridden: (await call(agentProcedures.update, { ...whole, ...values } as never, { context: context as never })).overridden };
}
