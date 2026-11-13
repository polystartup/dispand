import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, orpc } from "../../lib/api.ts";
import { Check, refusal, Section, toggled } from "./PluginInstallSheet.tsx";
import { useNativeTargets } from "./NativeSkills.tsx";
import { cliLabels } from "./HarnessSheet.tsx";

type Preview = Awaited<ReturnType<typeof api.plugins.uninstallPreview>>;

export function PluginRemoveSheet({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const preview = useQuery({ ...orpc.plugins.uninstallPreview.queryOptions({ input: { id } }), retry: false, refetchOnWindowFocus: false });
  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent className="overflow-y-auto">
      <SheetHeader>
        <SheetTitle>Remove {name}</SheetTitle>
        <SheetDescription>Choose what to remove. Unticked items stay in your workspace. Checked skills and tools are also removed from agents that use them. Job history and data created during setup are kept.</SheetDescription>
      </SheetHeader>
      <div className="mt-6">{preview.data ? <RemoveForm id={id} preview={preview.data} onClose={onClose} /> : preview.error ? <p role="alert">{refusal(preview.error, "Could not read the plugin. Close this dialog and try again.")}</p> : <p>Reading what this plugin installed…</p>}</div>
    </SheetContent>
  </Sheet>;
}

function RemoveForm({ id, preview, onClose }: { id: string; preview: Preview; onClose: () => void }) {
  const client = useQueryClient();
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const runners = useQuery(orpc.runners.list.queryOptions());
  const targets = useNativeTargets(harnesses.data ?? [], runners.data ?? [], "remove");
  const [kept, setKept] = useState(() => new Set(preview.agents.filter((a) => a.inUse).map((a) => a.id)));
  const [removedNative, setRemovedNative] = useState(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agents = preview.agents.filter((a) => !kept.has(a.id)).map((a) => a.id);
  const skills = preview.skills.filter((s) => !kept.has(s.id)).map((s) => s.id);
  const tools = preview.tools.filter((t) => !kept.has(t.id)).map((t) => t.id);
  const native = targets.filter((t) => removedNative.has(t.harness.id) || t.bindings.some((b) => b.name === preview.nativeName || (!!preview.sourceKey && b.sourceKey === preview.sourceKey)));
  const toggle = (itemId: string) => setKept((prev) => toggled(prev, itemId));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      for (const target of native.filter((t) => t.enabled && !kept.has(t.harness.id) && !removedNative.has(t.harness.id))) {
        const request = { harnessIds: [target.harness.id], resource: { kind: "plugin" as const, id }, action: "remove" as const };
        const plan = await api.runners.workspacePlugin({ ...request, dryRun: true });
        if (plan.error || plan.blocked || !plan.revision) throw { code: "CONFLICT", message: plan.error ?? "Native removal is blocked. Check the harness inventory before retrying." };
        const result = await api.runners.workspacePlugin({ ...request, dryRun: false, revision: plan.revision });
        if (result.error || result.results?.some((r) => r.status === "failed")) throw { code: "CONFLICT", message: result.error ?? "Native removal failed. Check the harness inventory before retrying." };
        setRemovedNative((prev) => new Set([...prev, target.harness.id]));
        void client.invalidateQueries({ queryKey: ["native-plugins"] });
      }
      await api.plugins.uninstall({ id, remove: { skills, tools, agents } });
      await Promise.all([
        ...[orpc.plugins, orpc.skills, orpc.tools, orpc.agents, orpc.triggers, orpc.jobs].map((p) => client.invalidateQueries({ queryKey: p.key() })),
        client.invalidateQueries({ queryKey: ["native-plugins"] }),
      ]);
      onClose();
    } catch (e) {
      setError(refusal(e, "Could not remove the plugin. Review your selection and try again."));
    } finally { setBusy(false); }
  }

  return <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Section id="remove-agents" title="Agents">
      {preview.agents.length ? preview.agents.map((a) => <Check key={a.id} label={a.name} detail={a.inUse ?? "Remove this agent; its Job history is kept."} checked={agents.includes(a.id)} disabled={busy || a.blocked} onChange={() => toggle(a.id)} />) : <p className="text-[13px] text-muted">No imported agents.</p>}
    </Section>
    <Section id="remove-skills" title="Skill packages">
      {preview.skills.length ? preview.skills.map((s) => <Check key={s.id} label={s.name} detail="Remove the files and unlink this package from all agents." checked={skills.includes(s.id)} disabled={busy} onChange={() => toggle(s.id)} />) : <p className="text-[13px] text-muted">No imported skills.</p>}
    </Section>
    <Section id="remove-tools" title="Tools">
      {preview.tools.length ? preview.tools.map((t) => <Check key={t.id} label={t.name} detail="Remove this tool and saved settings; unlink it from agents and skills." checked={tools.includes(t.id)} disabled={busy} onChange={() => toggle(t.id)} />) : <p className="text-[13px] text-muted">No imported tools.</p>}
    </Section>
    <Section id="remove-native" title="Native installations">
      {targets.filter((t) => t.loading).length > 0 && <p className="text-[13px] text-muted">Reading native installations…</p>}
      {native.map((t) => <Check key={t.harness.id} label={`${t.runner?.name} / ${cliLabels[t.harness.kind]}`} detail={removedNative.has(t.harness.id) ? "Native plugin removed." : t.enabled ? "Remove the complete native plugin from this account." : "Native removal is unavailable. Check this harness before removing its workspace plugin."} checked={removedNative.has(t.harness.id) || (t.enabled && !kept.has(t.harness.id))} disabled={busy || !t.enabled || removedNative.has(t.harness.id)} onChange={() => toggle(t.harness.id)} />)}
      {!native.length && !targets.some((t) => t.loading) && <p className="text-[13px] text-muted">No matching native installation found on the connected harnesses.</p>}
      {(harnesses.error || runners.error || targets.some((t) => t.error || t.runner?.status !== "online")) && <p className="text-[13px] text-muted">Some harnesses could not be checked. Native installations there may remain.</p>}
      {!!removedNative.size && <p role="status" className="text-[13px]">{removedNative.size} native installation(s) removed. Workspace removal happens after all selected native removals succeed.</p>}
    </Section>
    {error && <p role="alert" className="text-[13px] text-danger">{error} The workspace plugin stays until removal succeeds; completed native removals stay removed.</p>}
    <div className="flex gap-2">
      <Button type="submit" disabled={busy || harnesses.isPending || runners.isPending || targets.some((t) => t.loading)}>{busy ? "Removing…" : "Remove plugin"}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
    </div>
  </form>;
}
