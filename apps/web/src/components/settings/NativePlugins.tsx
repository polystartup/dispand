import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { orpc } from "../../lib/api.ts";
import { refusal } from "../../lib/refusal.ts";
import { useWorkspaces } from "../../lib/workspace.tsx";

/**
 * The native plugins granted to an agent: in a container runner its conversations mount each one
 * whole, hooks and servers included. A manager grants them, saved at each change, apart from the
 * form; a member sees which are granted.
 */
export function NativePlugins({ agentId }: { agentId: string }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const role = useWorkspaces().current?.role;
  const manages = role === "owner" || role === "manager";
  const granted = useQuery(orpc.agents.nativePlugins.queryOptions({ input: { agentId } }));
  const plugins = useQuery(orpc.plugins.list.queryOptions());
  const set = useMutation(orpc.agents.setNativePlugins.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.agents.key() }) }));
  const ids = granted.data ?? [];
  const offered = (plugins.data ?? []).filter((p) => p.source === "marketplace");
  const toggle = (id: string, on: boolean) => set.mutate({ agentId, pluginIds: on ? [...ids, id] : ids.filter((x) => x !== id) });
  return (
    <section aria-labelledby="agent-native-plugins" className="space-y-2">
      <h3 id="agent-native-plugins" className="text-[13px] font-medium text-muted">
        {t("nativePlugins.title")}
      </h3>
      <p className="text-[13px] text-faint">{t("nativePlugins.detail")}</p>
      {manages ? (
        offered.length === 0 ? (
          <p className="text-[13px] text-faint">{t("nativePlugins.none")}</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {offered.map((p) => (
              <li key={p.id}>
                <label className="flex items-start gap-3 px-3 py-2 text-[14px]">
                  <input type="checkbox" className="mt-1" checked={ids.includes(p.id)} disabled={set.isPending || !granted.data} onChange={(e) => toggle(p.id, e.target.checked)} />
                  <span className="min-w-0">
                    <span className="block font-medium">{p.name}</span>
                    {p.nativeBehind && <span className="block text-[13px] text-muted">{t("nativePlugins.behind")}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-[13px]">{ids.length ? offered.filter((p) => ids.includes(p.id)).map((p) => p.name).join(", ") : t("nativePlugins.noneGranted")}</p>
      )}
      {(granted.error || plugins.error) && <p role="alert" className="text-[13px] text-danger">{t("nativePlugins.failed")}</p>}
      {set.error && <p role="alert" className="text-[13px] text-danger">{refusal(set.error, t("nativePlugins.saveFailed"))}</p>}
    </section>
  );
}
