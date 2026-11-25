import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { AgentRights } from "../settings/PluginDefinitionPicks.tsx";
import { type NativeEntry, RunsNatively } from "../settings/PluginNative.tsx";

type Input = { marketplaceId?: string; entryName?: string; reviewed?: string; skills?: string[]; setup?: { primitives?: string[]; agents?: { name: string; harnessId: string }[]; triggers?: string[] } };

type Shown = { agents?: Parameters<typeof AgentRights>[0]["d"][]; /** What its native revision runs, as the server read it with the install's token. */ runsNatively?: NativeEntry[] };

/**
 * A proposed plugin install as its owner reads it: the entry, what it brings in, and what each
 * agent it makes may do, as the server read the plugin when it was proposed. The install carries
 * that read's token, so a plugin changed since installs nothing.
 */
export function PluginInstallItem({ input, shown }: { input: Input; shown: Shown | undefined }) {
  const { t } = useTranslation("questions");
  const format = useFormat();
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const setup = input.setup ?? {};
  const agents = (setup.agents ?? []).map((a) => ({ ...a, definition: shown?.agents?.find((d) => d.name.toLowerCase() === a.name.toLowerCase()) }));
  const listed = (items: string[] | undefined) => (items?.length ? format.list(items) : t("plugin.none"));
  const lines: [string, string][] = [
    [t("plugin.plugin"), input.entryName ?? ""],
    [t("plugin.skills"), listed(input.skills)],
    [t("plugin.tables"), listed(setup.primitives)],
    [t("plugin.triggers"), listed(setup.triggers)],
  ];
  return (
    <div className="mt-2 space-y-2 text-[13px]">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5">
        {lines.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      {agents.length > 0 && (
        <ul aria-label={t("plugin.agents")} className="space-y-2">
          {agents.map((a) => (
            <li key={a.name}>
              <span className="font-medium">{a.name}</span> <span className="text-muted">{t("plugin.on", { harness: harnesses.data?.find((h) => h.id === a.harnessId)?.name ?? t("plugin.aHarness") })}</span>
              {a.definition ? <AgentRights d={a.definition} /> : <p className="ml-7 text-[12px] text-danger">{t("plugin.unread")}</p>}
            </li>
          ))}
        </ul>
      )}
      {shown?.runsNatively && <RunsNatively after={shown.runsNatively} />}
      <p className="text-muted">{t("plugin.note")}</p>
    </div>
  );
}
