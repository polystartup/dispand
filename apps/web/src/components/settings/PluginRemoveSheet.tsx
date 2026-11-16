import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, orpc } from "../../lib/api.ts";
import { Check, refusal, Section, toggled } from "./PluginInstallSheet.tsx";
import { useNativeTargets } from "./NativeSkills.tsx";
import { cliLabels } from "./HarnessSheet.tsx";
import { type RemovalChoice, RemovalChoices, removalPlan } from "./PluginRemoval.tsx";

type Preview = Awaited<ReturnType<typeof api.plugins.uninstallPreview>>;

export function PluginRemoveSheet({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const { t } = useTranslation("plugins");
  const preview = useQuery({ ...orpc.plugins.uninstallPreview.queryOptions({ input: { id } }), retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
      <SheetHeader className="px-6 pt-6">
        <SheetTitle className="text-[20px] tracking-tight">{t("remove.title", { name })}</SheetTitle>
        <SheetDescription>{t("remove.description")}</SheetDescription>
      </SheetHeader>
      <div className="px-6 pb-6">{preview.data && preview.isFetchedAfterMount && !preview.error ? <RemoveForm id={id} preview={preview.data} onClose={onClose} /> : preview.error ? <p role="alert">{refusal(preview.error, t("remove.readFailed"))}</p> : <p>{t("remove.reading")}</p>}</div>
    </SheetContent>
  </Sheet>;
}

function RemoveForm({ id, preview, onClose }: { id: string; preview: Preview; onClose: () => void }) {
  const { t } = useTranslation("plugins");
  const client = useQueryClient();
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const runners = useQuery(orpc.runners.list.queryOptions());
  const targets = useNativeTargets(harnesses.data ?? [], runners.data ?? [], "remove");
  // The choices made so far; an element asked about that has none yet is kept.
  const [state, setState] = useState<Record<string, RemovalChoice>>({});
  const plan = removalPlan(preview.elements, state);
  // The harnesses whose native installation the owner keeps.
  const [kept, setKept] = useState(() => new Set<string>());
  const [removedNative, setRemovedNative] = useState(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const native = targets.filter((target) => removedNative.has(target.harness.id) || target.bindings.some((b) => b.name === preview.nativeName || (!!preview.sourceKey && b.sourceKey === preview.sourceKey)));
  const toggle = (itemId: string) => setKept((prev) => toggled(prev, itemId));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      for (const target of native.filter((n) => n.enabled && !kept.has(n.harness.id) && !removedNative.has(n.harness.id))) {
        const request = { harnessIds: [target.harness.id], resource: { kind: "plugin" as const, id }, action: "remove" as const };
        const plan = await api.runners.workspacePlugin({ ...request, dryRun: true });
        if (plan.error || plan.blocked || !plan.revision) throw { code: "CONFLICT", message: plan.error ?? t("remove.blocked") };
        const result = await api.runners.workspacePlugin({ ...request, dryRun: false, revision: plan.revision });
        if (result.error || result.blocked || result.results?.some((r) => r.status === "failed")) throw { code: "CONFLICT", message: result.error ?? t(result.blocked ? "remove.blocked" : "remove.nativeFailed") };
        setRemovedNative((prev) => new Set([...prev, target.harness.id]));
        void client.invalidateQueries({ queryKey: ["native-plugins"] });
      }
      await api.plugins.uninstall({ id, reviewed: preview.reviewed, choices: plan.choices });
      await Promise.all([
        ...[orpc.plugins, orpc.skills, orpc.tools, orpc.agents, orpc.triggers, orpc.jobs, orpc.tables].map((p) => client.invalidateQueries({ queryKey: p.key() })),
        client.invalidateQueries({ queryKey: ["native-plugins"] }),
      ]);
      onClose();
    } catch (e) {
      setError(refusal(e, t("remove.failed")));
    } finally { setBusy(false); }
  }

  return <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Section id="remove-elements" title={t("remove.inUse")}>
      <RemovalChoices plan={plan} busy={busy} onChange={(key, choice) => setState((prev) => ({ ...prev, [key]: choice }))} />
    </Section>
    <Section id="remove-native" title={t("remove.native")}>
      {targets.filter((n) => n.loading).length > 0 && <p className="text-[13px] text-muted">{t("remove.readingNative")}</p>}
      {native.map((n) => <Check key={n.harness.id} label={t("remove.target", { runner: n.runner?.name, cli: cliLabels[n.harness.kind] })} detail={removedNative.has(n.harness.id) ? t("remove.nativeRemoved") : n.enabled ? t("remove.removeNative") : t("remove.nativeUnavailable")} checked={removedNative.has(n.harness.id) || (n.enabled && !kept.has(n.harness.id))} disabled={busy || !n.enabled || removedNative.has(n.harness.id)} onChange={() => toggle(n.harness.id)} />)}
      {!native.length && !targets.some((n) => n.loading) && <p className="text-[13px] text-muted">{t("remove.noNative")}</p>}
      {(harnesses.error || runners.error || targets.some((n) => n.error || n.runner?.status !== "online")) && <p className="text-[13px] text-muted">{t("remove.unchecked")}</p>}
      {!!removedNative.size && <p role="status" className="text-[13px]">{t("remove.removedCount", { count: removedNative.size })}</p>}
    </Section>
    {error && <p role="alert" className="text-[13px] text-danger">{t("remove.failedTail", { error })}</p>}
    <div className="flex gap-2">
      <Button type="submit" disabled={busy || harnesses.isPending || runners.isPending || targets.some((n) => n.loading)}>{busy ? t("remove.removing") : t("remove.submit")}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("remove.cancel")}</Button>
    </div>
  </form>;
}
