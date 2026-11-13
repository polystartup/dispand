import { effectiveTools } from "@dispand/domain/agents/tools";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Lock, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { api } from "../../lib/api.ts";
import { orpc } from "../../lib/api.ts";
import { ConsultList, type ConsultEntry } from "./ConsultList.tsx";
import { ToolAsk } from "./ToolAsk.tsx";
import { CliRules } from "./CliRules.tsx";
import { JobRights, type Rights } from "./JobRights.tsx";
import { SelfLearning } from "./SelfLearning.tsx";
import { BannerSlot, Empty, FormField, NextStep } from "./parts.tsx";

export type Agent = Awaited<ReturnType<typeof api.agents.get>>;

/** Claude Code's model aliases; any other model id goes in "Other". */
const MODEL_ALIASES = ["opus", "sonnet", "haiku"];
const HARNESS_DEFAULT = "harness-default";
const OTHER = "other";

/** Why the server refused the change, when it says so for a person to read; else `fallback`. */
function refusal(e: unknown, fallback: string): string {
  const { code, message } = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; message?: unknown };
  const readable = (code === "FORBIDDEN" || code === "BAD_REQUEST") && typeof message === "string" && !message.startsWith("Input validation");
  return readable ? message : fallback;
}

/** Create (no `agent`) or edit an agent. A new agent goes back to the list; both offer the next step. */
export function AgentEditor({ agent, defaultHarnessId }: { agent?: Agent; defaultHarnessId?: string }) {
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const packages = useQuery(orpc.skills.list.queryOptions());
  const tools = useQuery(orpc.tools.list.queryOptions());
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.agents.key() });
  const create = useMutation(orpc.agents.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(orpc.agents.update.mutationOptions({ onSuccess: invalidate }));
  // Which actions of the agent's own tools ask before use: saved one by one, apart from the form.
  const toolAsk = useQuery({ ...orpc.agents.toolAsk.queryOptions({ input: { id: agent?.id ?? "" } }), enabled: agent !== undefined });
  const asks = new Map((toolAsk.data ?? []).map((t) => [t.toolId, t.actions]));
  const setPermission = useMutation(orpc.agents.setToolPermission.mutationOptions({ onSuccess: invalidate }));
  const cliRules = useQuery({ ...orpc.agents.cliRules.queryOptions({ input: { id: agent?.id ?? "" } }), enabled: agent !== undefined });
  const removeCliRule = useMutation(orpc.agents.removeCliRule.mutationOptions({ onSuccess: invalidate }));
  const [name, setName] = useState(agent?.name ?? "");
  const [harnessId, setHarnessId] = useState(agent?.harnessId ?? defaultHarnessId ?? "");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [modelChoice, setModelChoice] = useState(
    agent?.model === undefined ? HARNESS_DEFAULT : MODEL_ALIASES.includes(agent.model) ? agent.model : OTHER,
  );
  const [otherModel, setOtherModel] = useState(agent?.model !== undefined && !MODEL_ALIASES.includes(agent.model) ? agent.model : "");
  const harnessModel = harnesses.data?.find((h) => h.id === harnessId)?.model;
  const [skillPackageIds, setSkillPackageIds] = useState(agent?.skills.map((s) => s.packageId) ?? []);
  // Explicit tools only: the ones the skills require come with them.
  const [toolIds, setToolIds] = useState(agent?.tools.filter((t) => t.explicit).map((t) => t.toolId) ?? []);
  const chosen = (packages.data ?? []).filter((p) => skillPackageIds.includes(p.packageId));
  const agentTools = effectiveTools(
    toolIds,
    chosen.map((p) => ({ name: p.name, requiredToolIds: p.requiredTools.map((t) => t.id) })),
  )
    .map((t) => ({ ...t, name: tools.data?.find((row) => row.id === t.toolId)?.name ?? agent?.tools.find((row) => row.toolId === t.toolId)?.name ?? t.toolId }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const addable = (tools.data ?? []).filter((t) => !agentTools.some((a) => a.toolId === t.id));
  const tables = useQuery(orpc.tables.list.queryOptions());
  const agents = useQuery(orpc.agents.list.queryOptions());
  const [description, setDescription] = useState(agent?.description ?? "");
  const [consults, setConsults] = useState<ConsultEntry[]>(agent?.consults.map(({ agentId, ask }) => ({ agentId, ask })) ?? []);
  const [rights, setRights] = useState<Rights>({ bundles: agent?.bundles ?? [], dataTables: agent?.dataTables ?? "all" });
  const [selfLearning, setSelfLearning] = useState(agent?.selfLearning ?? []);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assistant = agent?.builtIn === "assistant";
  const busy = create.isPending || update.isPending;
  const navigate = useNavigate();

  if (harnesses.data && harnesses.data.length === 0) {
    return (
      <Empty title="Add a harness first" text="An agent runs on a harness, so connect one before creating the agent.">
        <Button asChild>
          <Link to="/settings/harnesses">Go to harnesses</Link>
        </Button>
      </Empty>
    );
  }

  async function save() {
    setError(null);
    setSaved(false);
    try {
      const model = modelChoice === HARNESS_DEFAULT ? undefined : modelChoice === OTHER ? otherModel.trim() : modelChoice;
      const fields = { name, description, harnessId, systemPrompt, skillPackageIds, toolIds, consults, selfLearning, ...rights, ...(model ? { model } : {}) };
      if (!agent) {
        await create.mutateAsync(fields);
        await navigate({ to: "/settings/agents", search: { saved: true } });
        return;
      }
      await update.mutateAsync({ ...fields, id: agent.id });
      setSaved(true);
    } catch (e) {
      setError(refusal(e, "Could not save the agent. Check the details and try again."));
    }
  }

  return (
    <>
      {agent && <BannerSlot>{saved && <AgentSaved />}</BannerSlot>}
      <form
        className="space-y-5 rounded-2xl bg-surface p-6 shadow-card"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {assistant && (
          <p className="text-[13px] text-muted">The workspace's Assistant: it can't be deleted. Its name, harness, model and instructions are yours to change.</p>
        )}
        {agent?.plugin && (
          <p className="text-[13px] text-muted">From the plugin {agent.plugin.name}: removing the plugin keeps it. Updating the plugin refreshes its system prompt.</p>
        )}
        <FormField label="Name" htmlFor="agent-name">
          <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus={!agent} />
        </FormField>
        <FormField label="Description" htmlFor="agent-description" hint="What it is for and when to consult it: agents that may consult it read this.">
          <Textarea id="agent-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={2} />
        </FormField>
        <FormField label="Harness" htmlFor="agent-harness">
          <Select value={harnessId} onValueChange={setHarnessId}>
            <SelectTrigger id="agent-harness" className="w-full">
              <SelectValue placeholder="Pick a harness" />
            </SelectTrigger>
            <SelectContent>
              {harnesses.data?.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {harnesses.error && !harnesses.data && (
          <p role="alert" className="text-[13px] text-danger">
            Could not load the harnesses. Reload the page to try again.
          </p>
        )}
        <FormField label="Model" htmlFor="agent-model" hint="Overrides the harness's default model for this agent.">
          <Select value={modelChoice} onValueChange={setModelChoice}>
            <SelectTrigger id="agent-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={HARNESS_DEFAULT}>Harness default ({harnessModel ?? "CLI default"})</SelectItem>
              {MODEL_ALIASES.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
              <SelectItem value={OTHER}>Other…</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        {modelChoice === OTHER && (
          <FormField label="Model id" htmlFor="agent-model-id" hint="A full model id, such as claude-sonnet-4-5.">
            <Input id="agent-model-id" value={otherModel} onChange={(e) => setOtherModel(e.target.value)} maxLength={100} required />
          </FormField>
        )}
        <section aria-labelledby="agent-skills" className="space-y-2">
          <h3 id="agent-skills" className="text-[13px] font-medium text-muted">
            Skills
          </h3>
          {packages.data?.length === 0 ? (
            <p className="text-[13px] text-faint">
              No skills yet. <Link to="/settings/skills" className="underline">Add one</Link> or install a plugin that brings some.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {packages.data?.map((p) => (
                <li key={p.packageId}>
                  <label className="flex items-start gap-3 px-3 py-2 text-[14px]">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={skillPackageIds.includes(p.packageId)}
                      disabled={assistant && p.builtIn}
                      onChange={(e) =>
                        setSkillPackageIds(e.target.checked ? [...skillPackageIds, p.packageId] : skillPackageIds.filter((id) => id !== p.packageId))
                      }
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{p.name}</span>
                      <span className="block text-[13px] text-muted">{p.plugin ? `From the plugin ${p.plugin.name}. ` : ""}{p.description}</span>
                      {assistant && p.builtIn && (
                        <span className="flex items-center gap-1.5 text-[13px] text-muted">
                          <Lock aria-hidden className="size-3.5" />
                          The Assistant keeps its platform skill.
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {packages.error && !packages.data && (
            <p role="alert" className="text-[13px] text-danger">
              Could not load the skills. Reload the page to try again.
            </p>
          )}
        </section>
        <section aria-labelledby="agent-tools" className="space-y-2">
          <h3 id="agent-tools" className="text-[13px] font-medium text-muted">
            Tools
          </h3>
          {agentTools.length === 0 ? (
            <p className="text-[13px] text-faint">No tools.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {agentTools.map((t) => (
                <li key={t.toolId} className="space-y-1.5 px-3 py-2 text-[14px]">
                  <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{t.name}</span>
                  {t.lockedBy.length > 0 ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted">
                      <Lock aria-hidden className="size-3.5" />
                      from skill {t.lockedBy.join(", ")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove ${t.name}`}
                      className="rounded p-0.5 text-muted hover:bg-hover"
                      onClick={() => setToolIds(toolIds.filter((id) => id !== t.toolId))}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                  </div>
                  {asks.get(t.toolId) ? (
                    <ToolAsk
                      tool={t.name}
                      actions={asks.get(t.toolId)!}
                      busy={setPermission.isPending}
                      onChange={(action, permission) => setPermission.mutate({ agentId: agent!.id, toolId: t.toolId, action, permission })}
                    />
                  ) : (
                    t.lockedBy.length === 0 && agent && toolAsk.isSuccess && <p className="text-[12px] text-faint">Save the agent to choose which of its actions ask before use.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {addable.length > 0 && (
            <Select value="" onValueChange={(id) => setToolIds([...toolIds, id])}>
              <SelectTrigger aria-label="Add a tool" className="w-full">
                <SelectValue placeholder="Add a tool" />
              </SelectTrigger>
              <SelectContent>
                {addable.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {tools.data?.length === 0 && (
            <p className="text-[13px] text-faint">
              <Link to="/settings/tools" className="underline">Add an MCP server</Link> to give agents tools.
            </p>
          )}
          {tools.error && !tools.data && (
            <p role="alert" className="text-[13px] text-danger">
              Could not load the tools. Reload the page to try again.
            </p>
          )}
        </section>
        {agent && <>
          {cliRules.data && <CliRules rules={cliRules.data} busy={removeCliRule.isPending} onRemove={(rule) => removeCliRule.mutate({ id: agent.id, cli: rule.cli, rule: rule.rule })} />}
          {cliRules.error && <p role="alert" className="text-[13px] text-danger">Could not load remembered CLI permissions. Reload the page to try again.</p>}
          {removeCliRule.error && <p role="alert" className="text-[13px] text-danger">Could not remove the CLI permission. Try again.</p>}
        </>}
        <JobRights
          rights={rights}
          tables={tables.data ?? []}
          onChange={setRights}
          {...(assistant ? { locked: "The Assistant always works on data and changes tables, on every table." } : {})}
        />
        <SelfLearning targets={selfLearning} onChange={setSelfLearning} />
        <ConsultList {...(agent ? { agentId: agent.id } : {})} bundles={rights.bundles} entries={consults} agents={agents.data ?? []} onChange={setConsults} />
        <FormField label="System prompt" htmlFor="agent-prompt" hint="What this agent is and how it works. Sent at the start of every session.">
          <Textarea
            id="agent-prompt"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            maxLength={100_000}
            rows={10}
            className="min-h-48 rounded-xl font-mono text-[13px]"
          />
        </FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !name.trim() || !harnessId}>
            {agent ? "Save" : "Create agent"}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/settings/agents">Back to agents</Link>
          </Button>
        </div>
      </form>
    </>
  );
}

export function AgentSaved() {
  return (
    <NextStep title="Agent saved.">
      <Button asChild>
        <Link to="/settings/workflows">Configure a manual workflow</Link>
      </Button>
    </NextStep>
  );
}
