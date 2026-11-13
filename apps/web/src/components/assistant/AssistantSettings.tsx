import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "@/components/ui/sheet";
import type { Harness } from "../settings/HarnessSheet.tsx";
import { api, orpc } from "../../lib/api.ts";
import type { Agent } from "../settings/AgentEditor.tsx";
import { FormField } from "../settings/parts.tsx";

export function AssistantSettings({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const agent = useQuery(orpc.agents.get.queryOptions({ input: { id: agentId } }));
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const harness = harnesses.data?.find((h) => h.id === agent.data?.harnessId);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button type="button" variant="ghost" aria-label="Assistant settings" className="max-w-full gap-2 text-muted" onClick={() => setOpen(true)}>
        <span className="truncate">{agent.data?.model ?? harness?.model ?? harness?.name ?? "Choose model"}</span><ChevronDown aria-hidden className="size-4" />
      </Button></SheetTrigger>
      {open && <SettingsSheet agentId={agentId} onClose={() => setOpen(false)} />}
    </Sheet>
  );
}

function SettingsSheet({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const agent = useQuery({ ...orpc.agents.get.queryOptions({ input: { id: agentId } }), refetchOnMount: "always" });
  return (
    <SheetContent side="bottom" className="mx-auto max-h-[90dvh] max-w-lg rounded-t-3xl bg-surface">
      <SheetHeader className="px-6 pr-12">
        <SheetTitle>Harness and model</SheetTitle>
        <SheetDescription>Applies to new conversations. Existing conversations keep their settings.</SheetDescription>
      </SheetHeader>
      {!agent.isFetchedAfterMount ? <p>Loading…</p> : agent.error ? <p role="alert">Could not load the Assistant settings.</p> : agent.data && <SettingsForm agent={agent.data} onSaved={onClose} />}
    </SheetContent>
  );
}

function SettingsForm({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const [search, setSearch] = useState("");
  const [harnessId, setHarnessId] = useState(agent.harnessId);
  const [model, setModel] = useState(agent.model ?? "");
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const harness = harnesses.data?.find((h) => h.id === harnessId);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: async () => {
      // The update procedure also takes these fields: read them fresh so a settings save keeps other edits.
      const current = await api.agents.get({ id: agent.id });
      return api.agents.update({
        id: current.id,
        name: current.name,
        systemPrompt: current.systemPrompt,
        skillPackageIds: current.skills.map((s) => s.packageId),
        toolIds: current.tools.filter((t) => t.explicit).map((t) => t.toolId),
        harnessId,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.agents.key() });
      onSaved();
    },
  });
  return (
    <form className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); save.mutate(); }}>
      <Input aria-label="Find a model" placeholder="Find a model…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="space-y-4">
        {harnesses.data?.map((h) => <HarnessModels key={h.id} harness={h} search={search} selected={harnessId === h.id ? model : undefined} disabled={save.isPending} onSelect={(next) => { setHarnessId(h.id); setModel(next); }} />)}
      </div>
      <FormField label="Harness" htmlFor="assistant-harness">
        <Select value={harnessId} onValueChange={(id) => { setHarnessId(id); setModel(""); }} disabled={save.isPending}>
          <SelectTrigger id="assistant-harness" className="w-full"><SelectValue placeholder="Pick a harness" /></SelectTrigger>
          <SelectContent>
            {harnesses.data?.map((h) => <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </FormField>
      {harnesses.error && <p role="alert" className="text-[13px] text-danger">Could not load the harnesses.</p>}
      <FormField label="Model" htmlFor="assistant-model" hint={`Enter a model id or CLI alias, or leave empty for the harness default (${harness?.model ?? "CLI default"}). Changing the harness clears the model override.`}>
        <Input id="assistant-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={harness?.model ?? "CLI default"} maxLength={100} disabled={save.isPending} />
      </FormField>
      {save.error && <p role="alert" className="text-[13px] text-danger">{save.error instanceof Error && "code" in save.error && save.error.code === "BAD_REQUEST" ? save.error.message : "Could not save the Assistant settings. Try again."}</p>}
      <Button type="submit" disabled={save.isPending || !harness}>Save settings</Button>
    </form>
  );
}

/** Provider catalogs stay on the server; CLI aliases and unlisted models remain editable below. */
function HarnessModels({ harness, search, selected, disabled, onSelect }: { harness: Harness; search: string; selected: string | undefined; disabled: boolean; onSelect: (model: string) => void }) {
  const models = useQuery({ ...orpc.harnesses.models.queryOptions({ input: { harnessId: harness.id } }), enabled: harness.type === "cloud", retry: false, staleTime: 60_000 });
  const choices = [{ id: "", label: harness.model ?? "CLI default" }, ...(models.data ?? []).filter((m) => m.id !== harness.model)];
  const shown = choices.filter((m) => `${harness.name} ${m.label} ${m.id}`.toLowerCase().includes(search.toLowerCase()));
  if (!shown.length) return null;
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="mb-2 text-sm text-muted">{harness.name}</legend>
    <div className="overflow-hidden rounded-2xl bg-hover">
      {shown.map((m) => <button key={m.id} type="button" aria-pressed={selected === m.id} onClick={() => onSelect(m.id)} className="flex w-full items-center gap-2 border-b border-line px-4 py-3 text-left last:border-0 hover:bg-line focus-visible:outline-2 focus-visible:outline-accent">
        <span className="min-w-0 flex-1 break-words">{m.label}</span>
        {!m.id && <span className="text-xs text-muted">Default</span>}
        {selected === m.id && <Check aria-hidden className="size-4 shrink-0" />}
      </button>)}
    </div>
    {models.isError && <p className="text-xs text-muted">Could not list models. You can enter a model below.</p>}
  </fieldset>;
}
