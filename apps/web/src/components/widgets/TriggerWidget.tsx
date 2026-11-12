import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, orpc } from "../../lib/api.ts";
import { localTimezone } from "../agents/TriggerSheet.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { WidgetHeader } from "./WidgetHeader.tsx";
import { StartButton, type Widget } from "./WorkflowFormWidget.tsx";

export type TriggerFormWidget = Extract<Widget, { type: "trigger-form" }>;

type Props = { widget: TriggerFormWidget; editing: boolean };

/** An agent's manual trigger on a page: its button starts a Job, its chat holds the conversation. */
export function TriggerWidget({ widget, editing }: Props) {
  const trigger = useQuery({ ...orpc.triggers.get.queryOptions({ input: { id: widget.triggerId } }), retry: false });
  const jobs = useQuery(orpc.runs.list.queryOptions({ input: { triggerId: widget.triggerId } }));
  // undefined: follow the trigger's latest Job; null: a new conversation that hasn't started yet.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const runId = chosen === undefined ? (jobs.data?.[0]?.id ?? null) : chosen;
  // A Job keeps the placement it started with: a chat stays a chat after the trigger became a button.
  const jobDef = useQuery({ ...orpc.jobs.def.queryOptions({ input: { runId: runId ?? "" } }), enabled: !!runId, staleTime: Infinity });
  const start = () => api.jobs.start({ triggerId: widget.triggerId, timezone: localTimezone() });
  const config = trigger.data?.config;
  const placement = runId ? (jobDef.data ? (jobDef.data.trigger.field.type === "chat" ? "chat" : "button") : jobDef.error ? undefined : null) : undefined;
  const shown = placement === undefined ? (config?.kind === "manual" ? config.placement : null) : placement;

  return (
    <section aria-label={widget.title} className="flex h-full flex-col overflow-hidden rounded-2xl bg-surface shadow-card">
      <WidgetHeader widget={widget} editing={editing} />
      {trigger.error ? (
        <p role="alert" className="px-5 pb-5 text-[14px] text-muted">
          {(trigger.error as { code?: string }).code === "NOT_FOUND" ? "This trigger is no longer available." : "Could not load this trigger."}
        </p>
      ) : jobs.error && !jobs.data ? (
        <p role="alert" className="px-5 pb-5 text-[14px] text-muted">
          Could not load this trigger's Jobs.
        </p>
      ) : !trigger.data || !jobs.data || !shown ? (
        <p className="px-5 pb-5 text-[14px] text-faint">Loading…</p>
      ) : !trigger.data.enabled ? (
        <p className="px-5 pb-5 text-[14px] text-muted">This trigger is disabled.</p>
      ) : shown === "chat" ? (
        <ChatPanel start={start} runId={runId} onRunStarted={setChosen} onNewConversation={() => setChosen(null)} />
      ) : (
        <StartButton label={trigger.data.name} runId={runId} start={start} onRunStarted={setChosen} />
      )}
    </section>
  );
}
