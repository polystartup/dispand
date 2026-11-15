import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { harnessTabs, type Runner } from "../components/settings/HarnessSheet.tsx";
import { Empty, List, OutdatedRunners, StatusDot } from "../components/settings/parts.tsx";
import { RunnerSheet } from "../components/settings/RunnerSheet.tsx";
import { Tabs } from "../components/settings/Tabs.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

/** What the runner reported about its CLIs, in words. */
function cliSummary(t: TFunction<"harnesses">, clis: Runner["clis"]): string[] {
  const parts = clis.claude ? [t("runners.claude", { version: clis.claude })] : [];
  if (clis.codex) parts.push(t(clis.codex.signedIn ? "runners.codex" : "runners.codexSignedOut", { version: clis.codex.version }));
  return parts;
}

export const Route = createFileRoute("/_app/settings/harnesses/runners")({ component: Runners });

function Runners() {
  const { t } = useTranslation("harnesses");
  // Status is the hub's live view of each runner: refreshed every 5 s.
  const runners = useQuery(orpc.runners.list.queryOptions({ refetchInterval: 5000 }));
  const [sheet, setSheet] = useState<{ runner?: Runner } | null>(null);
  const add = (
    <Button onClick={() => setSheet({})}>
      <Plus /> {t("runners.add")}
    </Button>
  );

  return (
    <>
      <Tabs tabs={harnessTabs.map((tab) => ({ ...tab, label: t(tab.label) }))} />
      <div className="flex items-start justify-between gap-4">
        <PageHeader title={t("runners.title")} subtitle={t("runners.subtitle")} />
        {runners.data && runners.data.length > 0 && add}
      </div>

      {runners.error && !runners.data && (
        <p role="alert" className="text-[14px] text-danger">
          {t("runners.failed")}
        </p>
      )}
      <OutdatedRunners runners={runners.data ?? []} />
      {runners.data?.length === 0 && (
        <Empty title={t("runners.emptyTitle")} text={t("runners.emptyText")}>
          {add}
        </Empty>
      )}
      {runners.data && runners.data.length > 0 && (
        <List>
          {runners.data.map((r) => {
            const clis = cliSummary(t, r.clis);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSheet({ runner: r })}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-hover"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium">{r.name}{r.runnerUpdate === "available" && <span className="ml-2 text-[12px] text-muted">{t("runners.updateAvailable")}</span>}{r.runnerUpdate === "updating" && <span className="ml-2 text-[12px] text-muted">{t("runners.updating")}</span>}</span>
                    <span className="block truncate text-[13px] text-muted">{clis.length ? clis.join(" · ") : t("runners.noCli")}</span>
                  </span>
                  <StatusDot status={r.status} />
                </button>
              </li>
            );
          })}
        </List>
      )}

      {sheet && <RunnerSheet key={sheet.runner?.id ?? "new"} runner={sheet.runner ? runners.data?.find((r) => r.id === sheet.runner?.id) ?? sheet.runner : undefined} onClose={() => setSheet(null)} />}
    </>
  );
}
