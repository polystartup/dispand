import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { harnessTabs, type Runner } from "../components/settings/HarnessSheet.tsx";
import { Empty, List, OutdatedRunners, StatusDot } from "../components/settings/parts.tsx";
import { RunnerSheet } from "../components/settings/RunnerSheet.tsx";
import { Tabs } from "../components/settings/Tabs.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

/** What the runner reported about its CLIs, in words. */
function cliSummary(clis: Runner["clis"]): string[] {
  const parts = clis.claude ? [`Claude Code ${clis.claude}`] : [];
  if (clis.codex) parts.push(`Codex ${clis.codex.version}${clis.codex.signedIn ? "" : " (not signed in)"}`);
  return parts;
}

export const Route = createFileRoute("/_app/settings/harnesses/runners")({ component: Runners });

function Runners() {
  // Status is the hub's live view of each runner: refreshed every 5 s.
  const runners = useQuery(orpc.runners.list.queryOptions({ refetchInterval: 5000 }));
  const [sheet, setSheet] = useState<{ runner?: Runner } | null>(null);
  const add = (
    <Button onClick={() => setSheet({})}>
      <Plus /> Add runner
    </Button>
  );

  return (
    <>
      <Tabs tabs={harnessTabs} />
      <div className="flex items-start justify-between gap-4">
        <PageHeader title="Runners" subtitle="The machines your harnesses run on." />
        {runners.data && runners.data.length > 0 && add}
      </div>

      {runners.error && !runners.data && (
        <p role="alert" className="text-[14px] text-danger">
          Could not load the runners.
        </p>
      )}
      <OutdatedRunners runners={runners.data ?? []} />
      {runners.data?.length === 0 && (
        <Empty title="No runner yet" text="A runner is a small service on a machine where a CLI like Claude Code is installed.">
          {add}
        </Empty>
      )}
      {runners.data && runners.data.length > 0 && (
        <List>
          {runners.data.map((r) => {
            const clis = cliSummary(r.clis);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSheet({ runner: r })}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-hover"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium">{r.name}</span>
                    <span className="block truncate text-[13px] text-muted">{clis.length ? clis.join(" · ") : "No CLI reported yet"}</span>
                  </span>
                  <StatusDot status={r.status} />
                </button>
              </li>
            );
          })}
        </List>
      )}

      {sheet && <RunnerSheet key={sheet.runner?.id ?? "new"} runner={sheet.runner} onClose={() => setSheet(null)} />}
    </>
  );
}
