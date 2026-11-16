import type { OutputField } from "@dispand/runner-protocol";
import type { WorkflowIssue } from "@dispand/domain/workflows/derive";
import { nodesOf, removeStep, renameNode, type WorkflowDef } from "@dispand/domain/workflows/model";
import { scheduleTrigger } from "@dispand/domain/workflows/schedule";
import { Link } from "@tanstack/react-router";
import { CircleAlert, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useText } from "@/lib/message";
import { cn } from "@/lib/utils";
import { FormField } from "../settings/parts.tsx";
import { AgentPanel } from "./panels/AgentPanel.tsx";
import type { TableSchema } from "@dispand/domain/workflows/data-steps";
import { ConditionPanel } from "./panels/ConditionPanel.tsx";
import { ScheduleTriggerPanel, type ScheduleFire } from "./panels/ScheduleTriggerPanel.tsx";
import { DataPanel } from "./panels/DataPanel.tsx";
import { LoopPanel } from "./panels/LoopPanel.tsx";

type Agent = { id: string; name: string; builtIn?: string | null; plugin?: { name: string } | null };
const TRIGGER_KINDS = ["button", "chat", "schedule"] as const;

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
  const { t } = useTranslation("workflows");
  const text = useText();
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
    <section aria-label={t("step.settings", { name: node.name || t("untitled") })} className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-medium uppercase tracking-wide text-faint">{t(`step.${isTrigger ? "trigger" : step?.type === "condition" || step?.type === "loop" || step?.type === "data" ? step.type : "agent"}`)}</p>
          <p className="text-[17px] font-semibold tracking-tight">{node.name || t("untitled")}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={t("step.close")} onClick={onClose}>
          <X />
        </Button>
      </div>

      {mine.length > 0 && (
        <ul className="space-y-1.5 rounded-xl bg-danger/8 px-3 py-2.5" aria-label={t("step.issues")}>
          {mine.map((i) => (
            <li key={text(i.message)} className="flex gap-2 text-[13px] text-danger">
              <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
              {text(i.message)}
            </li>
          ))}
        </ul>
      )}

      {isTrigger && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">{t("step.type")}</p>
          <div role="radiogroup" aria-label={t("step.triggerType")} className="grid grid-cols-3 gap-1 rounded-xl bg-active p-1">
            {TRIGGER_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={trigger.type === kind}
                onClick={() => setTriggerType(kind)}
                className={cn(
                  "rounded-lg py-1.5 text-[13px] font-medium transition",
                  trigger.type === kind ? "bg-surface shadow-card" : "text-muted hover:text-fg",
                )}
              >
                {t(`step.triggerKind.${kind}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      <FormField label={t("step.name")} htmlFor="node-name" hint={t("step.nameHint", { ref: `{{${node.key}.…}}` })}>
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
          <Trash2 /> {t("step.delete")}
        </Button>
      )}
    </section>
  );
}
