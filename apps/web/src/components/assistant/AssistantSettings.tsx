import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, orpc } from "../../lib/api.ts";
import type { Agent } from "../settings/AgentEditor.tsx";
import { FormField } from "../settings/parts.tsx";

export function AssistantSettings({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" className="ml-auto gap-2" onClick={() => setOpen(true)}>
        <Settings aria-hidden className="size-4" />
        Assistant settings
      </Button>
      {open && <SettingsSheet agentId={agentId} onClose={() => setOpen(false)} />}
    </>
  );
}

function SettingsSheet({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const agent = useQuery({ ...orpc.agents.get.queryOptions({ input: { id: agentId } }), refetchOnMount: "always" });
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Assistant settings</SheetTitle>
          <SheetDescription>Choose the harness and model for new conversations and Jobs. Existing conversations keep their settings.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {!agent.isFetchedAfterMount ? <p>Loading…</p> : agent.error ? <p role="alert">Could not load the Assistant settings.</p> : agent.data && <SettingsForm agent={agent.data} onSaved={onClose} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SettingsForm({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
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
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
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
