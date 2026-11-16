import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { api } from "../../lib/api.ts";
import { Check, Section, toggled } from "./PluginInstallSheet.tsx";

type Definition = Awaited<ReturnType<typeof api.plugins.preview>>["definitions"]["agents"][number];
/** An agent definition as the install's preview reads it (with its rights), or as the plugin's list shows it (with whether it is made). */
type AgentDefinition = Pick<Definition, "name" | "description"> & Partial<Pick<Definition, "bundles" | "tables" | "tools" | "consults" | "selfLearning">> & { harness?: Definition["harness"] | null; setUp?: boolean };
type Harness = Awaited<ReturnType<typeof api.harnesses.list>>[number];
/** A plugin's definitions, each with whether it is made already (none is, before the install). */
type Offered = { primitives: { name: string; setUp?: boolean }[]; agents: AgentDefinition[]; triggers: { name: string; agent: string; setUp?: boolean }[] };

/** What an agent definition's Jobs may do, in words: shown before it is made when no proposal shows it. */
export function AgentRights({ d }: { d: AgentDefinition }) {
  const { t, i18n } = useTranslation(["plugins", "agents"]);
  const { list } = useFormat();
  const { bundles = [], tools = [], consults = [], selfLearning = [] } = d;
  const lines = [
    bundles.length ? t("picks.rights.bundles", { list: list(bundles.map((b) => (i18n.exists(`agents:rights.${b}.label`) ? t(`agents:rights.${b}.label`) : b))) }) : t("picks.rights.noBundles"),
    d.tables === undefined || d.tables === "all" ? t("picks.rights.allTables") : d.tables.length ? t("picks.rights.tables", { list: list(d.tables) }) : t("picks.rights.noTables"),
    ...(tools.length ? [t("picks.rights.tools", { list: list(tools) })] : []),
    ...(consults.length ? [t("picks.rights.consults", { list: list(consults.map((c) => (c.ask ? t("picks.rights.asks", { agent: c.agent }) : c.agent))) })] : []),
    ...(selfLearning.length ? [t("picks.rights.learns", { list: list(selfLearning.map((x) => (i18n.exists(`agents:learns.${x}.label`) ? t(`agents:learns.${x}.label`) : x))) })] : []),
  ];
  return (
    <ul aria-label={t("picks.rights.label", { name: d.name })} className="ml-7 space-y-0.5 text-[12px] text-muted">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
      {selfLearning.includes("workspace") && <li>{t("agents:learns.workspace.text")}</li>}
    </ul>
  );
}

/**
 * The tables, agents and triggers to set up from a plugin, as `setUp` takes them: every table and
 * every agent not made yet ticked, each agent on a harness, each trigger with its agent. `rights`
 * shows what each ticked agent may do, for a sheet that has no proposal to show it.
 */
export function useDefinitionPicks(definitions: Offered, harnesses: Harness[] | undefined, rights = false) {
  const { t } = useTranslation("plugins");
  const { list } = useFormat();
  const { primitives, agents, triggers } = definitions;
  // All ticked: a table made by a run that stopped may still lack its fields, and a run only adds what is missing.
  const [picked, setPicked] = useState(() => new Set(primitives.map((d) => d.name)));
  const [pickedAgents, setPickedAgents] = useState(() => new Set(agents.filter((d) => !d.setUp).map((d) => d.name)));
  const [chosen, setChosen] = useState<Record<string, string>>({});
  // The harness picked for an agent, else the first of the kind its definition is written for.
  const harnessOf = (d: AgentDefinition) => chosen[d.name] ?? (harnesses?.find((h) => h.type === d.harness) ?? harnesses?.[0])?.id;
  const agentPicks = agents.flatMap((d) => {
    const harnessId = harnessOf(d);
    return pickedAgents.has(d.name) && harnessId ? [{ name: d.name, harnessId }] : [];
  });
  // A trigger goes with its agent: ticked while its agent is ticked or made, unless the owner unticks it.
  const [unticked, setUnticked] = useState(() => new Set<string>());
  // Names match as the server matches them: whatever their case.
  const offered = triggers.filter((tr) => !tr.setUp && agents.some((d) => d.name.toLowerCase() === tr.agent.toLowerCase() && (d.setUp || pickedAgents.has(d.name))));
  const triggerPicks = offered.filter((tr) => !unticked.has(tr.name)).map((tr) => tr.name);
  const pick = {
    primitives: primitives.map((d) => d.name).filter((n) => picked.has(n)),
    ...(agentPicks.length ? { agents: agentPicks } : {}),
    ...(triggerPicks.length ? { triggers: triggerPicks } : {}),
  };
  const any = pick.primitives.length > 0 || agentPicks.length > 0 || triggerPicks.length > 0;

  const sections = (
    <>
      {primitives.length > 0 && (
        <Section id="setup-tables" title={t("picks.tables")}>
          <ul className="space-y-1">
            {primitives.map((d) => (
              <li key={d.name}>
                <Check checked={picked.has(d.name)} onChange={() => setPicked((prev) => toggled(prev, d.name))} label={d.name} detail={d.setUp ? t("picks.tableMade") : t("picks.notSetUp")} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {agents.length > 0 && (
        <Section id="setup-agents" title={t("picks.agents")}>
          <ul className="space-y-2">
            {agents.map((d) => (
              <li key={d.name} className="space-y-1">
                <Check
                  checked={pickedAgents.has(d.name)}
                  onChange={() => setPickedAgents((prev) => toggled(prev, d.name))}
                  label={d.name}
                  detail={[d.setUp ? t("picks.agentMade") : d.description || t("picks.notSetUp"), !rights && d.selfLearning?.length ? t("picks.learnsInto", { list: list(d.selfLearning) }) : ""].filter(Boolean).join(" · ")}
                />
                {pickedAgents.has(d.name) && !d.setUp && harnesses && harnesses.length > 0 && (
                  <Select value={harnessOf(d) ?? ""} onValueChange={(id) => setChosen((prev) => ({ ...prev, [d.name]: id }))}>
                    <SelectTrigger aria-label={t("picks.harnessOf", { name: d.name })} className="ml-7 w-[calc(100%-1.75rem)]">
                      <SelectValue placeholder={t("picks.pickHarness")} />
                    </SelectTrigger>
                    <SelectContent>
                      {harnesses.map((h) => (
                        <SelectItem key={h.id} value={h.id}>
                          {h.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {rights && pickedAgents.has(d.name) && !d.setUp && <AgentRights d={d} />}
              </li>
            ))}
          </ul>
          {harnesses?.length === 0 && <p className="text-[13px] text-faint">{t("picks.harnessFirst")}</p>}
        </Section>
      )}
      {offered.length > 0 && (
        <Section id="setup-triggers" title={t("picks.triggers")}>
          <ul className="space-y-2">
            {offered.map((tr) => (
              <li key={tr.name}>
                <Check checked={!unticked.has(tr.name)} onChange={() => setUnticked((prev) => toggled(prev, tr.name))} label={tr.name} detail={t("picks.startsJobs", { agent: tr.agent })} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
  return { pick, any, sections };
}
