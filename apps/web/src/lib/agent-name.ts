import { qualifiedName } from "@dispand/domain/plugins/names";
import type { TFunction } from "i18next";

type Named = { name: string; builtIn?: string | null; plugin?: { name: string } | null };

/**
 * An agent's shown name: the built-in agent's label (`messages:agent.assistant.name`, whatever its
 * stored name), else its own, a plugin's under its plugin's name.
 */
export function shownAgentName(t: TFunction<"messages">, agent: Named): string {
  return agent.builtIn === "assistant" ? t("agent.assistant.name") : qualifiedName(agent.plugin?.name ?? null, agent.name);
}
