import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { orpc } from "../../lib/api.ts";
import { FormField } from "./parts.tsx";
import type { Harness } from "./HarnessSheet.tsx";

export function HarnessModelPicker({ harnessId, model, disabled = false, onChange }: { harnessId: string; model: string; disabled?: boolean; onChange: (harnessId: string, model: string) => void }) {
  const [search, setSearch] = useState("");
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const harness = harnesses.data?.find((h) => h.id === harnessId);
  return <div className="space-y-4">
      <Input aria-label="Find a model" placeholder="Find a model…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="space-y-4">
        {harnesses.data?.map((h) => <HarnessModels key={h.id} harness={h} search={search} selected={harnessId === h.id ? model : undefined} disabled={disabled} onSelect={(next) => { onChange(h.id, next); }} />)}
      </div>
      <FormField label="Harness" htmlFor="harness-picker">
        <Select value={harnessId} onValueChange={(id) => { onChange(id, ""); }} disabled={disabled}>
          <SelectTrigger id="harness-picker" className="w-full"><SelectValue placeholder="Pick a harness" /></SelectTrigger>
          <SelectContent>
            {harnesses.data?.map((h) => <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </FormField>
      {harnesses.error && <p role="alert" className="text-[13px] text-danger">Could not load the harnesses.</p>}
      <FormField label="Model" htmlFor="model-picker" hint={`Enter a model id or CLI alias, or leave empty for the harness default (${harness?.model ?? "CLI default"}). Changing the harness clears the model override.`}>
        <Input id="model-picker" value={model} onChange={(e) => onChange(harnessId, e.target.value)} placeholder={harness?.model ?? "CLI default"} maxLength={100} disabled={disabled} />
      </FormField>
  </div>;
}

/** Provider catalogs stay on the server; CLI aliases and unlisted models remain editable below. */
function HarnessModels({ harness, search, selected, disabled, onSelect }: { harness: Harness; search: string; selected: string | undefined; disabled: boolean; onSelect: (model: string) => void }) {
  const models = useQuery({ ...orpc.harnesses.models.queryOptions({ input: { harnessId: harness.id } }), retry: false, staleTime: 60_000 });
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
