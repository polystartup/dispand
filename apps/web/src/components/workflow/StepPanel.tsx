import type { OutputField } from "@dispand/runner-protocol";
import type { WorkflowIssue } from "@dispand/domain/workflows/derive";
import { nodesOf, removeStep, renameNode, type WorkflowDef } from "@dispand/domain/workflows/model";
import { scheduleTrigger } from "@dispand/domain/workflows/schedule";
import { Link } from "@tanstack/react-router";
import { CircleAlert, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FormField } from "../settings/parts.tsx";
import { AgentPanel } from "./panels/AgentPanel.tsx";
import type { TableSchema } from "@dispand/domain/workflows/data-steps";
import { ConditionPanel } from "./panels/ConditionPanel.tsx";
import { ScheduleTriggerPanel, type ScheduleFire } from "./panels/ScheduleTriggerPanel.tsx";
import { DataPanel } from "./panels/DataPanel.tsx";
import { LoopPanel } from "./panels/LoopPanel.tsx";

type Agent = { id: string; name: string };

/** The configuration of one node: its name, then its type's body (agent and prompt, a condition, a loop or a data step). */
export function StepPanel({
  def,
  nodeId,
  agents,
  expected,
  issues,
  schedule = null,
  fires = [],
  onPause = () => {},
  tables,
  tableList,
  onChange,
  onClose,
}: {
  def: WorkflowDef;
  nodeId: string;
  agents: Agent[];
  expected: Record<string, OutputField[]>;
  issues: WorkflowIssue[];
  /** The saved schedule and its latest fires, for a schedule trigger. */
  schedule?: { enabled: boolean; nextFireAt: Date } | null;
  fires?: ScheduleFire[];
  onPause?: (enabled: boolean) => void;
  tables: TableSchema[];
  tableList: { id: string; name: string }[];
  onChange: (def: WorkflowDef) => void;
  onClose: () => void;
}) {
  const node = nodesOf(def).find((n) => n.id === nodeId);
  if (!node) return null;
  const trigger = def.trigger.field;
  const isTrigger = node.kind === "trigger";
  const step = def.steps.find((s) => s.id === nodeId);
  const hasAgent = isTrigger ? trigger.type === "chat" : step?.type === "agent";
  const mine = issues.filter((i) => i.nodeId === nodeId);

  function setTriggerType(type: "button" | "chat" | "schedule") {
    if (type === trigger.type) return;
    const { id, key, label } = trigger;
    if (type === "schedule") {
      const { cron, timezone } = scheduleTrigger(id).field;
      onChange({ ...def, trigger: { type: "schedule", field: { id, key, label, type, cron, timezone } } });
      return;
    }
    const field = type === "chat" ? { id, key, label, type, agentId: "", prompt: "" } : { id, key, label, type };
    onChange({ ...def, trigger: { type: "manual", field } });
  }

  return (
    <section aria-label={`${node.name || "Untitled"} settings`} className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-medium uppercase tracking-wide text-faint">{isTrigger ? "Trigger" : step?.type === "condition" ? "Condition" : step?.type === "loop" ? "Loop" : step?.type === "data" ? "Data step" : "Agent step"}</p>
          <p className="text-[17px] font-semibold tracking-tight">{node.name || "Untitled"}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>

      {mine.length > 0 && (
        <ul className="space-y-1.5 rounded-xl bg-danger/8 px-3 py-2.5" aria-label="Issues">
          {mine.map((i) => (
            <li key={i.message} className="flex gap-2 text-[13px] text-danger">
              <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
              {i.message}
            </li>
          ))}
        </ul>
      )}

      {isTrigger && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">Type</p>
          <div role="radiogroup" aria-label="Trigger type" className="grid grid-cols-3 gap-1 rounded-xl bg-active p-1">
            {(["button", "chat", "schedule"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={trigger.type === t}
                onClick={() => setTriggerType(t)}
                className={cn(
                  "rounded-lg py-1.5 text-[13px] font-medium transition",
                  trigger.type === t ? "bg-surface shadow-card" : "text-muted hover:text-fg",
                )}
              >
                {{ button: "Button", chat: "Chat", schedule: "Schedule" }[t]}
              </button>
            ))}
          </div>
        </div>
      )}

      <FormField label="Name" htmlFor="node-name" hint={`Referenced as {{${node.key}.…}}`}>
        <Input id="node-name" value={node.name} maxLength={100} onChange={(e) => onChange(renameNode(def, nodeId, e.target.value))} />
      </FormField>

      {isTrigger && trigger.type === "schedule" ? (
        <ScheduleTriggerPanel
          field={trigger}
          schedule={schedule}
          fires={fires}
          onChange={(field) => onChange({ ...def, trigger: { type: "schedule", field } })}
          onPause={onPause}
          runLink={(runId, children) => (
            <Link to="/settings/workflows/runs/$runId" params={{ runId }} className="text-accent hover:underline">
              {children}
            </Link>
          )}
        />
      ) : step?.type === "condition" ? (
        <ConditionPanel def={def} step={step} expected={expected} onChange={onChange} />
      ) : step?.type === "loop" ? (
        <LoopPanel def={def} step={step} expected={expected} onChange={onChange} />
      ) : step?.type === "data" ? (
        <DataPanel def={def} step={step} tables={tables} tableList={tableList} expected={expected} onChange={onChange} />
      ) : (
        hasAgent && <AgentPanel def={def} node={node} agents={agents} expected={expected} onChange={onChange} />
      )}

      {!isTrigger && (
        <Button
          variant="ghost"
          className="text-danger hover:text-danger"
          onClick={() => {
            onChange(removeStep(def, nodeId));
            onClose();
          }}
        >
          <Trash2 /> Delete step
        </Button>
      )}
    </section>
  );
}
