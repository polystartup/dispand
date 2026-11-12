import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cloudKindLabels } from "../components/settings/CloudHarnessForm.tsx";
import { CheckpointSetting } from "../components/settings/CheckpointSetting.tsx";
import { HarnessLimits } from "../components/settings/HarnessLimits.tsx";
import { NativeWorkspaceSkills } from "../components/settings/NativeSkills.tsx";
import { cliVersion, HarnessSheet, harnessTabs, permissionLabels, type Harness } from "../components/settings/HarnessSheet.tsx";
import { Empty, List, NextStep, OutdatedRunners, StatusDot } from "../components/settings/parts.tsx";
import { Tabs } from "../components/settings/Tabs.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/harnesses/")({ component: Harnesses });

function Harnesses() {
  // Status is the hub's live view of each runner: refreshed every 5 s.
  const harnesses = useQuery(orpc.harnesses.list.queryOptions({ refetchInterval: 5000 }));
  const runners = useQuery(orpc.runners.list.queryOptions({ refetchInterval: 5000 }));
  const [sheet, setSheet] = useState<{ harness?: Harness } | null>(null);
  const [created, setCreated] = useState<Harness | null>(null);

  const loaded = harnesses.data && runners.data;
  const byRunner = new Map(runners.data?.map((r) => [r.id, r]));

  return (
    <>
      <Tabs tabs={harnessTabs} />
      <div className="flex items-start justify-between gap-4">
        <PageHeader title="Harnesses" subtitle="Connect the CLIs and APIs that run your agents." />
        {loaded && harnesses.data!.length > 0 && (
          <Button onClick={() => setSheet({})}>
            <Plus /> New harness
          </Button>
        )}
      </div>

      {created && (
        <NextStep title={`${created.name} is ready.`}>
          <Button asChild>
            <Link to="/settings/agents/new" search={{ harness: created.id }}>
              Create an agent
            </Link>
          </Button>
        </NextStep>
      )}

      {(harnesses.error || runners.error) && !loaded && (
        <p role="alert" className="text-[14px] text-danger">
          Could not load the {harnesses.error ? "harnesses" : "runners"}.
        </p>
      )}
      <OutdatedRunners runners={runners.data ?? []} />
      {loaded && harnesses.data!.length === 0 && (
        <Empty title="No harness yet" text="A harness is a CLI on one of your machines, or a provider's API. Agents run on it.">
          <Button onClick={() => setSheet({})}>
            <Plus /> New harness
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
                        {cloudKindLabels[h.kind]} · {h.model}
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
                      {cliVersion(h.kind, runner)} on {runner?.name ?? "a removed runner"} ·{" "}
                      {permissionLabels[h.permissionMode]}
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
