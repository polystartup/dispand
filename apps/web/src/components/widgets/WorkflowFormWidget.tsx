import type { WorkflowDef } from "@dispand/domain/workflows/model";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type api, orpc } from "../../lib/api.ts";
import { useRun } from "../../lib/run-watch.ts";
import { ChatPanel } from "./ChatPanel.tsx";
import { WidgetHeader } from "./WidgetHeader.tsx";

export type Widget = Awaited<ReturnType<typeof api.pages.get>>["widgets"][number];
export type FormWidget = Extract<Widget, { type: "workflow-form" }>;

type Props = { widget: FormWidget; editing: boolean };

/** A manual workflow's form: its Button starts a run, its Chat holds the conversation. */
export function WorkflowFormWidget({ widget, editing }: Props) {
  const workflow = useQuery(orpc.workflows.get.queryOptions({ input: { id: widget.workflowId } }));
  const runs = useQuery(orpc.runs.list.queryOptions({ input: { workflowId: widget.workflowId } }));
  // undefined: follow the latest run; null: a new conversation that hasn't started yet.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const runId = chosen === undefined ? (runs.data?.[0]?.id ?? null) : chosen;
  // A run keeps the version it started on: a chat run stays a chat after the trigger changed.
  const runVersion = runs.data?.find((r) => r.id === runId)?.version;
  const versioned = useQuery({
    ...orpc.workflows.get.queryOptions({ input: { id: widget.workflowId, version: runVersion ?? 0 } }),
    enabled: runVersion !== undefined && runVersion !== workflow.data?.version,
    staleTime: Infinity,
  });
  const def = runVersion === undefined || runVersion === workflow.data?.version ? workflow.data?.def : (versioned.data?.def ?? (versioned.error ? workflow.data?.def : undefined));

  return (
    <section aria-label={widget.title} className="flex h-full flex-col overflow-hidden rounded-2xl bg-surface shadow-card">
      <WidgetHeader widget={widget} editing={editing} />
      {workflow.error && !def ? (
        <p role="alert" className="px-5 pb-5 text-[14px] text-muted">
          {(workflow.error as { code?: string }).code === "NOT_FOUND" ? "This workflow is no longer available." : "Could not load this workflow."}
        </p>
      ) : runs.error && !runs.data ? (
        <p role="alert" className="px-5 pb-5 text-[14px] text-muted">
          Could not load this workflow's runs.
        </p>
      ) : !def || !runs.data ? (
        <p className="px-5 pb-5 text-[14px] text-faint">Loading…</p>
      ) : def.trigger.field.type === "chat" ? (
        <ChatPanel
          workflowId={widget.workflowId}
          runId={runId}
          onRunStarted={setChosen}
          onNewConversation={() => setChosen(null)}
        />
      ) : (
        <ButtonField workflowId={widget.workflowId} def={def} runId={runId} onRunStarted={setChosen} />
      )}
    </section>
  );
}

const runStatus = { running: "Running…", waiting: "Waiting for you", succeeded: "Done", failed: "Failed" } as const;

function ButtonField({ workflowId, def, runId, onRunStarted }: { workflowId: string; def: WorkflowDef; runId: string | null; onRunStarted: (id: string) => void }) {
  const start = useMutation(orpc.runs.start.mutationOptions());
  return <StartButton label={def.trigger.field.label} runId={runId} start={() => start.mutateAsync({ workflowId })} onRunStarted={onRunStarted} />;
}

/** A button that starts a run (a workflow's, or an agent's Job) and says how the latest one went. */
export function StartButton({ label, runId, start, onRunStarted }: { label: string; runId: string | null; start: () => Promise<{ runId: string }>; onRunStarted: (id: string) => void }) {
  const queryClient = useQueryClient();
  const run = useRun(runId);
  const starting = useMutation({
    mutationFn: start,
    onSuccess: ({ runId }) => {
      onRunStarted(runId);
      void queryClient.invalidateQueries({ queryKey: orpc.runs.list.key() });
    },
  });
  const status = run?.run.status;
  return (
    <div className="flex flex-1 flex-col justify-center gap-3 px-5 pb-5">
      <Button className="self-start" disabled={starting.isPending} onClick={() => starting.mutate()}>
        <Play aria-hidden />
        {label}
      </Button>
      {starting.error && <p role="alert" className="text-[13px] text-danger">{starting.error.message}</p>}
      {status && (
        <p role="status" className="text-[13px] text-muted">
          Last run: {runStatus[status]}
          {status === "waiting" && (
            <>
              {" "}
              in{" "}
              <Link to="/inbox" className="text-accent hover:underline">
                the Inbox
              </Link>
            </>
          )}
          {status === "failed" && run.run.error ? `: ${run.run.error}` : ""}
        </p>
      )}
    </div>
  );
}
