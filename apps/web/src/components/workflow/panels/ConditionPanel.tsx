import type { OutputField } from "@dispand/runner-protocol";
import type { ConditionOp } from "@dispand/domain/workflows/condition";
import { nodesOf, type ConditionStep, type Ref, type WorkflowDef } from "@dispand/domain/workflows/model";
import { Input } from "@/components/ui/input";
import { FormField } from "../../settings/parts.tsx";
import { selectClass } from "../../data/NewFieldPopover.tsx";
import { SourcePicker } from "../SourcePicker.tsx";

/** Each operator as the owner reads it, in menu order. */
export const OP_LABELS: Record<ConditionOp, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  is_empty: "is empty",
  is_not_empty: "isn't empty",
  greater_than: "is greater than",
  less_than: "is less than",
};

/** Operators that ignore the operand. */
const UNARY: ConditionOp[] = ["is_empty", "is_not_empty"];

/** "brief.approved is yes", for the condition's card. */
export function describeCondition(def: WorkflowDef, step: ConditionStep): string {
  const source = step.value && nodesOf(def).find((n) => n.id === step.value!.nodeId);
  if (!step.value || !source) return "Choose a value";
  const subject = `${source.key}.${step.value.name} ${OP_LABELS[step.op]}`;
  return UNARY.includes(step.op) ? subject : `${subject} ${step.operand}`;
}

/** A condition's body: the upstream value it compares, the operator and what it compares with. */
export function ConditionPanel({
  def,
  step,
  expected,
  onChange,
}: {
  def: WorkflowDef;
  step: ConditionStep;
  expected: Record<string, OutputField[]>;
  onChange: (def: WorkflowDef) => void;
}) {
  function set(patch: Partial<ConditionStep>) {
    onChange({ ...def, steps: def.steps.map((s) => (s.id === step.id ? { ...step, ...patch } : s)) });
  }

  return (
    <>
      <div className="space-y-3">
        <p className="text-[13px] font-medium text-muted">If</p>
        <SourcePicker
          def={def}
          stepId={step.id}
          expected={expected}
          source={step.value}
          // Without `allowValue` the picker only gives values of upstream steps.
          onChange={(value) => set({ value: value as Ref | null })}
        />
        <FormField label="Operator" htmlFor="condition-op">
          <select id="condition-op" value={step.op} onChange={(e) => set({ op: e.target.value as ConditionOp })} className={selectClass}>
            {Object.entries(OP_LABELS).map(([op, label]) => (
              <option key={op} value={op}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
        {!UNARY.includes(step.op) && (
          <FormField
            label="Compare with"
            htmlFor="condition-operand"
            hint={step.op === "greater_than" || step.op === "less_than" ? "A number." : "Text, case doesn't matter."}
          >
            <Input id="condition-operand" value={step.operand} maxLength={1000} onChange={(e) => set({ operand: e.target.value })} />
          </FormField>
        )}
      </div>
      <p className="text-[13px] text-faint">
        Steps on its Then branch run when it holds, steps on Else when it doesn't. Later steps can use{" "}
        <code className="font-mono">{`{{${step.key}.matched}}`}</code> (“true” or “false”).
      </p>
    </>
  );
}
