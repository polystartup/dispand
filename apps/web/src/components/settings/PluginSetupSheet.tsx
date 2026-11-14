import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ProposalItems } from "../questions/ProposalItems.tsx";
import { type api, orpc } from "../../lib/api.ts";
import { Check, refusal, Section, toggled } from "./PluginInstallSheet.tsx";

type Plugin = Awaited<ReturnType<typeof api.plugins.list>>[number];
type Outcome = Awaited<ReturnType<typeof api.plugins.setUp>>["outcomes"][number];

/** What an item is made from, in words: `primitive:Matters` is the table Matters. */
function madeFrom(o: Outcome): string {
  if (o.from?.startsWith("primitive:")) return `Table ${o.from.slice("primitive:".length)}`;
  if (o.from?.startsWith("field:")) return `Field ${o.from.slice("field:".length)}`;
  if (o.from?.startsWith("agent:")) return `Agent ${o.from.slice("agent:".length)}`;
  return o.tool === "tables_set_primitive" ? "Primitive table and parent" : o.tool;
}

const OUTCOMES: Record<Outcome["outcome"], string> = { made: "made", refused: "refused", "not made": "not made" };

/**
 * Sets a workspace up from a plugin's definitions: the owner ticks its tables and agents (each on a
 * harness), reads the items that will be made (as an Approval shows a proposal's), and makes them.
 * A run that stops keeps what it made; setting up again resumes. Mount it only while open.
 */
export function PluginSetupSheet({ plugin, onClose }: { plugin: Plugin; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { primitives, agents, triggers } = plugin.definitions;
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  // All ticked: a table made by a run that stopped may still lack its fields, and a run only adds what is missing.
  const [picked, setPicked] = useState(() => new Set(primitives.map((d) => d.name)));
  const [pickedAgents, setPickedAgents] = useState(() => new Set(agents.filter((d) => !d.setUp).map((d) => d.name)));
  const [chosen, setChosen] = useState<Record<string, string>>({});
  // The harness picked for an agent, else the first of the kind its definition is written for.
  const harnessOf = (d: (typeof agents)[number]) => chosen[d.name] ?? (harnesses.data?.find((h) => h.type === d.harness) ?? harnesses.data?.[0])?.id;
  const agentPicks = agents.flatMap((d) => {
    const harnessId = harnessOf(d);
    return pickedAgents.has(d.name) && harnessId ? [{ name: d.name, harnessId }] : [];
  });
  // A trigger goes with its agent: ticked while its agent is ticked or made, unless the owner unticks it.
  const [unticked, setUnticked] = useState(() => new Set<string>());
  // Names match as the server matches them: whatever their case.
  const offered = triggers.filter((t) => !t.setUp && agents.some((d) => d.name.toLowerCase() === t.agent.toLowerCase() && (d.setUp || pickedAgents.has(d.name))));
  const triggerPicks = offered.filter((t) => !unticked.has(t.name)).map((t) => t.name);
  const pick = { primitives: primitives.map((d) => d.name).filter((n) => picked.has(n)), ...(agentPicks.length ? { agents: agentPicks } : {}), ...(triggerPicks.length ? { triggers: triggerPicks } : {}) };
  const any = pick.primitives.length > 0 || agentPicks.length > 0 || triggerPicks.length > 0;
  const preview = useQuery({ ...orpc.plugins.setupPreview.queryOptions({ input: { id: plugin.id, pick } }), enabled: any, retry: false });
  const setUp = useMutation(
    orpc.plugins.setUp.mutationOptions({
      onSettled: () => Promise.all([orpc.plugins, orpc.tables, orpc.agents].map((procedures) => queryClient.invalidateQueries({ queryKey: procedures.key() }))),
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);

  async function submit() {
    if (!preview.data) return;
    setError(null);
    try {
      setOutcomes((await setUp.mutateAsync({ id: plugin.id, pick, reviewed: preview.data.reviewed })).outcomes);
    } catch (e) {
      setError(refusal(e, "Could not set the plugin up."));
    }
  }

  const items = preview.data?.items ?? [];
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">Set up {plugin.name}</SheetTitle>
          <SheetDescription>Pick the tables, agents and triggers to make from the plugin. They are the plugin's, listed under its name: what you change of them is yours and kept, and a table's rows are always yours.</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-6 pb-6">
          {outcomes ? (
            <Section id="setup-outcomes" title="What was made">
              {outcomes.length === 0 ? (
                <p className="text-[13px] text-muted">Everything picked was set up already.</p>
              ) : (
                <ol className="space-y-1 text-[13px]">
                  {outcomes.map((o) => (
                    <li key={o.$item}>
                      {madeFrom(o)}: <span className={o.outcome === "refused" ? "text-danger" : o.outcome === "made" ? "" : "text-faint"}>{OUTCOMES[o.outcome]}</span>
                      {o.error && <span className="block text-danger">{o.error}</span>}
                    </li>
                  ))}
                </ol>
              )}
              {outcomes.some((o) => o.outcome === "refused") && <p className="text-[13px] text-muted">What was made stays. Fix what stopped it, then set up again: it goes on from there.</p>}
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </Section>
          ) : (
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
                          detail={[d.setUp ? "Made: it stays as you have it" : d.description || "Not set up yet", d.selfLearning.length ? `Learns into: ${d.selfLearning.join(", ")}` : ""].filter(Boolean).join(" · ")}
                        />
                        {pickedAgents.has(d.name) && !d.setUp && harnesses.data && harnesses.data.length > 0 && (
                          <Select value={harnessOf(d) ?? ""} onValueChange={(id) => setChosen((prev) => ({ ...prev, [d.name]: id }))}>
                            <SelectTrigger aria-label={`Harness of ${d.name}`} className="ml-7 w-[calc(100%-1.75rem)]">
                              <SelectValue placeholder="Pick a harness" />
                            </SelectTrigger>
                            <SelectContent>
                              {harnesses.data.map((h) => (
                                <SelectItem key={h.id} value={h.id}>
                                  {h.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </li>
                    ))}
                  </ul>
                  {harnesses.data?.length === 0 && <p className="text-[13px] text-faint">Add a harness first to set up agents.</p>}
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
              {any && (
                <Section id="setup-items" title="What will be made">
                  {preview.error ? (
                    <p role="alert" className="text-[13px] text-danger">
                      {refusal(preview.error, "Could not read what would be made.")}
                    </p>
                  ) : !preview.data ? (
                    <p className="text-[13px] text-muted">Reading the definitions…</p>
                  ) : items.length === 0 ? (
                    <p className="text-[13px] text-muted">Nothing: what you picked is set up already.</p>
                  ) : (
                    <ProposalItems proposal={{ id: "", status: "draft", items, names: preview.data.names }} />
                  )}
                  {preview.data && preview.data.waiting.length > 0 && (
                    <ul aria-label="Not made" className="space-y-1 text-[13px]">
                      {preview.data.waiting.map((w, i) => (
                        <li key={i}>
                          <span className="font-medium">{w.definition}</span> <span className="text-muted">{w.reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              )}
              {error && (
                <p role="alert" className="text-[13px] text-danger">
                  {error}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button type="button" disabled={setUp.isPending || preview.isFetching || items.length === 0} onClick={() => void submit()}>
                  {setUp.isPending ? "Setting up…" : "Set up"}
                </Button>
                <Button type="button" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
