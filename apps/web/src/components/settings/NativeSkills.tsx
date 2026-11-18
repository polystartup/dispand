import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api, orpc } from "../../lib/api.ts";
import { cliLabels, type Harness, type Runner } from "./HarnessSheet.tsx";
import { refusal } from "../../lib/refusal.ts";

type CliHarness = Extract<Harness, { type: "cli" }>;
type Resource = Parameters<typeof api.runners.workspacePlugin>[0]["resource"];
const inventoryKey = (runnerId: string) => ["native-plugins", runnerId];
const inventoryOptions = (runnerId: string, enabled: boolean) => ({
  queryKey: inventoryKey(runnerId),
  queryFn: () => api.runners.plugins({ runnerId, operation: { action: "list" } }),
  enabled,
  retry: false,
  staleTime: 5000,
});

/** One target per runner/harness kind: named harnesses can share the same native account. */
export function useNativeTargets(harnesses: Harness[], runners: Runner[], action: "add" | "remove" = "add") {
  const { t } = useTranslation("harnesses");
  const cli = harnesses.filter((h): h is CliHarness => h.type === "cli");
  const pairs = cli.filter((h, i) => cli.findIndex((other) => other.runnerId === h.runnerId && other.kind === h.kind) === i);
  const reports = useQueries({ queries: runners.map((r) => inventoryOptions(r.id, r.status === "online" && pairs.some((h) => h.runnerId === r.id))) });
  return pairs.map((harness) => {
    const index = runners.findIndex((r) => r.id === harness.runnerId);
    const runner = runners[index];
    const report = reports[index];
    const target = report?.data?.targets?.find((x) => x.harness === harness.kind);
    const enabled = !!(runner?.status === "online" && !report?.data?.error && target?.available && target[action]);
    const reason = runner?.status !== "online" ? t("native.offline") : report?.isPending ? t("native.readingCapabilities") : enabled ? t("native.whole") : t("native.unavailable");
    return { harness, runner, enabled, reason, loading: runner?.status === "online" && !!report?.isPending, error: !!(report?.error || report?.data?.error), bindings: report?.data?.packages?.filter((p) => p.harness === harness.kind) ?? [] };
  });
}

export function NativeTargetPicker({ targets, selected, onChange }: { targets: ReturnType<typeof useNativeTargets>; selected: Set<string>; onChange: (id: string) => void }) {
  const { t } = useTranslation("harnesses");
  return (
    <fieldset className="space-y-2">
      <legend className="text-[13px] font-medium">{t("native.pairs")}</legend>
      {targets.length === 0 && <p className="text-[13px] text-muted">{t("native.noTargets")}</p>}
      {targets.map(({ harness: h, runner, enabled, reason }) => (
        <label key={`${h.runnerId}/${h.kind}`} className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-1" checked={selected.has(h.id)} disabled={!enabled} onChange={() => onChange(h.id)} />
          <span>{t("native.target", { runner: runner?.name ?? t("native.removedRunner"), cli: cliLabels[h.kind] })}<span className="block text-muted">{reason}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

/** A reviewed mutation is never automatically retried; per-target results remain visible. */
export function NativePluginAction({ harnessId, resource, name, action, onDone }: {
  harnessId: string; resource: Resource; name: string; action: "add" | "remove"; onDone: () => void;
}) {
  const { t, i18n } = useTranslation("harnesses");
  // The runner's tool names the change in its own words: those we know are translated, the rest shown as they came.
  const state = (word: string) => (i18n.exists(`harnesses:native.word.${word}`) ? t(`native.word.${word}` as never) : word.replaceAll("_", " "));
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: ["native-plugin-preview", harnessId, resource.kind, resource.id, action],
    queryFn: () => api.runners.workspacePlugin({ harnessIds: [harnessId], resource, action, dryRun: true }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const apply = useMutation({
    mutationFn: (revision: string) => api.runners.workspacePlugin({ harnessIds: [harnessId], resource, action, dryRun: false, revision }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["native-plugins"] });
    },
    retry: false,
  });
  const result = apply.data;
  const error = apply.error ?? preview.error;
  return (
    <div className="space-y-3 rounded-xl border border-line p-4" role="region" aria-label={t(`native.actionLabel_${action}`, { name })}>
      <h3 className="text-[14px] font-medium">{t(`native.title_${action}`, { name })}</h3>
      <p className="text-[13px] text-muted">{resource.kind === "plugin" ? t("native.warning") : t("native.skillsOnly")}</p>
      {action === "remove" && <p className="text-[13px] text-muted">{t("native.removeNote")}</p>}
      {preview.isPending && <p className="text-[13px] text-muted">{t("native.preparing")}</p>}
      {preview.data?.changes && !apply.isSuccess && <ul className="text-[13px]">{preview.data.changes.map((c, i) => <li key={i}>{t("native.change", { target: c.harness ?? t("native.plugin"), change: state(c.action) })}</li>)}</ul>}
      {(preview.data?.blocked || result?.blocked) && <p role="alert" className="text-[13px] text-danger">{t("native.blocked")}</p>}
      {(preview.data?.error || result?.error || error) && <p role="alert" className="text-[13px] text-danger">{result?.error ?? preview.data?.error ?? refusal(error, t("native.failed"))}</p>}
      {result?.results && <ul aria-label={t("native.results")} className="text-[13px]">{result.results.map((r, i) => <li key={i}>{t("native.change", { target: r.harness ?? t("native.plugin"), change: state(r.status) })}</li>)}</ul>}
      {apply.isSuccess && !result?.error && !result?.blocked && <p role="status" className="text-[13px]">{t("native.done")}</p>}
      <div className="flex gap-2">
        {!apply.isSuccess && !apply.isError && <Button type="button" disabled={!preview.data?.revision || preview.data.blocked || !!preview.data.error || apply.isPending} onClick={() => apply.mutate(preview.data!.revision!)}>{apply.isPending ? t("native.applying") : t(`native.apply_${action}`)}</Button>}
        <Button type="button" variant="ghost" disabled={apply.isPending} onClick={onDone}>{t("native.close")}</Button>
      </div>
    </div>
  );
}

export function NativeWorkspaceSkills({ harness, runner }: { harness: CliHarness; runner?: Runner }) {
  const { t } = useTranslation("harnesses");
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const workspace = useQuery({ ...orpc.runners.workspaceSkills.queryOptions(), enabled: expanded });
  const inventory = useQuery(inventoryOptions(harness.runnerId, expanded && runner?.status === "online"));
  const [action, setAction] = useState<{ resource: Resource; name: string; action: "add" | "remove" } | null>(null);
  const target = inventory.data?.targets?.find((x) => x.harness === harness.kind);
  const available = runner?.status === "online" && !inventory.error && !inventory.data?.error && target?.available;
  return (
    <details className="border-t border-line px-5 py-3" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer text-[13px] font-medium">{t("native.workspaceSkills", { name: harness.name })}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-[13px] text-muted">{t("native.shared", { cli: cliLabels[harness.kind], runner: runner?.name ?? t("native.thisRunner") })}</p>
        <Button variant="ghost" size="sm" disabled={runner?.status !== "online" || inventory.isFetching || !!action} onClick={() => { void queryClient.invalidateQueries({ queryKey: inventoryKey(harness.runnerId) }); }}>{t("native.refresh")}</Button>
        {runner?.status !== "online" && <p className="text-[13px] text-muted">{t("native.runnerOffline")}</p>}
        {(inventory.error || inventory.data?.error || workspace.error) && <p role="alert" className="text-[13px] text-danger">{inventory.data?.error ?? t("native.readFailed")}</p>}
        {runner?.status === "online" && inventory.isPending && <p className="text-[13px] text-muted">{t("native.readingInventory")}</p>}
        {workspace.data?.length === 0 && <p className="text-[13px] text-muted">{t("native.noSkills")}</p>}
        <ul className="space-y-3">
          {workspace.data?.map((item) => {
            const bindings = inventory.data?.packages?.filter((p) => p.harness === harness.kind) ?? [];
            const binding = bindings.find((p) => !!item.sourceKey && p.sourceKey === item.sourceKey && p.installed && p.enabled === true && !p.pending)
              ?? bindings.find((p) => p.name === item.nativeName)
              ?? bindings.find((p) => !!item.sourceKey && p.sourceKey === item.sourceKey);
            const matching = binding && !!item.sourceKey && binding.sourceKey === item.sourceKey;
            const active = available && matching && binding.installed && binding.enabled === true && !binding.pending;
            const state = t(`native.state.${inventory.error || inventory.data?.error ? "unavailable" : !binding ? "none" : binding.pending ? "pending" : !matching ? "differs" : !binding.installed ? "missing" : binding.enabled !== true ? "disabled" : "available"}`);
            return (
              <li key={`${item.resource.kind}/${item.resource.id}`} className="rounded-lg border border-line p-3 text-[13px]">
                <p className="font-medium">{item.resource.kind === "plugin" ? t("native.wholePlugin", { name: item.name }) : item.name}</p>
                <p className="text-muted">{item.skills.join(", ") || t("native.noImported")}</p>
                <p className="text-muted">{active ? state : t("native.fallback", { state })}</p>
                {item.unavailable && <p className="text-muted">{item.unavailable}</p>}
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="ghost" disabled={!available || !target?.add || !!binding || !!item.unavailable || !!action} onClick={() => setAction({ resource: item.resource, name: item.name, action: "add" })}>{t("native.install")}</Button>
                  {binding && <Button size="sm" variant="ghost" disabled={!available || !target?.remove || !!action} onClick={() => setAction({ resource: item.resource, name: item.name, action: "remove" })}>{t("native.uninstall")}</Button>}
                </div>
              </li>
            );
          })}
        </ul>
        {action && <NativePluginAction harnessId={harness.id} {...action} onDone={() => setAction(null)} />}
      </div>
    </details>
  );
}
