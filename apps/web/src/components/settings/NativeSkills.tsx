import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, orpc } from "../../lib/api.ts";
import { cliLabels, type Harness, type Runner } from "./HarnessSheet.tsx";
import { refusal } from "./PluginInstallSheet.tsx";

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

export const nativeWarning = "Complete native installation can run plugin hooks, commands, programs and MCP servers with the runner account's access. It affects the whole plugin, including skills you did not import. Review and trust its source first.";

/** One target per runner/harness kind: named harnesses can share the same native account. */
export function useNativeTargets(harnesses: Harness[], runners: Runner[]) {
  const cli = harnesses.filter((h): h is CliHarness => h.type === "cli");
  const pairs = cli.filter((h, i) => cli.findIndex((other) => other.runnerId === h.runnerId && other.kind === h.kind) === i);
  const reports = useQueries({ queries: runners.map((r) => inventoryOptions(r.id, r.status === "online" && pairs.some((h) => h.runnerId === r.id))) });
  return pairs.map((harness) => {
    const index = runners.findIndex((r) => r.id === harness.runnerId);
    const runner = runners[index];
    const report = reports[index];
    const target = report?.data?.targets?.find((t) => t.harness === harness.kind);
    const enabled = !!(runner?.status === "online" && !report?.data?.error && target?.available && target.add);
    const reason = runner?.status !== "online" ? "Runner offline" : report?.isPending ? "Reading native capabilities…" : enabled ? "Whole native plugin" : "Native installation unavailable; enable native plugin support on this runner and check that the CLI account is available";
    return { harness, runner, enabled, reason };
  });
}

export function NativeTargetPicker({ targets, selected, onChange }: { targets: ReturnType<typeof useNativeTargets>; selected: Set<string>; onChange: (id: string) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[13px] font-medium">Install on runner / harness pairs</legend>
      {targets.length === 0 && <p className="text-[13px] text-muted">Add a CLI harness and enable native plugin support on its runner first.</p>}
      {targets.map(({ harness: h, runner, enabled, reason }) => (
        <label key={`${h.runnerId}/${h.kind}`} className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-1" checked={selected.has(h.id)} disabled={!enabled} onChange={() => onChange(h.id)} />
          <span>{runner?.name ?? "Removed runner"} / {cliLabels[h.kind]}<span className="block text-muted">{reason}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

/** A reviewed mutation is never automatically retried; per-target results remain visible. */
export function NativePluginAction({ harnessId, resource, name, action, onDone }: {
  harnessId: string; resource: Resource; name: string; action: "add" | "remove"; onDone: () => void;
}) {
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
    <div className="space-y-3 rounded-xl border border-line p-4" role="region" aria-label={`Native ${action}: ${name}`}>
      <h3 className="text-[14px] font-medium">{action === "add" ? "Install" : "Uninstall"} {name} natively</h3>
      <p className="text-[13px] text-muted">{resource.kind === "plugin" ? nativeWarning : "This installs the workspace package as a skills-only native plugin through Skillshare. Its files can include scripts. Only the owner can approve installation."}</p>
      {action === "remove" && <p className="text-[13px] text-muted">Uninstall removes the whole native plugin from this runner / harness pair. Its workspace skills, tools and agents stay available.</p>}
      {preview.isPending && <p className="text-[13px] text-muted">Preparing native preview…</p>}
      {preview.data?.changes && !apply.isSuccess && <ul className="text-[13px]">{preview.data.changes.map((c, i) => <li key={i}>{c.harness ?? "Plugin"}: {c.action.replaceAll("_", " ")}</li>)}</ul>}
      {preview.data?.blocked && <p role="alert" className="text-[13px] text-danger">Skillshare blocked this change. Refresh inventory and check the runner’s native account configuration before trying again.</p>}
      {(preview.data?.error || result?.error || error) && <p role="alert" className="text-[13px] text-danger">{result?.error ?? preview.data?.error ?? refusal(error, "Native operation failed. Refresh inventory before retrying; some changes may have completed.")}</p>}
      {result?.results && <ul aria-label="Native results" className="text-[13px]">{result.results.map((r, i) => <li key={i}>{r.harness ?? "Plugin"}: {r.status.replaceAll("_", " ")}</li>)}</ul>}
      {apply.isSuccess && !result?.error && <p role="status" className="text-[13px]">Native operation completed. Reload the harness and complete any native authentication or trust prompts.</p>}
      <div className="flex gap-2">
        {!apply.isSuccess && !apply.isError && <Button type="button" disabled={!preview.data?.revision || preview.data.blocked || !!preview.data.error || apply.isPending} onClick={() => apply.mutate(preview.data!.revision!)}>{apply.isPending ? "Applying…" : action === "add" ? "Apply native install" : "Apply native uninstall"}</Button>}
        <Button type="button" variant="ghost" disabled={apply.isPending} onClick={onDone}>Close</Button>
      </div>
    </div>
  );
}

export function NativeWorkspaceSkills({ harness, runner }: { harness: CliHarness; runner?: Runner }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const workspace = useQuery({ ...orpc.runners.workspaceSkills.queryOptions(), enabled: expanded });
  const inventory = useQuery(inventoryOptions(harness.runnerId, expanded && runner?.status === "online"));
  const [action, setAction] = useState<{ resource: Resource; name: string; action: "add" | "remove" } | null>(null);
  const target = inventory.data?.targets?.find((t) => t.harness === harness.kind);
  const available = runner?.status === "online" && !inventory.error && !inventory.data?.error && target?.available;
  return (
    <details className="border-t border-line px-5 py-3" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer text-[13px] font-medium">Workspace skills on {harness.name}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-[13px] text-muted">Native installations are shared by all {cliLabels[harness.kind]} harnesses on {runner?.name ?? "this runner"}. Sessions use matching, enabled native skills; otherwise they load the stripped workspace copy.</p>
        <Button variant="ghost" size="sm" disabled={runner?.status !== "online" || inventory.isFetching || !!action} onClick={() => { void queryClient.invalidateQueries({ queryKey: inventoryKey(harness.runnerId) }); }}>Refresh native inventory</Button>
        {runner?.status !== "online" && <p className="text-[13px] text-muted">Runner offline. Workspace skills remain available when it reconnects.</p>}
        {(inventory.error || inventory.data?.error || workspace.error) && <p role="alert" className="text-[13px] text-danger">{inventory.data?.error ?? "Could not read native or workspace inventory."}</p>}
        {runner?.status === "online" && inventory.isPending && <p className="text-[13px] text-muted">Reading native inventory…</p>}
        {workspace.data?.length === 0 && <p className="text-[13px] text-muted">No workspace skills yet.</p>}
        <ul className="space-y-3">
          {workspace.data?.map((item) => {
            const bindings = inventory.data?.packages?.filter((p) => p.harness === harness.kind) ?? [];
            const binding = bindings.find((p) => !!item.sourceKey && p.sourceKey === item.sourceKey && p.installed && p.enabled === true && !p.pending)
              ?? bindings.find((p) => p.name === item.nativeName)
              ?? bindings.find((p) => !!item.sourceKey && p.sourceKey === item.sourceKey);
            const matching = binding && !!item.sourceKey && binding.sourceKey === item.sourceKey;
            const active = available && matching && binding.installed && binding.enabled === true && !binding.pending;
            const state = inventory.error || inventory.data?.error ? "Native inventory unavailable" : !binding ? "No native installation" : binding.pending ? "Native operation pending" : !matching ? "Native source differs; uninstall before reinstalling" : !binding.installed ? "Native installation missing" : binding.enabled !== true ? "Native disabled or enablement unknown" : "Native skills available";
            return (
              <li key={`${item.resource.kind}/${item.resource.id}`} className="rounded-lg border border-line p-3 text-[13px]">
                <p className="font-medium">{item.name}{item.resource.kind === "plugin" ? " · whole plugin" : ""}</p>
                <p className="text-muted">{item.skills.join(", ") || "No imported workspace skills"}</p>
                <p className="text-muted">{state}{!active ? "; sessions use workspace skills" : ""}</p>
                {item.unavailable && <p className="text-muted">{item.unavailable}</p>}
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="ghost" disabled={!available || !target?.add || !!binding || !!item.unavailable || !!action} onClick={() => setAction({ resource: item.resource, name: item.name, action: "add" })}>Install natively</Button>
                  {binding && <Button size="sm" variant="ghost" disabled={!available || !target?.remove || !!action} onClick={() => setAction({ resource: item.resource, name: item.name, action: "remove" })}>Uninstall natively</Button>}
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
