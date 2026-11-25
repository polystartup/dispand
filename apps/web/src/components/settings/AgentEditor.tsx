import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { effectiveTools } from "@dispand/domain/agents/tools";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Lock, X } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HarnessModelPicker } from "./HarnessModelPicker.tsx";
import { Textarea } from "@/components/ui/textarea";
import type { api } from "../../lib/api.ts";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { refusal } from "../../lib/refusal.ts";
import { ConsultList, type ConsultEntry, type ConsultMode } from "./ConsultList.tsx";
import { EscalationList, type EscalationEntry } from "./EscalationList.tsx";
import { ToolAsk } from "./ToolAsk.tsx";
import { CliRules } from "./CliRules.tsx";
import { NativePlugins } from "./NativePlugins.tsx";
import { JobRights, type Rights } from "./JobRights.tsx";
import { SelfLearning } from "./SelfLearning.tsx";
import { qualifiedName } from "@dispand/domain/plugins/names";
import { Overridden } from "./Overridden.tsx";
import { StemMarks } from "./StemMarks.tsx";
import { BannerSlot, Empty, FormField, NextStep } from "./parts.tsx";


const LEFT_OUT_KINDS = ["skills", "runnerTools"] as const;

export type Agent = Awaited<ReturnType<typeof api.agents.get>>;

/** A tool as its lists name it: a plugin's under its plugin's name, so it never reads as one of the owner's. */
const toolLabel = (tool: { name: string; plugin: { name: string } | null } | undefined) => tool && qualifiedName(tool.plugin?.name ?? null, tool.name);

/** Why the server refused the change, when it says so for a person to read; else `fallback`. */
const reason = (e: unknown, fallback: string) => refusal(e, fallback, ["FORBIDDEN", "BAD_REQUEST"]);

/** Create (no `agent`) or edit an agent. A new agent goes back to the list; both offer the next step. */
export function AgentEditor({ agent, defaultHarnessId, onReset }: { agent?: Agent; defaultHarnessId?: string; /** A field went back to its plugin's value: the form is stale. */ onReset?: () => void }) {
  const { t } = useTranslation("agents");
  const { t: tm } = useTranslation("messages");
  const { t: tc } = useTranslation();
  const assistantName = tm("agent.assistant.name");
  // The fields a plugin gives an agent, as this form names them.
  const fieldLabels = t("fields", { returnObjects: true });
  const format = useFormat();
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const packages = useQuery(orpc.skills.list.queryOptions());
  const tools = useQuery(orpc.tools.list.queryOptions());
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.agents.key() });
  const create = useMutation(orpc.agents.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(orpc.agents.update.mutationOptions({ onSuccess: invalidate }));
  const reset = useMutation(orpc.plugins.resetOverride.mutationOptions({ onSuccess: async () => { await invalidate(); onReset?.(); } }));
  // Which actions of the agent's own tools ask before use: saved one by one, apart from the form.
  const toolAsk = useQuery({ ...orpc.agents.toolAsk.queryOptions({ input: { id: agent?.id ?? "" } }), enabled: agent !== undefined });
  const asks = new Map((toolAsk.data ?? []).map((t) => [t.toolId, t.actions]));
  const setPermission = useMutation(orpc.agents.setToolPermission.mutationOptions({ onSuccess: invalidate }));
  const cliRules = useQuery({ ...orpc.agents.cliRules.queryOptions({ input: { id: agent?.id ?? "" } }), enabled: agent !== undefined });
  const removeCliRule = useMutation(orpc.agents.removeCliRule.mutationOptions({ onSuccess: invalidate }));
  const [name, setName] = useState(agent?.name ?? "");
  const [harnessId, setHarnessId] = useState(agent?.harnessId ?? defaultHarnessId ?? "");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [skillPackageIds, setSkillPackageIds] = useState(agent?.skills.map((s) => s.packageId) ?? []);
  // Explicit tools only: the ones the skills require come with them.
  const [toolIds, setToolIds] = useState(agent?.tools.filter((t) => t.explicit).map((t) => t.toolId) ?? []);
  const chosen = (packages.data ?? []).filter((p) => skillPackageIds.includes(p.packageId));
  const agentTools = effectiveTools(
    toolIds,
    chosen.map((p) => ({ name: p.name, requiredToolIds: p.requiredTools.map((t) => t.id) })),
  )
    .map((t) => ({ ...t, name: toolLabel(tools.data?.find((row) => row.id === t.toolId)) ?? agent?.tools.find((row) => row.toolId === t.toolId)?.name ?? t.toolId }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const addable = (tools.data ?? []).filter((t) => !agentTools.some((a) => a.toolId === t.id));
  const tables = useQuery(orpc.tables.list.queryOptions());
  const agents = useQuery(orpc.agents.list.queryOptions());
  const [description, setDescription] = useState(agent?.description ?? "");
  const [consults, setConsults] = useState<ConsultEntry[]>(agent?.consults.map(({ agentId }) => ({ agentId })) ?? []);
  const [consultMode, setConsultMode] = useState<ConsultMode>(agent?.consultMode ?? "disabled");
  const people = useQuery(orpc.agents.people.queryOptions());
  const [escalations, setEscalations] = useState<EscalationEntry[]>(agent?.escalations ?? []);
  const [escalateMode, setEscalateMode] = useState<ConsultMode>(agent?.escalateMode ?? "disabled");
  const [preferAgents, setPreferAgents] = useState(agent?.preferAgents ?? false);
  const [rights, setRights] = useState<Rights>({ bundles: agent?.bundles ?? [], dataTables: agent?.dataTables ?? "all" });
  const [selfLearning, setSelfLearning] = useState(agent?.selfLearning ?? []);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assistant = agent?.builtIn === "assistant";
  const busy = create.isPending || update.isPending;
  // What its CLI sessions will leave out: as the last save returned it, else as the page read it.
  const leftOut = (update.data ?? agent)?.leftOut;
  const navigate = useNavigate();

  if (harnesses.data && harnesses.data.length === 0) {
    return (
      <Empty title={t("editor.noHarnessTitle")} text={t("editor.noHarnessText")}>
        <Button asChild>
          <Link to="/settings/harnesses">{t("editor.toHarnesses")}</Link>
        </Button>
      </Empty>
    );
  }

  async function save() {
    setError(null);
    setSaved(false);
    try {
      const fields = { name, description, harnessId, systemPrompt, skillPackageIds, toolIds, consultMode, consults, escalateMode, escalations: escalations.map(({ userId }) => ({ userId })), preferAgents, selfLearning, ...rights, ...(model ? { model } : {}) };
      if (!agent) {
        const created = await create.mutateAsync(fields);
        // What its CLI sessions will leave out is told on its page.
        if ("leftOut" in created) await navigate({ to: "/settings/agents/$id", params: { id: created.id } });
        else await navigate({ to: "/settings/agents", search: { saved: true } });
        return;
      }
      await update.mutateAsync({ ...fields, id: agent.id });
      setSaved(true);
    } catch (e) {
      setError(reason(e, t("editor.saveFailed")));
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
          <p className="text-[13px] text-muted">{t("editor.builtIn", { assistant: assistantName })}</p>
        )}
        {agent?.plugin && (
          <>
            <Overridden plugin={agent.plugin.name} overridden={agent.overridden} labels={fieldLabels} busy={reset.isPending} onReset={(field) => reset.mutate({ kind: "agent", id: agent.id, field })} />
            <StemMarks kind="agent" id={agent.id} labels={fieldLabels} onResolved={() => onReset?.()} />
          </>
        )}
        {reset.error && <p role="alert" className="text-[13px] text-danger">{reason(reset.error, t("editor.resetFailed"))}</p>}
        <FormField label={t("editor.name")} htmlFor="agent-name">
          {/* The built-in agent shows its label; its stored name never changes here. */}
          <Input id="agent-name" value={assistant ? assistantName : name} readOnly={assistant} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus={!agent} />
        </FormField>
        <FormField label={t("editor.description")} htmlFor="agent-description" hint={t("editor.descriptionHint")}>
          <Textarea id="agent-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={2} />
        </FormField>
        <HarnessModelPicker harnessId={harnessId} model={model} onChange={(id, next) => { setHarnessId(id); setModel(next); }} />
        <section aria-labelledby="agent-skills" className="space-y-2">
          <h3 id="agent-skills" className="text-[13px] font-medium text-muted">
            {t("editor.skills")}
          </h3>
          {packages.data?.length === 0 ? (
            <p className="text-[13px] text-faint">
              <Trans t={t} i18nKey="editor.noSkills" components={[<Link to="/settings/skills" className="underline" />]} />
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
                      <span className="block text-[13px] text-muted">{p.plugin ? `${t("editor.fromPlugin", { plugin: p.plugin.name })} ` : ""}{p.description}</span>
                      {assistant && p.builtIn && (
                        <span className="flex items-center gap-1.5 text-[13px] text-muted">
                          <Lock aria-hidden className="size-3.5" />
                          {t("editor.keepsSkill", { assistant: assistantName })}
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
              {t("editor.skillsFailed")}
            </p>
          )}
        </section>
        <section aria-labelledby="agent-tools" className="space-y-2">
          <h3 id="agent-tools" className="text-[13px] font-medium text-muted">
            {t("editor.tools")}
          </h3>
          {agentTools.length === 0 ? (
            <p className="text-[13px] text-faint">{t("editor.noTools")}</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {agentTools.map((tool) => (
                <li key={tool.toolId} className="space-y-1.5 px-3 py-2 text-[14px]">
                  <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{tool.name}</span>
                  {tool.lockedBy.length > 0 ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted">
                      <Lock aria-hidden className="size-3.5" />
                      {t("editor.fromSkill", { skills: format.list(tool.lockedBy) })}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={t("editor.removeTool", { name: tool.name })}
                      className="rounded p-0.5 text-muted hover:bg-hover"
                      onClick={() => setToolIds(toolIds.filter((id) => id !== tool.toolId))}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                  </div>
                  {asks.get(tool.toolId) ? (
                    <ToolAsk
                      tool={tool.name}
                      actions={asks.get(tool.toolId)!}
                      busy={setPermission.isPending}
                      onChange={(action, permission) => setPermission.mutate({ agentId: agent!.id, toolId: tool.toolId, action, permission })}
                    />
                  ) : (
                    tool.lockedBy.length === 0 && agent && toolAsk.isSuccess && <p className="text-[12px] text-faint">{t("editor.saveToChoose")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {addable.length > 0 && (
            <Select value="" onValueChange={(id) => setToolIds([...toolIds, id])}>
              <SelectTrigger aria-label={t("editor.addTool")} className="w-full">
                <SelectValue placeholder={t("editor.addTool")} />
              </SelectTrigger>
              <SelectContent>
                {addable.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {toolLabel(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {tools.data?.length === 0 && (
            <p className="text-[13px] text-faint">
              <Trans t={t} i18nKey="editor.noMcp" components={[<Link to="/settings/tools" className="underline" />]} />
            </p>
          )}
          {tools.error && !tools.data && (
            <p role="alert" className="text-[13px] text-danger">
              {t("editor.toolsFailed")}
            </p>
          )}
        </section>
        {agent && <>
          <NativePlugins agentId={agent.id} />
          {cliRules.data && <CliRules rules={cliRules.data} busy={removeCliRule.isPending} onRemove={(rule) => removeCliRule.mutate({ id: agent.id, cli: rule.cli, rule: rule.rule })} />}
          {cliRules.error && <p role="alert" className="text-[13px] text-danger">{t("editor.cliRulesFailed")}</p>}
          {removeCliRule.error && <p role="alert" className="text-[13px] text-danger">{t("editor.cliRuleRemoveFailed")}</p>}
        </>}
        <JobRights
          rights={rights}
          tables={(tables.data ?? []).map((t) => ({ id: t.id, name: qualifiedName(t.plugin?.name ?? null, t.name) }))}
          onChange={setRights}
          {...(assistant ? { locked: t("editor.rightsLocked", { assistant: assistantName }) } : {})}
        />
        <SelfLearning targets={selfLearning} onChange={setSelfLearning} />
        <ConsultList {...(agent ? { agentId: agent.id } : {})} bundles={rights.bundles} mode={consultMode} entries={consults} agents={agents.data ?? []} onModeChange={setConsultMode} onChange={setConsults} />
        <EscalationList mode={escalateMode} entries={escalations} members={people.data ?? []} onModeChange={setEscalateMode} onChange={setEscalations} />
        {/* Shown only when it may ask both; hidden, it keeps its value. */}
        {consultMode !== "disabled" && escalateMode !== "disabled" && (
          <label className="flex items-start justify-between gap-3 text-[14px]">
            <span>
              {t("preferAgents.label")}
              <span className="block text-[12px] text-faint">{t("preferAgents.text")}</span>
            </span>
            <input type="checkbox" role="switch" aria-label={t("preferAgents.label")} checked={preferAgents} onChange={(e) => setPreferAgents(e.target.checked)} className="mt-1 size-4 accent-[var(--color-accent)]" />
          </label>
        )}
        <FormField label={t("editor.systemPrompt")} htmlFor="agent-prompt" hint={t("editor.systemPromptHint")}>
          <Textarea
            id="agent-prompt"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            maxLength={100_000}
            rows={10}
            className="min-h-48 rounded-xl font-mono text-[13px]"
          />
        </FormField>
        {leftOut &&
          LEFT_OUT_KINDS.map(
            (kind) =>
              leftOut[kind].names.length > 0 && (
                <p key={kind} role="status" className="text-[13px] text-danger">
                  {tc(`agent.leftOut.${kind}`, { count: leftOut[kind].names.length, max: leftOut[kind].max, names: format.list(leftOut[kind].names) })}
                </p>
              ),
          )}
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !name.trim() || !harnessId}>
            {agent ? t("editor.save") : t("editor.create")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/settings/agents">{t("editor.back")}</Link>
          </Button>
        </div>
      </form>
    </>
  );
}

export function AgentSaved() {
  const { t } = useTranslation("agents");
  return (
    <NextStep title={t("editor.saved")}>
      <Button asChild>
        <Link to="/settings/workflows">{t("editor.nextWorkflow")}</Link>
      </Button>
    </NextStep>
  );
}
