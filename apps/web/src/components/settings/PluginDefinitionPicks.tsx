import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { api } from "../../lib/api.ts";
import { Check, Section, toggled } from "./PluginInstallSheet.tsx";
import { BUNDLE_TEXT } from "./JobRights.tsx";
import { TARGET_TEXT, WORKSPACE_LINE } from "./SelfLearning.tsx";

type Definition = Awaited<ReturnType<typeof api.plugins.preview>>["definitions"]["agents"][number];
/** An agent definition as the install's preview reads it (with its rights), or as the plugin's list shows it (with whether it is made). */
type AgentDefinition = Pick<Definition, "name" | "description"> & Partial<Pick<Definition, "bundles" | "tables" | "tools" | "consults" | "selfLearning">> & { harness?: Definition["harness"] | null; setUp?: boolean };
type Harness = Awaited<ReturnType<typeof api.harnesses.list>>[number];
/** A plugin's definitions, each with whether it is made already (none is, before the install). */
type Offered = { primitives: { name: string; setUp?: boolean }[]; agents: AgentDefinition[]; triggers: { name: string; agent: string; setUp?: boolean }[] };

/** What an agent definition's Jobs may do, in words: shown before it is made when no proposal shows it. */
export function AgentRights({ d }: { d: AgentDefinition }) {
  const { bundles = [], tools = [], consults = [], selfLearning = [] } = d;
  const lines = [
    `What its Jobs may do: ${bundles.length ? bundles.map((b) => BUNDLE_TEXT.find(([bundle]) => bundle === b)?.[1] ?? b).join(", ") : "nothing through Dispand's own tools"}`,
    `Tables: ${d.tables === undefined || d.tables === "all" ? "all of them" : d.tables.join(", ") || "none"}`,
    ...(tools.length ? [`Tools: ${tools.join(", ")}`] : []),
    ...(consults.length ? [`May consult: ${consults.map((c) => `${c.agent}${c.ask ? " (asks before use)" : ""}`).join(", ")}`] : []),
    ...(selfLearning.length ? [`Learns: ${selfLearning.map((t) => TARGET_TEXT.find(([target]) => target === t)?.[1] ?? t).join(", ")}`] : []),
  ];
  return (
    <ul aria-label={`What ${d.name} may do`} className="ml-7 space-y-0.5 text-[12px] text-muted">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
      {selfLearning.includes("workspace") && <li>{WORKSPACE_LINE}</li>}
    </ul>
  );
}

/**
 * The tables, agents and triggers to set up from a plugin, as `setUp` takes them: every table and
 * every agent not made yet ticked, each agent on a harness, each trigger with its agent. `rights`
 * shows what each ticked agent may do, for a sheet that has no proposal to show it.
 */
export function useDefinitionPicks(definitions: Offered, harnesses: Harness[] | undefined, rights = false) {
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
  const offered = triggers.filter((t) => !t.setUp && agents.some((d) => d.name.toLowerCase() === t.agent.toLowerCase() && (d.setUp || pickedAgents.has(d.name))));
  const triggerPicks = offered.filter((t) => !unticked.has(t.name)).map((t) => t.name);
  const pick = {
    primitives: primitives.map((d) => d.name).filter((n) => picked.has(n)),
    ...(agentPicks.length ? { agents: agentPicks } : {}),
    ...(triggerPicks.length ? { triggers: triggerPicks } : {}),
  };
  const any = pick.primitives.length > 0 || agentPicks.length > 0 || triggerPicks.length > 0;

  const sections = (
    <>
      {primitives.length > 0 && (
        <Section id="setup-tables" title="Tables">
          <ul className="space-y-1">
            {primitives.map((d) => (
              <li key={d.name}>
                <Check checked={picked.has(d.name)} onChange={() => setPicked((prev) => toggled(prev, d.name))} label={d.name} detail={d.setUp ? "Made: setting it up again adds what is missing" : "Not set up yet"} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {agents.length > 0 && (
        <Section id="setup-agents" title="Agents">
          <ul className="space-y-2">
            {agents.map((d) => (
              <li key={d.name} className="space-y-1">
                <Check
                  checked={pickedAgents.has(d.name)}
                  onChange={() => setPickedAgents((prev) => toggled(prev, d.name))}
                  label={d.name}
                  detail={[d.setUp ? "Made: it stays as you have it" : d.description || "Not set up yet", !rights && d.selfLearning?.length ? `Learns into: ${d.selfLearning.join(", ")}` : ""].filter(Boolean).join(" · ")}
                />
                {pickedAgents.has(d.name) && !d.setUp && harnesses && harnesses.length > 0 && (
                  <Select value={harnessOf(d) ?? ""} onValueChange={(id) => setChosen((prev) => ({ ...prev, [d.name]: id }))}>
                    <SelectTrigger aria-label={`Harness of ${d.name}`} className="ml-7 w-[calc(100%-1.75rem)]">
                      <SelectValue placeholder="Pick a harness" />
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
          {harnesses?.length === 0 && <p className="text-[13px] text-faint">Add a harness first to set up agents.</p>}
        </Section>
      )}
      {offered.length > 0 && (
        <Section id="setup-triggers" title="Triggers">
          <ul className="space-y-2">
            {offered.map((t) => (
              <li key={t.name}>
                <Check checked={!unticked.has(t.name)} onChange={() => setUnticked((prev) => toggled(prev, t.name))} label={t.name} detail={`Starts Jobs of ${t.agent}`} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
  return { pick, any, sections };
}
