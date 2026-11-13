import { HarnessModelPicker } from "../settings/HarnessModelPicker.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "@/components/ui/sheet";
import { api, orpc } from "../../lib/api.ts";
import type { Agent } from "../settings/AgentEditor.tsx";

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
      <HarnessModelPicker harnessId={harnessId} model={model} disabled={save.isPending} onChange={(id, next) => { setHarnessId(id); setModel(next); }} />
      {save.error && <p role="alert" className="text-[13px] text-danger">{save.error instanceof Error && "code" in save.error && save.error.code === "BAD_REQUEST" ? save.error.message : "Could not save the Assistant settings. Try again."}</p>}
      <Button type="submit" disabled={save.isPending || !harness}>Save settings</Button>
    </form>
  );
}
