import type { OutputField } from "@dispand/runner-protocol";
import type { ConditionOp } from "@dispand/domain/workflows/condition";
import { nodesOf, type ConditionStep, type Ref, type WorkflowDef } from "@dispand/domain/workflows/model";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { FormField } from "../../settings/parts.tsx";
import { selectClass } from "../../data/NewFieldPopover.tsx";
import { SourcePicker } from "../SourcePicker.tsx";

/** Every operator, in menu order (their words are `workflows:condition.op.*`). */
const OPS: ConditionOp[] = ["equals", "not_equals", "contains", "not_contains", "is_empty", "is_not_empty", "greater_than", "less_than"];

/** Operators that ignore the operand. */
const UNARY: ConditionOp[] = ["is_empty", "is_not_empty"];

/** "brief.approved is yes", for the condition's card. */
export function describeCondition(t: TFunction<"workflows">, def: WorkflowDef, step: ConditionStep): string {
  const source = step.value && nodesOf(def).find((n) => n.id === step.value!.nodeId);
  if (!step.value || !source) return t("condition.choose");
  const values = { subject: `${source.key}.${step.value.name}`, op: t(`condition.op.${step.op}`), operand: step.operand };
  return t(UNARY.includes(step.op) ? "condition.card" : "condition.cardOperand", values);
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
  const { t } = useTranslation("workflows");
  function set(patch: Partial<ConditionStep>) {
    onChange({ ...def, steps: def.steps.map((s) => (s.id === step.id ? { ...step, ...patch } : s)) });
  }

  return (
    <>
      <div className="space-y-3">
        <p className="text-[13px] font-medium text-muted">{t("condition.if")}</p>
        <SourcePicker
          def={def}
          stepId={step.id}
          expected={expected}
          source={step.value}
          // Without `allowValue` the picker only gives values of upstream steps.
          onChange={(value) => set({ value: value as Ref | null })}
        />
        <FormField label={t("condition.operator")} htmlFor="condition-op">
          <select id="condition-op" value={step.op} onChange={(e) => set({ op: e.target.value as ConditionOp })} className={selectClass}>
            {OPS.map((op) => (
              <option key={op} value={op}>
                {t(`condition.op.${op}`)}
              </option>
            ))}
          </select>
        </FormField>
        {!UNARY.includes(step.op) && (
          <FormField
            label={t("condition.compare")}
            htmlFor="condition-operand"
            hint={t(step.op === "greater_than" || step.op === "less_than" ? "condition.number" : "condition.text")}
          >
            <Input id="condition-operand" value={step.operand} maxLength={1000} onChange={(e) => set({ operand: e.target.value })} />
          </FormField>
        )}
      </div>
      <p className="text-[13px] text-faint">
        <Trans t={t} i18nKey="condition.footer" values={{ ref: `{{${step.key}.matched}}` }} components={[<code key="ref" className="font-mono" />]} />
      </p>
    </>
  );
}
