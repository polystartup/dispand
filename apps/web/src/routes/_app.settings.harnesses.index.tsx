import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CheckpointSetting } from "../components/settings/CheckpointSetting.tsx";
import { HarnessLimits } from "../components/settings/HarnessLimits.tsx";
import { NativeWorkspaceSkills } from "../components/settings/NativeSkills.tsx";
import { cliVersion, HarnessSheet, harnessTabs, type Harness } from "../components/settings/HarnessSheet.tsx";
import { Empty, List, NextStep, OutdatedRunners, StatusDot } from "../components/settings/parts.tsx";
import { Tabs } from "../components/settings/Tabs.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/harnesses/")({ component: Harnesses });

function Harnesses() {
  const { t } = useTranslation("harnesses");
  // Status is the hub's live view of each runner: refreshed every 5 s.
  const harnesses = useQuery(orpc.harnesses.list.queryOptions({ refetchInterval: 5000 }));
  const runners = useQuery(orpc.runners.list.queryOptions({ refetchInterval: 5000 }));
  const [sheet, setSheet] = useState<{ harness?: Harness } | null>(null);
  const [created, setCreated] = useState<Harness | null>(null);

  const loaded = harnesses.data && runners.data;
  const byRunner = new Map(runners.data?.map((r) => [r.id, r]));

  return (
    <>
      <Tabs tabs={harnessTabs.map((tab) => ({ ...tab, label: t(tab.label) }))} />
      <div className="flex items-start justify-between gap-4">
        <PageHeader title={t("list.title")} subtitle={t("list.subtitle")} />
        {loaded && harnesses.data!.length > 0 && (
          <Button onClick={() => setSheet({})}>
            <Plus /> {t("list.new")}
          </Button>
        )}
      </div>

      {created && (
        <NextStep title={t("list.ready", { name: created.name })}>
          <Button asChild>
            <Link to="/settings/agents/new" search={{ harness: created.id }}>
              {t("list.createAgent")}
            </Link>
          </Button>
        </NextStep>
      )}

      {(harnesses.error || runners.error) && !loaded && (
        <p role="alert" className="text-[14px] text-danger">
          {harnesses.error ? t("list.harnessesFailed") : t("list.runnersFailed")}
        </p>
      )}
      <OutdatedRunners runners={runners.data ?? []} />
      {loaded && harnesses.data!.length === 0 && (
        <Empty title={t("list.emptyTitle")} text={t("list.emptyText")}>
          <Button onClick={() => setSheet({})}>
            <Plus /> {t("list.new")}
          </Button>
        </Empty>
      )}
      {loaded && harnesses.data!.length > 0 && (
        <List>
          {harnesses.data!.map((h) => {
            if (h.type === "cloud") {
              return (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => setSheet({ harness: h })}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-hover"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium">{h.name}</span>
                      <span className="block truncate text-[13px] text-muted">
                        {t("list.cloud", { provider: t(`provider.${h.kind}`), model: h.model })}
                      </span>
                    </span>
                  </button>
                </li>
              );
            }
            const runner = byRunner.get(h.runnerId);
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => setSheet({ harness: h })}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-hover"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium">{h.name}</span>
                    <span className="block truncate text-[13px] text-muted">
                      {t("list.cli", { cli: cliVersion(t, h.kind, runner), runner: runner?.name ?? t("list.removedRunner"), permission: t(`permission.${h.permissionMode}`) })}
                    </span>
                  </span>
                  <StatusDot status={runner?.status ?? "offline"} />
                </button>
                <NativeWorkspaceSkills harness={h} runner={runner} />
              </li>
            );
          })}
        </List>
      )}

      {loaded && harnesses.data!.length > 0 && <HarnessLimits />}
      {loaded && harnesses.data!.length > 0 && <CheckpointSetting />}

      {sheet && (
        <HarnessSheet
          key={sheet.harness?.id ?? "new"}
          harness={sheet.harness}
          runners={runners.data ?? []}
          onClose={() => setSheet(null)}
          onSaved={(saved, isNew) => {
            setSheet(null);
            setCreated(isNew ? saved : null);
          }}
        />
      )}
    </>
  );
}
